import { encodeCursor } from '../platform/cursor.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import { evaluateScenario } from './scenario-engine.js';
import {
  SCENARIO_OUTCOMES,
  type CreateScenarioRequest,
  type ScenarioCreateOutcome,
  type ScenarioListOutcome,
  type ScenarioListQuery,
  type ScenarioRunOutcome,
  type ScenarioStore,
  type ScenariosPort,
} from './scenario.port.js';

export interface ScenarioTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export class ScenarioCreateRollbackError extends Error {
  public constructor(
    public readonly outcome: 'replayed' | 'conflict',
    public readonly status?: number,
    public readonly etag?: string | null,
    public readonly body?: unknown,
  ) {
    super('Scenario create transaction must be rolled back.');
    this.name = 'ScenarioCreateRollbackError';
  }
}

export class ScenarioRunRollbackError extends Error {
  public constructor(
    public readonly outcome: 'replayed' | 'conflict',
    public readonly status?: number,
    public readonly etag?: string | null,
    public readonly body?: unknown,
  ) {
    super('Scenario run transaction must be rolled back.');
    this.name = 'ScenarioRunRollbackError';
  }
}

export class ScenarioService implements ScenariosPort {
  public constructor(
    private readonly tx: ScenarioTransaction,
    private readonly store: ScenarioStore,
    private readonly idempotency: IdempotencyStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async createScenario(
    subject: string,
    workspaceId: string,
    command: CreateScenarioRequest,
    key: string,
  ): Promise<ScenarioCreateOutcome> {
    const route = 'POST /v1/scenarios';
    const fingerprint = computeRequestFingerprint(command);

    try {
      return await this.tx.run(subject, async (client) => {
        const role = await this.store.readActiveRole(client, workspaceId);
        if (!['owner', 'administrator', 'editor'].includes(role ?? '')) {
          return { kind: SCENARIO_OUTCOMES.FORBIDDEN };
        }

        const existing = await this.idempotency.read(
          client,
          subject,
          route,
          key,
          workspaceId,
        );
        if (existing) {
          return existing.requestFingerprint === fingerprint
            ? {
                kind: SCENARIO_OUTCOMES.REPLAYED,
                status: existing.responseStatus,
                etag: existing.responseEtag,
                body: existing.responseBody,
              }
            : { kind: SCENARIO_OUTCOMES.CONFLICT };
        }

        const scenario = await this.store.createScenario(
          client,
          workspaceId,
          subject,
          command,
        );

        const written = await this.idempotency.write(
          client,
          subject,
          route,
          key,
          fingerprint,
          201,
          null,
          scenario,
          workspaceId,
        );

        if (!written) {
          const reread = await this.idempotency.read(
            client,
            subject,
            route,
            key,
            workspaceId,
          );
          if (reread) {
            if (reread.requestFingerprint === fingerprint) {
              throw new ScenarioCreateRollbackError(
                'replayed',
                reread.responseStatus,
                reread.responseEtag,
                reread.responseBody,
              );
            }
            throw new ScenarioCreateRollbackError('conflict');
          }
          throw new Error('Scenario idempotency record could not be reread.');
        }

        return { kind: SCENARIO_OUTCOMES.CREATED, scenario };
      });
    } catch (error) {
      if (error instanceof ScenarioCreateRollbackError) {
        if (error.outcome === 'replayed') {
          return {
            kind: SCENARIO_OUTCOMES.REPLAYED,
            status: error.status ?? 201,
            etag: error.etag ?? null,
            body: error.body,
          };
        }
        return { kind: SCENARIO_OUTCOMES.CONFLICT };
      }
      throw error;
    }
  }

  public async listScenarios(
    subject: string,
    query: ScenarioListQuery,
  ): Promise<ScenarioListOutcome> {
    return this.tx.runRead(subject, async (client) => {
      const role = await this.store.readActiveRole(client, query.workspaceId);
      if (
        !['owner', 'administrator', 'editor', 'viewer'].includes(role ?? '')
      ) {
        return { kind: SCENARIO_OUTCOMES.FORBIDDEN };
      }

      const rows = await this.store.listScenarios(
        client,
        query,
        query.limit + 1,
      );
      const hasNextPage = rows.length > query.limit;
      const visible = hasNextPage ? rows.slice(0, query.limit) : rows;
      const last = visible[visible.length - 1];

      return {
        kind: 'ok',
        page: {
          items: visible.map((r) => r.scenario),
          pageInfo: {
            hasNextPage,
            nextCursor:
              hasNextPage && last
                ? encodeCursor({
                    workspaceId: query.workspaceId,
                    createdAt: last.cursorAt,
                    id: last.scenario.id,
                  })
                : null,
          },
        },
      };
    });
  }

  public async runScenario(
    subject: string,
    workspaceId: string,
    scenarioId: string,
    key: string,
  ): Promise<ScenarioRunOutcome> {
    const route = 'POST /v1/scenarios/{scenarioId}/runs';
    const fingerprint = computeRequestFingerprint({ scenarioId });

    try {
      return await this.tx.run(subject, async (client) => {
        const role = await this.store.readActiveRole(client, workspaceId);
        if (!['owner', 'administrator', 'editor'].includes(role ?? '')) {
          return { kind: SCENARIO_OUTCOMES.FORBIDDEN };
        }

        const existing = await this.idempotency.read(
          client,
          subject,
          route,
          key,
          workspaceId,
        );
        if (existing) {
          return existing.requestFingerprint === fingerprint
            ? {
                kind: SCENARIO_OUTCOMES.REPLAYED,
                status: existing.responseStatus,
                etag: existing.responseEtag,
                body: existing.responseBody,
              }
            : { kind: SCENARIO_OUTCOMES.CONFLICT };
        }

        const scenario = await this.store.findScenario(
          client,
          workspaceId,
          scenarioId,
        );
        if (!scenario) {
          return { kind: SCENARIO_OUTCOMES.NOT_FOUND };
        }

        const baseCurrency = await this.store.readWorkspaceBaseCurrency(
          client,
          workspaceId,
        );
        if (!baseCurrency) {
          return { kind: SCENARIO_OUTCOMES.FORBIDDEN };
        }

        const now = this.clock();
        const periodEnd = now.toISOString().slice(0, 10);
        const nowYear = now.getUTCFullYear();
        const nowMonth = now.getUTCMonth();
        const startMonthDate = new Date(Date.UTC(nowYear, nowMonth - 11, 1));
        const periodStart = startMonthDate.toISOString().slice(0, 10);

        const flowRows = await this.store.readTransactionsInPeriod(
          client,
          workspaceId,
          periodStart,
          periodEnd,
        );
        const accountBalances = await this.store.readAccountNativeBalances(
          client,
          workspaceId,
        );
        const debtBalances = await this.store.readDebtOutstandingBalances(
          client,
          workspaceId,
        );

        const rates = new Map<string, string>();
        const neededCurrencies = new Set<string>();

        for (const row of flowRows) {
          if (row.currency !== baseCurrency) {
            neededCurrencies.add(row.currency);
          }
        }
        for (const acct of accountBalances) {
          if (acct.currency !== baseCurrency) {
            neededCurrencies.add(acct.currency);
          }
        }
        for (const debt of debtBalances) {
          if (debt.currency !== baseCurrency) {
            neededCurrencies.add(debt.currency);
          }
        }

        for (const curr of neededCurrencies) {
          const rate = await this.store.findExchangeRate(
            client,
            workspaceId,
            curr,
            baseCurrency,
            now,
          );
          if (!rate) {
            return {
              kind: SCENARIO_OUTCOMES.MISSING_RATE,
              fromCurrency: curr,
              toCurrency: baseCurrency,
            };
          }
          rates.set(`${curr}:${baseCurrency}`, rate);
        }

        const engineOutcome = evaluateScenario({
          periodStart,
          periodEnd,
          baseCurrency,
          flowRows,
          accountBalances,
          debtBalances,
          rates,
          assumptions: scenario.assumptions,
        });

        if (engineOutcome.kind === 'missing_rate') {
          return {
            kind: SCENARIO_OUTCOMES.MISSING_RATE,
            fromCurrency: engineOutcome.fromCurrency,
            toCurrency: engineOutcome.toCurrency,
          };
        }

        const runRecord = await this.store.createScenarioRun(
          client,
          workspaceId,
          scenarioId,
          subject,
          engineOutcome.run,
        );

        await this.store.updateScenarioLastRunId(
          client,
          workspaceId,
          scenarioId,
          runRecord.id,
        );

        const written = await this.idempotency.write(
          client,
          subject,
          route,
          key,
          fingerprint,
          200,
          null,
          runRecord,
          workspaceId,
        );

        if (!written) {
          const reread = await this.idempotency.read(
            client,
            subject,
            route,
            key,
            workspaceId,
          );
          if (reread) {
            if (reread.requestFingerprint === fingerprint) {
              throw new ScenarioRunRollbackError(
                'replayed',
                reread.responseStatus,
                reread.responseEtag,
                reread.responseBody,
              );
            }
            throw new ScenarioRunRollbackError('conflict');
          }
          throw new Error(
            'Scenario run idempotency record could not be reread.',
          );
        }

        return { kind: SCENARIO_OUTCOMES.OK, run: runRecord };
      });
    } catch (error) {
      if (error instanceof ScenarioRunRollbackError) {
        if (error.outcome === 'replayed') {
          return {
            kind: SCENARIO_OUTCOMES.REPLAYED,
            status: error.status ?? 200,
            etag: error.etag ?? null,
            body: error.body,
          };
        }
        return { kind: SCENARIO_OUTCOMES.CONFLICT };
      }
      throw error;
    }
  }
}
