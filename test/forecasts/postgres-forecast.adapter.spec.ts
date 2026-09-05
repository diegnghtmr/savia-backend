import { describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import { PostgresForecastAdapter } from '../../src/forecasts/postgres-forecast.adapter.js';
import type { CreateForecastRecord } from '../../src/forecasts/forecast.port.js';

describe('PostgresForecastAdapter', () => {
  const workspaceId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const subject = '11111111-0000-4000-8000-000000000001';

  it('reads active role for workspace', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ role: 'owner' }],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresForecastAdapter();
    const role = await adapter.readActiveRole(mockClient, workspaceId);

    expect(role).toBe('owner');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('workspace_actor_active_role'),
      [workspaceId],
    );
  });

  it('reads workspace base currency', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ baseCurrency: 'USD' }],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresForecastAdapter();
    const currency = await adapter.readWorkspaceBaseCurrency(
      mockClient,
      workspaceId,
    );

    expect(currency).toBe('USD');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('from public.workspaces'),
      [workspaceId],
    );
  });

  it('finds forecast by id and maps fields', async () => {
    const forecastId = 'ffffffff-0000-4000-8000-000000000001';
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            id: forecastId,
            status: 'completed',
            generatedAt: '2026-09-04T12:00:00.000000Z',
            confidence: 'high',
            assumptions: ['assumption 1'],
            series: [
              {
                date: '2026-09-05',
                expected: { amountMinor: '1000', currency: 'USD' },
                lowerBound: { amountMinor: '900', currency: 'USD' },
                upperBound: { amountMinor: '1100', currency: 'USD' },
              },
            ],
            method: 'mean-monthly-flow-with-population-stddev-bounds',
          },
        ],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresForecastAdapter();
    const forecast = await adapter.findForecastById(
      mockClient,
      workspaceId,
      forecastId,
    );

    expect(forecast).toBeDefined();
    expect(forecast?.id).toBe(forecastId);
    expect(forecast?.status).toBe('completed');
    expect(forecast?.confidence).toBe('high');
    expect(forecast?.assumptions).toEqual(['assumption 1']);
    expect(forecast?.series).toHaveLength(1);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('from public.forecasts'),
      [workspaceId, forecastId],
    );
  });

  it('returns undefined when forecast is not found', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresForecastAdapter();
    const forecast = await adapter.findForecastById(
      mockClient,
      workspaceId,
      'ffffffff-0000-4000-8000-000000000002',
    );

    expect(forecast).toBeUndefined();
  });

  it('checks accounts exist in workspace', async () => {
    const accountIds = [
      '11111111-0000-4000-8000-000000000001',
      '22222222-0000-4000-8000-000000000002',
    ];
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          { id: accountIds[0], status: 'open' },
          { id: accountIds[1], status: 'closed' },
        ],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresForecastAdapter();
    const rows = await adapter.checkAccountsExist(
      mockClient,
      workspaceId,
      accountIds,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(accountIds[0]);
    expect(rows[1]?.status).toBe('closed');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('from public.accounts'),
      [workspaceId, accountIds],
    );
  });

  it('reads account native balances with accountIds filter', async () => {
    const accountIds = ['11111111-0000-4000-8000-000000000001'];
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            id: accountIds[0],
            currency: 'USD',
            nativeBalanceMinor: '15000',
          },
        ],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresForecastAdapter();
    const balances = await adapter.readAccountNativeBalances(
      mockClient,
      workspaceId,
      accountIds,
    );

    expect(balances).toHaveLength(1);
    expect(balances[0]?.nativeBalanceMinor).toBe('15000');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("acct.status <> 'closed'"),
      [workspaceId, accountIds],
    );
  });

  it('reads open account ids in workspace', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          { id: '11111111-0000-4000-8000-000000000001' },
          { id: '22222222-0000-4000-8000-000000000002' },
        ],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresForecastAdapter();
    const ids = await adapter.readOpenAccountIds(mockClient, workspaceId);

    expect(ids).toEqual([
      '11111111-0000-4000-8000-000000000001',
      '22222222-0000-4000-8000-000000000002',
    ]);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("status <> 'closed'"),
      [workspaceId],
    );
  });

  it('reads transactions in period with positive and negative posting-status predicates and account filter', async () => {
    const accountIds = ['11111111-0000-4000-8000-000000000001'];
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            id: 'tx-1',
            type: 'income',
            amountMinor: '25000',
            currency: 'USD',
            occurredAt: new Date('2026-08-01T12:00:00.000Z'),
          },
        ],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresForecastAdapter();
    const rows = await adapter.readTransactionsInPeriod(
      mockClient,
      workspaceId,
      '2025-10-01',
      '2026-09-04',
      accountIds,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.amountMinor).toBe('25000');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('t.account_id = any($4::uuid[])'),
      [workspaceId, '2025-10-01', '2026-09-04', accountIds],
    );
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('not exists'),
      [workspaceId, '2025-10-01', '2026-09-04', accountIds],
    );
  });

  it('finds exchange rate between two currencies', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ rate: '1.25' }],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresForecastAdapter();
    const rate = await adapter.findExchangeRate(
      mockClient,
      workspaceId,
      'EUR',
      'USD',
      new Date('2026-09-04T12:00:00.000Z'),
    );

    expect(rate).toBe('1.25');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('from public.exchange_rates'),
      [workspaceId, 'EUR', 'USD', expect.any(Date)],
    );
  });

  it('returns undefined when exchange rate is not found', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresForecastAdapter();
    const rate = await adapter.findExchangeRate(
      mockClient,
      workspaceId,
      'GBP',
      'USD',
      new Date('2026-09-04T12:00:00.000Z'),
    );

    expect(rate).toBeUndefined();
  });

  it('finds most recent completed scenario run', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            id: 'run-1',
            monthlySavingsCapacityMinor: '45000',
          },
        ],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresForecastAdapter();
    const run = await adapter.findMostRecentCompletedScenarioRun(
      mockClient,
      workspaceId,
    );

    expect(run).toBeDefined();
    expect(run?.id).toBe('run-1');
    expect(run?.monthlySavingsCapacityMinor).toBe('45000');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("projected->>'monthlySavingsCapacityMinor' ~ '^-?[0-9]+$'"),
      [workspaceId],
    );
  });

  it('creates forecast row with all fields and explicit id', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [],
      }),
    } as unknown as TransactionClient;

    const forecastData: CreateForecastRecord = {
      id: 'ffffffff-0000-4000-8000-000000000001',
      jobId: 'jjjjjjjj-0000-4000-8000-000000000001',
      status: 'completed',
      confidence: 'high',
      method: 'mean-monthly-flow-with-population-stddev-bounds',
      horizonDays: 90,
      assumptions: ['assumption 1'],
      series: [
        {
          date: '2026-09-05',
          expected: { amountMinor: '1000', currency: 'USD' },
          lowerBound: { amountMinor: '900', currency: 'USD' },
          upperBound: { amountMinor: '1100', currency: 'USD' },
        },
      ],
      generatedAt: new Date('2026-09-04T12:00:00.000Z'),
    };

    const adapter = new PostgresForecastAdapter();
    await adapter.createForecast(
      mockClient,
      workspaceId,
      subject,
      forecastData,
    );

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringMatching(/insert into public\.forecasts/i),
      [
        forecastData.id,
        workspaceId,
        forecastData.jobId,
        'completed',
        'high',
        'mean-monthly-flow-with-population-stddev-bounds',
        90,
        JSON.stringify(forecastData.assumptions),
        JSON.stringify(forecastData.series),
        forecastData.generatedAt.toISOString(),
        subject,
      ],
    );
  });
});
