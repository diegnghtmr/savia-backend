import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/jobs/job.port.js';
import type {
  IdempotencyRecord,
  IdempotencyStore,
} from '../../src/platform/idempotency.port.js';
import type { JobWriter } from '../../src/platform/job-writer.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import { computeRequestFingerprint } from '../../src/platform/idempotency.service.js';
import {
  FORECAST_OUTCOMES,
  type AccountExistenceRow,
  type AccountNativeBalanceRow,
  type CreateForecastRecord,
  type Forecast,
  type ForecastRequest,
  type ForecastStore,
  type ScenarioRunRowData,
  type TransactionFlowRow,
} from '../../src/forecasts/forecast.port.js';
import {
  ForecastService,
  type ForecastTransaction,
} from '../../src/forecasts/forecast.service.js';

interface FakeStoreOptions {
  role?: string;
  baseCurrency?: string;
  forecast?: Forecast;
  openAccountIds?: readonly string[];
  accounts?: readonly AccountExistenceRow[];
  nativeBalances?: readonly AccountNativeBalanceRow[];
  transactions?: readonly TransactionFlowRow[];
  rates?: Record<string, string>;
  scenarioRun?: ScenarioRunRowData;
}

class FakeForecastStore implements ForecastStore {
  public createdForecasts: CreateForecastRecord[] = [];
  public checkedAccountIds: readonly string[] = [];
  public readNativeBalanceAccountIds?: readonly string[];
  public readTransactionsInPeriodAccountIds?: readonly string[];
  public readOpenAccountIdsCalled = false;

  public constructor(private readonly options: FakeStoreOptions = {}) {}

  public async readActiveRole(): Promise<string | undefined> {
    return 'role' in this.options ? this.options.role : 'owner';
  }

  public async readWorkspaceBaseCurrency(): Promise<string | undefined> {
    return 'baseCurrency' in this.options ? this.options.baseCurrency : 'USD';
  }

  public async findForecastById(): Promise<Forecast | undefined> {
    return this.options.forecast;
  }

  public async checkAccountsExist(
    _client: TransactionClient,
    _workspaceId: string,
    accountIds: readonly string[],
  ): Promise<readonly AccountExistenceRow[]> {
    this.checkedAccountIds = accountIds;
    return (
      this.options.accounts ?? accountIds.map((id) => ({ id, status: 'open' }))
    );
  }

  public async readOpenAccountIds(): Promise<readonly string[]> {
    this.readOpenAccountIdsCalled = true;
    return (
      this.options.openAccountIds ??
      this.options.nativeBalances?.map((b) => b.id) ?? ['acct-1']
    );
  }

  public async readAccountNativeBalances(
    _client: TransactionClient,
    _workspaceId: string,
    accountIds: readonly string[],
  ): Promise<readonly AccountNativeBalanceRow[]> {
    this.readNativeBalanceAccountIds = accountIds;
    return this.options.nativeBalances ?? [];
  }

  public async readTransactionsInPeriod(
    _client: TransactionClient,
    _workspaceId: string,
    _from: string,
    _to: string,
    accountIds: readonly string[],
  ): Promise<readonly TransactionFlowRow[]> {
    this.readTransactionsInPeriodAccountIds = accountIds;
    return this.options.transactions ?? [];
  }

  public async findExchangeRate(
    _client: TransactionClient,
    _workspaceId: string,
    baseCurrency: string,
    quoteCurrency: string,
  ): Promise<string | undefined> {
    return this.options.rates?.[`${baseCurrency}:${quoteCurrency}`];
  }

  public async findMostRecentCompletedScenarioRun(): Promise<
    ScenarioRunRowData | undefined
  > {
    return this.options.scenarioRun;
  }

  public async createForecast(
    _client: TransactionClient,
    _workspaceId: string,
    _subject: string,
    data: CreateForecastRecord,
  ): Promise<void> {
    this.createdForecasts.push(data);
  }
}

class FakeIdempotencyStore implements IdempotencyStore {
  public records = new Map<string, IdempotencyRecord>();
  public writeResult = true;

  public async read(
    _client: TransactionClient,
    _subject: string,
    _route: string,
    key: string,
  ): Promise<IdempotencyRecord | undefined> {
    return this.records.get(key);
  }

  public async write(
    _client: TransactionClient,
    _subject: string,
    _route: string,
    key: string,
    requestFingerprint: string,
    responseStatus: number,
    responseEtag: string | null,
    responseBody: unknown,
  ): Promise<boolean> {
    if (!this.writeResult) {
      return false;
    }
    this.records.set(key, {
      requestFingerprint,
      responseStatus,
      responseEtag,
      responseBody,
    });
    return true;
  }
}

