import { describe, expect, it } from 'vitest';
import {
  ForecastJobHandler,
  ForecastWriteForbiddenError,
} from '../../src/forecasts/forecast-job.handler.js';
import type {
  AccountExistenceRow,
  AccountNativeBalanceRow,
  CreateForecastRecord,
  Forecast,
  ForecastStore,
  ScenarioRunRowData,
  TransactionFlowRow,
} from '../../src/forecasts/forecast.port.js';
import type { ForecastJobPayload } from '../../src/forecasts/forecast-job-payload.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import { PostgresForecastAdapter } from '../../src/forecasts/postgres-forecast.adapter.js';

class FakeForecastStore implements ForecastStore {
  public createdForecasts: CreateForecastRecord[] = [];

  public constructor(
    private readonly options: {
      role?: string;
      nativeBalances?: readonly AccountNativeBalanceRow[];
      transactions?: readonly TransactionFlowRow[];
      rates?: Record<string, string>;
      scenarioRun?: ScenarioRunRowData;
    } = {},
  ) {}

  public async readActiveRole(): Promise<string | undefined> {
    return 'role' in this.options ? this.options.role : 'owner';
  }

  public async readWorkspaceBaseCurrency(): Promise<string | undefined> {
    return 'USD';
  }

  public async findForecastById(): Promise<Forecast | undefined> {
    return undefined;
  }

  public async checkAccountsExist(
    _client: TransactionClient,
    _workspaceId: string,
    accountIds: readonly string[],
  ): Promise<readonly AccountExistenceRow[]> {
    return accountIds.map((id) => ({ id, status: 'open' }));
  }

  public async readOpenAccountIds(): Promise<readonly string[]> {
    return [];
  }

  public async readAccountNativeBalances(): Promise<
    readonly AccountNativeBalanceRow[]
  > {
    return this.options.nativeBalances ?? [];
  }

  public async readTransactionsInPeriod(): Promise<
    readonly TransactionFlowRow[]
  > {
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

const payload: ForecastJobPayload = {
  version: 1,
  asOf: '2026-09-04T12:00:00.000Z',
  horizonDays: 30,
  includeScenarios: false,
  effectiveAccountIds: ['11111111-0000-4000-8000-000000000001'],
  closedAccountAssumptions: [],
  baseCurrency: 'USD',
};

const context = {
  jobId: 'aaaaaaaa-0000-4000-8000-000000000099',
  workspaceId: 'aaaaaaaa-0000-4000-8000-000000000001',
  actorId: '11111111-0000-4000-8000-000000000001',
  attemptCount: 1,
  payload,
};

describe('ForecastJobHandler', () => {
  it('rejects an invalid frozen payload', () => {
    const handler = new ForecastJobHandler(
      new FakeForecastStore() as unknown as PostgresForecastAdapter,
    );
    expect(() => handler.parsePayload({ nope: true })).toThrow(
      /unknown or missing fields/,
    );
  });

  it('refuses persist when the actor no longer has a write role', async () => {
    const store = new FakeForecastStore({ role: 'viewer' });
    const handler = new ForecastJobHandler(
      store as unknown as PostgresForecastAdapter,
    );
    const computed = {
      confidence: 'low' as const,
      method: 'mean-monthly-flow-with-population-stddev-bounds',
      assumptions: [],
      series: [],
    };
    await expect(
      handler.persist(context, computed, {} as TransactionClient),
    ).rejects.toBeInstanceOf(ForecastWriteForbiddenError);
    expect(store.createdForecasts).toHaveLength(0);
  });

  it('persists the forecast after re-checking the write role', async () => {
    const store = new FakeForecastStore({ role: 'editor' });
    const handler = new ForecastJobHandler(
      store as unknown as PostgresForecastAdapter,
    );
    const computed = {
      confidence: 'low' as const,
      method: 'mean-monthly-flow-with-population-stddev-bounds',
      assumptions: ['frozen'],
      series: [],
    };
    const forecastId = await handler.persist(
      context,
      computed,
      {} as TransactionClient,
    );
    expect(forecastId).toEqual(expect.any(String));
    expect(store.createdForecasts).toHaveLength(1);
    expect(store.createdForecasts[0]?.jobId).toBe(context.jobId);
    expect(store.createdForecasts[0]?.status).toBe('completed');
  });
});
