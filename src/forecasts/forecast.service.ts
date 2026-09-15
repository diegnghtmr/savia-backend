import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  JobWriter,
  JobRecord as Job,
} from '../platform/job-writer.port.js';
import { JOB_WRITER_TYPES } from '../platform/job-writer.port.js';
import {
  FORECAST_JOB_PAYLOAD_VERSION,
  freezeForecastJobPayload,
} from './forecast-job-payload.js';
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

const FORECAST_WRITE_ROLES = {
  OWNER: 'owner',
  ADMINISTRATOR: 'administrator',
  EDITOR: 'editor',
} as const;

const WRITE_ROLE_VALUES: readonly string[] =
  Object.values(FORECAST_WRITE_ROLES);

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
        if (!WRITE_ROLE_VALUES.includes(role ?? '')) {
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
        let effectiveAccountIds: readonly string[];
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
          effectiveAccountIds = command.accountIds.filter(
            (id) => foundMap.get(id) !== 'closed',
          );
        } else {
          effectiveAccountIds = await this.store.readOpenAccountIds(
            client,
            workspaceId,
          );
        }

        const now = this.clock();
        const jobRecord = await this.jobs.createQueuedJob(
          client,
          workspaceId,
          subject,
          JOB_WRITER_TYPES.BALANCE_FORECAST,
          freezeForecastJobPayload({
            version: FORECAST_JOB_PAYLOAD_VERSION,
            asOf: now.toISOString(),
            horizonDays: command.horizonDays,
            includeScenarios: command.includeScenarios,
            effectiveAccountIds,
            closedAccountAssumptions,
            baseCurrency,
          }),
        );
        const job = jobRecord as unknown as Job;

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