class FakeJobWriter implements JobWriter {
  public createdJobs: unknown[] = [];

  public async createTerminalJob(
    _client: TransactionClient,
    _workspaceId: string,
    _subject: string,
    type: string,
    status: 'completed' | 'failed',
    resultResourceId: string | null,
    error: Record<string, unknown> | null,
  ): Promise<Record<string, unknown>> {
    const job: Job = {
      id: 'job-uuid-1',
      type,
      status,
      progressPercent: 100,
      resultResourceId,
      error,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    this.createdJobs.push(job);
    return job as unknown as Record<string, unknown>;
  }

  public async createQueuedJob(
    _client: TransactionClient,
    _workspaceId: string,
    _subject: string,
    type: string,
  ): Promise<Record<string, unknown>> {
    const job: Job = {
      id: 'job-uuid-queued-1',
      type,
      status: 'queued',
      progressPercent: null,
      resultResourceId: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    };
    this.createdJobs.push(job);
    return job as unknown as Record<string, unknown>;
  }

  public async transitionToProcessing(
    _client: TransactionClient,
    _workspaceId: string,
    jobId: string,
  ): Promise<Record<string, unknown>> {
    const job: Job = {
      id: jobId,
      type: 'balance_forecast',
      status: 'processing',
      progressPercent: null,
      resultResourceId: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    this.createdJobs.push(job);
    return job as unknown as Record<string, unknown>;
  }

  public async completeJob(
    _client: TransactionClient,
    _workspaceId: string,
    jobId: string,
    resultResourceId?: string | null,
  ): Promise<Record<string, unknown>> {
    const job: Job = {
      id: jobId,
      type: 'balance_forecast',
      status: 'completed',
      progressPercent: 100,
      resultResourceId: resultResourceId ?? null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    this.createdJobs.push(job);
    return job as unknown as Record<string, unknown>;
  }

  public async failJob(
    _client: TransactionClient,
    _workspaceId: string,
    jobId: string,
    error: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const job: Job = {
      id: jobId,
      type: 'balance_forecast',
      status: 'failed',
      progressPercent: null,
      resultResourceId: null,
      error,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    this.createdJobs.push(job);
    return job as unknown as Record<string, unknown>;
  }

  public async deadLetter(
    _client: TransactionClient,
    _workspaceId: string,
    jobId: string,
    error: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const job: Job = {
      id: jobId,
      type: 'balance_forecast',
      status: 'dead_letter',
      progressPercent: null,
      resultResourceId: null,
      error,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    this.createdJobs.push(job);
    return job as unknown as Record<string, unknown>;
  }

  public async findJobById(
    _client: TransactionClient,
    _workspaceId: string,
    jobId: string,
  ): Promise<{ readonly status: string } | undefined> {
    const created = this.createdJobs.find(
      (job) =>
        typeof job === 'object' &&
        job !== null &&
        'id' in job &&
        (job as { id: string }).id === jobId,
    );
    if (
      typeof created === 'object' &&
      created !== null &&
      'status' in created &&
      typeof (created as { status: unknown }).status === 'string'
    ) {
      return { status: (created as { status: string }).status };
    }
    return undefined;
  }
}

const mockClient = {} as TransactionClient;
const directTransaction: ForecastTransaction = {
  run: async <T>(
    _subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> => {
    return callback(mockClient);
  },
  runRead: async <T>(
    _subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> => {
    return callback(mockClient);
  },
};

describe('ForecastService', () => {
  const subject = '11111111-0000-4000-8000-000000000001';
  const workspaceId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const fixedNow = new Date('2026-09-04T12:00:00.000Z');

  describe('createBalanceForecast', () => {
    const command: ForecastRequest = {
      horizonDays: 30,
      includeScenarios: false,
    };

    it('returns FORBIDDEN when user role is not owner, administrator, or editor', async () => {
      const store = new FakeForecastStore({ role: 'viewer' });
      const idempotency = new FakeIdempotencyStore();
      const jobs = new FakeJobWriter();
      const service = new ForecastService(
        directTransaction,
        store,
        idempotency,
        jobs,
        () => fixedNow,
      );

      const result = await service.createBalanceForecast(
        subject,
        workspaceId,
        command,
        'key-1',
      );
      expect(result.kind).toBe(FORECAST_OUTCOMES.FORBIDDEN);
    });

    it('returns FORBIDDEN when workspace base currency cannot be resolved', async () => {
      const store = new FakeForecastStore({ baseCurrency: undefined });
      const idempotency = new FakeIdempotencyStore();
      const jobs = new FakeJobWriter();
      const service = new ForecastService(
        directTransaction,
        store,
        idempotency,
        jobs,
        () => fixedNow,
      );

      const result = await service.createBalanceForecast(
        subject,
        workspaceId,
        command,
        'key-1',
      );
      expect(result.kind).toBe(FORECAST_OUTCOMES.FORBIDDEN);
    });

    it('returns REPLAYED when idempotency record exists with identical fingerprint', async () => {
      const store = new FakeForecastStore();
      const idempotency = new FakeIdempotencyStore();
      const jobs = new FakeJobWriter();
      const service = new ForecastService(
        directTransaction,
        store,
        idempotency,
        jobs,
        () => fixedNow,
      );

      const first = await service.createBalanceForecast(
        subject,
        workspaceId,
        command,
        'key-1',
      );
      expect(first.kind).toBe(FORECAST_OUTCOMES.ACCEPTED);

      const replayed = await service.createBalanceForecast(
        subject,
        workspaceId,
        command,
        'key-1',
      );
      expect(replayed.kind).toBe(FORECAST_OUTCOMES.REPLAYED);
      if (replayed.kind === FORECAST_OUTCOMES.REPLAYED) {
        expect(replayed.status).toBe(202);
      }
    });

    it('returns CONFLICT when idempotency record exists with different fingerprint', async () => {
      const store = new FakeForecastStore();
      const idempotency = new FakeIdempotencyStore();
      const jobs = new FakeJobWriter();
      const service = new ForecastService(
        directTransaction,
        store,
        idempotency,
        jobs,
        () => fixedNow,
      );

      await service.createBalanceForecast(
        subject,
        workspaceId,
        command,
        'key-1',
      );

      const conflictCommand: ForecastRequest = {
        horizonDays: 60,
        includeScenarios: true,
      };
      const result = await service.createBalanceForecast(
        subject,
        workspaceId,
        conflictCommand,
        'key-1',
      );
      expect(result.kind).toBe(FORECAST_OUTCOMES.CONFLICT);
    });

    it('returns UNPROCESSABLE 422 when accountIds contains an unknown account ID', async () => {
      const requestedIds = [
        'bbbbbbbb-0000-4000-8000-000000000001',
        'cccccccc-0000-4000-8000-000000000002',
      ];
      // Only first account exists in store
      const store = new FakeForecastStore({
        accounts: [{ id: requestedIds[0], status: 'open' }],
      });
      const idempotency = new FakeIdempotencyStore();
      const jobs = new FakeJobWriter();
      const service = new ForecastService(
        directTransaction,
        store,
        idempotency,
        jobs,
        () => fixedNow,
      );

      const cmd: ForecastRequest = {
        horizonDays: 30,
        accountIds: requestedIds,
        includeScenarios: false,
      };

      const result = await service.createBalanceForecast(
        subject,
        workspaceId,
        cmd,
        'key-1',
      );
      expect(result.kind).toBe(FORECAST_OUTCOMES.UNPROCESSABLE);
      if (result.kind === FORECAST_OUTCOMES.UNPROCESSABLE) {
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0].field).toBe('accountIds');
        expect(result.violations[0].message).toContain(requestedIds[1]);
      }
    });

    it('accepts closed account in accountIds, contributes 0, and records assumption', async () => {
      const openId = '11111111-0000-4000-8000-000000000001';
      const closedId = '22222222-0000-4000-8000-000000000002';
      const store = new FakeForecastStore({
        accounts: [
          { id: openId, status: 'open' },
          { id: closedId, status: 'closed' },
        ],
        nativeBalances: [
          { id: openId, currency: 'USD', nativeBalanceMinor: '50000' },
        ],
      });
      const idempotency = new FakeIdempotencyStore();
      const jobs = new FakeJobWriter();
      const service = new ForecastService(
        directTransaction,
        store,
        idempotency,
        jobs,
        () => fixedNow,
      );

      const cmd: ForecastRequest = {
        horizonDays: 30,
        accountIds: [openId, closedId],
        includeScenarios: false,
      };

      const result = await service.createBalanceForecast(
        subject,
        workspaceId,
        cmd,
        'key-1',
      );
      expect(result.kind).toBe(FORECAST_OUTCOMES.ACCEPTED);
      expect(store.createdForecasts).toHaveLength(1);
      const created = store.createdForecasts[0];
      expect(created.assumptions).toContain(
        `Account ${closedId} is closed and contributes zero.`,
      );
      // Opening balance should reflect only openId (50000)
      expect(created.series[0].expected.amountMinor).toBe('50000');
      expect(store.readNativeBalanceAccountIds).toEqual([openId]);
      expect(store.readTransactionsInPeriodAccountIds).toEqual([openId]);
    });

    it('when all requested accountIds are closed, passes empty array to both reads resulting in zero balance and zero history', async () => {
      const closedId = '22222222-0000-4000-8000-000000000002';
      const store = new FakeForecastStore({
        accounts: [{ id: closedId, status: 'closed' }],
        nativeBalances: [],
      });
      const idempotency = new FakeIdempotencyStore();
      const jobs = new FakeJobWriter();
      const service = new ForecastService(
        directTransaction,
        store,
        idempotency,
        jobs,
        () => fixedNow,
      );

      const cmd: ForecastRequest = {
        horizonDays: 30,
        accountIds: [closedId],
        includeScenarios: false,
      };

      const result = await service.createBalanceForecast(
        subject,
        workspaceId,
        cmd,
        'key-1',
      );
      expect(result.kind).toBe(FORECAST_OUTCOMES.ACCEPTED);
      expect(store.readNativeBalanceAccountIds).toEqual([]);
      expect(store.readTransactionsInPeriodAccountIds).toEqual([]);
      const created = store.createdForecasts[0];
      expect(created.series[0].expected.amountMinor).toBe('0');
      expect(created.confidence).toBe('low');
      expect(created.assumptions).toContain(
        '0 months of history available; daily drift and bounds are zero.',
      );
      expect(created.assumptions).toContain(
        `Account ${closedId} is closed and contributes zero.`,
      );
    });

    it('when accountIds is absent, queries readOpenAccountIds and passes effective set to both reads', async () => {
      const openId1 = '11111111-0000-4000-8000-000000000001';
      const openId2 = '22222222-0000-4000-8000-000000000002';
      const store = new FakeForecastStore({
        openAccountIds: [openId1, openId2],
        nativeBalances: [
          { id: openId1, currency: 'USD', nativeBalanceMinor: '25000' },
          { id: openId2, currency: 'USD', nativeBalanceMinor: '35000' },
        ],
      });
      const idempotency = new FakeIdempotencyStore();
      const jobs = new FakeJobWriter();
      const service = new ForecastService(
        directTransaction,
        store,
        idempotency,
        jobs,
        () => fixedNow,
      );

      const cmd: ForecastRequest = {
        horizonDays: 30,
        includeScenarios: false,
      };

      const result = await service.createBalanceForecast(
        subject,
        workspaceId,
        cmd,
        'key-1',
      );
      expect(result.kind).toBe(FORECAST_OUTCOMES.ACCEPTED);
      expect(store.readOpenAccountIdsCalled).toBe(true);
      expect(store.readNativeBalanceAccountIds).toEqual([openId1, openId2]);
      expect(store.readTransactionsInPeriodAccountIds).toEqual([
        openId1,
        openId2,
      ]);
    });

    it('returns MISSING_RATE 422 when account has non-base currency with missing exchange rate', async () => {
      const store = new FakeForecastStore({
        baseCurrency: 'USD',
        nativeBalances: [
          { id: 'acct-eur', currency: 'EUR', nativeBalanceMinor: '1000' },
        ],
        rates: {}, // no EUR:USD rate
      });
      const idempotency = new FakeIdempotencyStore();
      const jobs = new FakeJobWriter();
      const service = new ForecastService(
        directTransaction,
        store,
        idempotency,
        jobs,
        () => fixedNow,
      );

      const result = await service.createBalanceForecast(
        subject,
        workspaceId,
        command,
        'key-1',
      );
      expect(result.kind).toBe(FORECAST_OUTCOMES.MISSING_RATE);
      if (result.kind === FORECAST_OUTCOMES.MISSING_RATE) {
        expect(result.fromCurrency).toBe('EUR');
        expect(result.toCurrency).toBe('USD');
      }
    });

    it('returns MISSING_RATE 422 when transaction flow row has non-base currency with missing rate', async () => {
      const store = new FakeForecastStore({
        baseCurrency: 'USD',
        transactions: [
          {
            id: 'tx-1',
            type: 'income',
            amountMinor: '2000',
            currency: 'EUR',
            occurredAt: new Date('2026-08-15T00:00:00.000Z'),
          },
        ],
        rates: {}, // no EUR:USD rate
      });
      const idempotency = new FakeIdempotencyStore();
      const jobs = new FakeJobWriter();
      const service = new ForecastService(
        directTransaction,
        store,
        idempotency,
        jobs,
        () => fixedNow,
      );

      const result = await service.createBalanceForecast(
        subject,
        workspaceId,
        command,
        'key-1',
      );
      expect(result.kind).toBe(FORECAST_OUTCOMES.MISSING_RATE);
      if (result.kind === FORECAST_OUTCOMES.MISSING_RATE) {
        expect(result.fromCurrency).toBe('EUR');
        expect(result.toCurrency).toBe('USD');
      }
    });

    it('converts non-base currency using exchange rate and computes forecast', async () => {
      const store = new FakeForecastStore({
        baseCurrency: 'USD',
        nativeBalances: [
          { id: 'acct-eur', currency: 'EUR', nativeBalanceMinor: '10000' },
        ],
        rates: {
          'EUR:USD': '1.10',
        },
      });
      const idempotency = new FakeIdempotencyStore();
      const jobs = new FakeJobWriter();
      const service = new ForecastService(
        directTransaction,
        store,
        idempotency,
        jobs,
        () => fixedNow,
      );

      const result = await service.createBalanceForecast(
        subject,
        workspaceId,
        command,
        'key-1',
      );
      expect(result.kind).toBe(FORECAST_OUTCOMES.ACCEPTED);
      expect(store.createdForecasts).toHaveLength(1);
      // 10000 EUR * 1.10 = 11000 USD
      expect(store.createdForecasts[0].series[0].expected.amountMinor).toBe(
        '11000',
      );
    });

    it('applies completed scenario run when includeScenarios is true', async () => {
      const store = new FakeForecastStore({
        baseCurrency: 'USD',
        scenarioRun: {
          id: 'scen-run-123',
          monthlySavingsCapacityMinor: '60000',
        },
      });
      const idempotency = new FakeIdempotencyStore();
      const jobs = new FakeJobWriter();
      const service = new ForecastService(
        directTransaction,
        store,
        idempotency,
        jobs,
        () => fixedNow,
      );

      const cmd: ForecastRequest = {
        horizonDays: 30,
        includeScenarios: true,
      };

      const result = await service.createBalanceForecast(
        subject,
        workspaceId,
        cmd,
        'key-1',
      );
      expect(result.kind).toBe(FORECAST_OUTCOMES.ACCEPTED);
      const created = store.createdForecasts[0];
      expect(created.assumptions).toContain(
        'Applied scenario run scen-run-123.',
      );
      // 60000 / 30 = 2000 per day drift; opening balance 0 -> day 1 = 2000
      expect(created.series[0].expected.amountMinor).toBe('2000');
    });

    it('records assumption when includeScenarios requested but no completed scenario run existed', async () => {
      const store = new FakeForecastStore({
        baseCurrency: 'USD',
        scenarioRun: undefined,
      });
      const idempotency = new FakeIdempotencyStore();
      const jobs = new FakeJobWriter();
      const service = new ForecastService(
        directTransaction,
        store,
        idempotency,
        jobs,
        () => fixedNow,
      );

      const cmd: ForecastRequest = {
        horizonDays: 30,
        includeScenarios: true,
      };

      const result = await service.createBalanceForecast(
        subject,
        workspaceId,
        cmd,
        'key-1',
      );
      expect(result.kind).toBe(FORECAST_OUTCOMES.ACCEPTED);
      const created = store.createdForecasts[0];
      expect(created.assumptions).toContain(
        'includeScenarios was requested but no completed scenario run existed; proceeded from history.',
      );
    });

    it('counts only buckets with rows for monthsOfHistoryAvailable and trims leading empty buckets', async () => {
      // 2 flow rows in two distinct months (Aug 2026 and Jul 2026)
      const store = new FakeForecastStore({
        baseCurrency: 'USD',
        transactions: [
          {
            id: 'tx-1',
            type: 'income',
            amountMinor: '30000',
            currency: 'USD',
            occurredAt: new Date('2026-07-15T00:00:00.000Z'),
          },
          {
            id: 'tx-2',
            type: 'income',
            amountMinor: '30000',
            currency: 'USD',
            occurredAt: new Date('2026-08-15T00:00:00.000Z'),
          },
        ],
      });
      const idempotency = new FakeIdempotencyStore();
      const jobs = new FakeJobWriter();
      const service = new ForecastService(
        directTransaction,
        store,
        idempotency,
        jobs,
        () => fixedNow,
      );

      const result = await service.createBalanceForecast(
        subject,
        workspaceId,
        command,
        'key-1',
      );
      expect(result.kind).toBe(FORECAST_OUTCOMES.ACCEPTED);
      const created = store.createdForecasts[0];
      // 2 months with rows -> confidence is low (< 3)
      expect(created.confidence).toBe('low');
      // trimmed buckets from first month with rows (July) through last bucket (September) = 3 months
      expect(created.assumptions).toContain('3 month(s) of history used.');
    });

    it('handles race condition where idempotency write fails and rereads record', async () => {
      const store = new FakeForecastStore();
      const idempotency = new FakeIdempotencyStore();
      idempotency.writeResult = false; // Simulate write collision

      // Pre-populate with matching record to simulate another concurrent request winning
      const existingJob: Job = {
        id: 'job-existing',
        type: 'balance_forecast',
        status: 'completed',
        progressPercent: 100,
        resultResourceId: 'existing-forecast',
        error: null,
        createdAt: fixedNow.toISOString(),
        startedAt: fixedNow.toISOString(),
        completedAt: fixedNow.toISOString(),
      };
      const jobs = new FakeJobWriter();
      const service = new ForecastService(
        directTransaction,
        store,
        idempotency,
        jobs,
        () => fixedNow,
      );

      // Now set up store so that on first read it returns null, but on reread it returns the winning record
      let readCount = 0;
      idempotency.read = async () => {
        readCount++;
        if (readCount === 1) return undefined;
        return {
          requestFingerprint: computeRequestFingerprint(command),
          responseStatus: 202,
          responseEtag: null,
          responseBody: existingJob,
        };
      };

      const result = await service.createBalanceForecast(
        subject,
        workspaceId,
        command,
        'key-collision',
      );
      expect(result.kind).toBe(FORECAST_OUTCOMES.REPLAYED);
      if (result.kind === FORECAST_OUTCOMES.REPLAYED) {
        expect(result.status).toBe(202);
      }
    });
  });

  describe('getForecast', () => {
    it('returns FORBIDDEN when user role is not allowed', async () => {
      const store = new FakeForecastStore({ role: undefined });
      const idempotency = new FakeIdempotencyStore();
      const jobs = new FakeJobWriter();
      const service = new ForecastService(
        directTransaction,
        store,
        idempotency,
        jobs,
        () => fixedNow,
      );

      const result = await service.getForecast(
        subject,
        workspaceId,
        'forecast-1',
      );
      expect(result.kind).toBe(FORECAST_OUTCOMES.FORBIDDEN);
    });

    it('returns NOT_FOUND when forecast does not exist', async () => {
      const store = new FakeForecastStore({
        role: 'viewer',
        forecast: undefined,
      });
      const idempotency = new FakeIdempotencyStore();
      const jobs = new FakeJobWriter();
      const service = new ForecastService(
        directTransaction,
        store,
        idempotency,
        jobs,
        () => fixedNow,
      );

      const result = await service.getForecast(
        subject,
        workspaceId,
        'forecast-nonexistent',
      );
      expect(result.kind).toBe(FORECAST_OUTCOMES.NOT_FOUND);
    });

    it('returns OK with forecast when user has viewer role and forecast exists', async () => {
      const sampleForecast: Forecast = {
        id: 'forecast-uuid-1',
        status: 'completed',
        generatedAt: fixedNow.toISOString(),
        confidence: 'high',
        assumptions: ['sample assumption'],
        series: [],
        method: 'mean-monthly-flow-with-population-stddev-bounds',
      };
      const store = new FakeForecastStore({
        role: 'viewer',
        forecast: sampleForecast,
      });
      const idempotency = new FakeIdempotencyStore();
      const jobs = new FakeJobWriter();
      const service = new ForecastService(
        directTransaction,
        store,
        idempotency,
        jobs,
        () => fixedNow,
      );

      const result = await service.getForecast(
        subject,
        workspaceId,
        'forecast-uuid-1',
      );
      expect(result.kind).toBe(FORECAST_OUTCOMES.OK);
      if (result.kind === FORECAST_OUTCOMES.OK) {
        expect(result.forecast).toEqual(sampleForecast);
      }
    });
  });
});
