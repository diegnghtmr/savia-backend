import { randomUUID } from 'node:crypto';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type { JobWriter, TerminalJob as Job } from '../platform/job-writer.port.js';
import { multiplyMinorByRate } from '../platform/currency-conversion.js';
import {
  buildMonthlySavingsCapacity,
  truncateToBucketStart,
  GRANULARITY,
  type ConvertedFlowRow,
} from '../platform/monthly-capacity.js';
import {
  computeForecast,
  type AppliedScenarioRunData,
} from './forecast-engine.js';
import {
  FORECAST_OUTCOMES,
  type ForecastCreateOutcome,
  type ForecastGetOutcome,
  type ForecastRequest,
  type ForecastStore,
  type ForecastsPort,
} from './forecast.port.js';

export interface ForecastTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export class ForecastCreateRollbackError extends Error {
  public constructor(
    public readonly outcome: 'replayed' | 'conflict',
    public readonly status?: number,
    public readonly etag?: string | null,
    public readonly body?: unknown,
  ) {
    super('Forecast create transaction must be rolled back.');
    this.name = 'ForecastCreateRollbackError';
  }
}

export class ForecastService implements ForecastsPort {
  public constructor(
    private readonly tx: ForecastTransaction,
    private readonly store: ForecastStore,
    private readonly idempotency: IdempotencyStore,
    private readonly jobs: JobWriter,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async createBalanceForecast(
    subject: string,
    workspaceId: string,
    command: ForecastRequest,
    key: string,
  ): Promise<ForecastCreateOutcome> {
    const route = 'POST /v1/forecasts/balance';
    const fingerprint = computeRequestFingerprint(command);

    try {
      return await this.tx.run(subject, async (client) => {
        const role = await this.store.readActiveRole(client, workspaceId);
        if (!['owner', 'administrator', 'editor'].includes(role ?? '')) {
          return { kind: FORECAST_OUTCOMES.FORBIDDEN };
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
                kind: FORECAST_OUTCOMES.REPLAYED,
                status: existing.responseStatus,
                etag: existing.responseEtag,
                body: existing.responseBody,
              }
            : { kind: FORECAST_OUTCOMES.CONFLICT };
        }

        const baseCurrency = await this.store.readWorkspaceBaseCurrency(
          client,
          workspaceId,
        );
        if (!baseCurrency) {
          return { kind: FORECAST_OUTCOMES.FORBIDDEN };
        }

        const closedAccountAssumptions: string[] = [];
        if (command.accountIds !== undefined) {
          const accounts = await this.store.checkAccountsExist(
            client,
            workspaceId,
            command.accountIds,
          );
          const foundMap = new Map(accounts.map((a) => [a.id, a.status]));
          const missingIds = command.accountIds.filter(
            (id) => !foundMap.has(id),
          );
          if (missingIds.length > 0) {
            return {
              kind: FORECAST_OUTCOMES.UNPROCESSABLE,
              violations: [
                {
                  field: 'accountIds',
                  message: `Unknown account id(s): ${missingIds.join(', ')}`,
                },
              ],
            };
          }
          for (const id of command.accountIds) {
            if (foundMap.get(id) === 'closed') {
              closedAccountAssumptions.push(
                `Account ${id} is closed and contributes zero.`,
              );
            }
          }
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
          command.accountIds,
        );

        const rates = new Map<string, string>();
        const neededCurrencies = new Set<string>();

        for (const acct of accountBalances) {
          if (acct.currency !== baseCurrency) {
            neededCurrencies.add(acct.currency);
          }
        }
        for (const row of flowRows) {
          if (row.currency !== baseCurrency) {
            neededCurrencies.add(row.currency);
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
              kind: FORECAST_OUTCOMES.MISSING_RATE,
              fromCurrency: curr,
              toCurrency: baseCurrency,
            };
          }
          rates.set(`${curr}:${baseCurrency}`, rate);
        }

        let openingBalanceMinor = 0n;
        for (const acct of accountBalances) {
          if (acct.currency === baseCurrency) {
            openingBalanceMinor += BigInt(acct.nativeBalanceMinor);
          } else {
            const rate = rates.get(`${acct.currency}:${baseCurrency}`)!;
            openingBalanceMinor += BigInt(
              multiplyMinorByRate(acct.nativeBalanceMinor, rate),
            );
          }
        }

        const convertedFlowRows: ConvertedFlowRow[] = [];
        for (const row of flowRows) {
          let amountMinor: bigint;
          if (row.currency === baseCurrency) {
            amountMinor = BigInt(row.amountMinor);
          } else {
            const rate = rates.get(`${row.currency}:${baseCurrency}`)!;
            amountMinor = BigInt(multiplyMinorByRate(row.amountMinor, rate));
          }
          convertedFlowRows.push({
            type: row.type,
            amountMinor,
            occurredAt: new Date(row.occurredAt),
          });
        }

        const monthsWithRows = new Set<string>();
        for (const row of convertedFlowRows) {
          monthsWithRows.add(
            truncateToBucketStart(row.occurredAt, GRANULARITY.MONTH),
          );
        }
        const monthsOfHistoryAvailable = monthsWithRows.size;

        const buckets = buildMonthlySavingsCapacity(
          periodStart,
          periodEnd,
          convertedFlowRows,
        );

        let monthlySavingsCapacities: bigint[] = [];
        if (monthsOfHistoryAvailable > 0) {
          const firstIdx = buckets.findIndex((b) =>
            monthsWithRows.has(b.month),
          );
          if (firstIdx !== -1) {
            monthlySavingsCapacities = buckets
              .slice(firstIdx)
              .map((b) => b.savingsCapacityMinor);
          }
        }

        let appliedScenarioRun: AppliedScenarioRunData | null = null;
        if (command.includeScenarios) {
          const scenarioRun =
            await this.store.findMostRecentCompletedScenarioRun(
              client,
              workspaceId,
            );
          if (scenarioRun) {
            appliedScenarioRun = {
              id: scenarioRun.id,
              monthlySavingsCapacityMinor:
                scenarioRun.monthlySavingsCapacityMinor,
            };
          }
        }

        const engineResult = computeForecast({
          openingBalanceMinor,
          baseCurrency,
          horizonDays: command.horizonDays,
          today: now,
          monthlySavingsCapacities,
          monthsOfHistoryAvailable,
          includeScenarios: command.includeScenarios,
          appliedScenarioRun,
        });

        const assumptions = [
          ...closedAccountAssumptions,
          ...engineResult.assumptions,
        ];

        const forecastId = randomUUID();

        const jobRecord = await this.jobs.createTerminalJob(
          client,
          workspaceId,
          subject,
          'balance_forecast',
          'completed',
          forecastId,
          null,
        );
        const job = jobRecord as unknown as Job;

        await this.store.createForecast(client, workspaceId, subject, {
          id: forecastId,
          jobId: job.id,
          status: 'completed',
          confidence: engineResult.confidence,
          method: engineResult.method,
          horizonDays: command.horizonDays,
          assumptions,
          series: engineResult.series,
          generatedAt: now,
        });

        const written = await this.idempotency.write(
          client,
          subject,
          route,
          key,
          fingerprint,
          202,
          null,
          job,
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
              throw new ForecastCreateRollbackError(
                'replayed',
                reread.responseStatus,
                reread.responseEtag,
                reread.responseBody,
              );
            }
            throw new ForecastCreateRollbackError('conflict');
          }
          throw new Error('Forecast idempotency record could not be reread.');
        }

        return { kind: FORECAST_OUTCOMES.ACCEPTED, job };
      });
    } catch (error) {
      if (error instanceof ForecastCreateRollbackError) {
        if (error.outcome === 'replayed') {
          return {
            kind: FORECAST_OUTCOMES.REPLAYED,
            status: error.status ?? 202,
            etag: error.etag ?? null,
            body: error.body,
          };
        }
        return { kind: FORECAST_OUTCOMES.CONFLICT };
      }
      throw error;
    }
  }

  public async getForecast(
    subject: string,
    workspaceId: string,
    forecastId: string,
  ): Promise<ForecastGetOutcome> {
    return this.tx.runRead(subject, async (client) => {
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        !['owner', 'administrator', 'editor', 'viewer'].includes(role ?? '')
      ) {
        return { kind: FORECAST_OUTCOMES.FORBIDDEN };
      }

      const forecast = await this.store.findForecastById(
        client,
        workspaceId,
        forecastId,
      );
      if (!forecast) {
        return { kind: FORECAST_OUTCOMES.NOT_FOUND };
      }

      return {
        kind: FORECAST_OUTCOMES.OK,
        forecast,
      };
    });
  }
}
