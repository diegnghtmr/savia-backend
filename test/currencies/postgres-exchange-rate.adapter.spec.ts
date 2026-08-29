import { describe, expect, it, vi } from 'vitest';

import { PostgresExchangeRateAdapter } from '../../src/currencies/postgres-exchange-rate.adapter.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';

describe('PostgresExchangeRateAdapter.listExchangeRates', () => {
  const adapter = new PostgresExchangeRateAdapter();
  const workspaceId = '00000000-0000-0000-0000-000000000951';

  it('queries public.exchange_rates with workspace_id and deterministic ordering (effective_at desc, id desc) when no filters provided (D1, D2)', async () => {
    const effectiveAtDate = new Date('2026-08-28T12:00:00.000Z');
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: '00000000-0000-0000-0000-000000000fx1',
            baseCurrency: 'USD',
            quoteCurrency: 'EUR',
            rate: '0.9200',
            effectiveAt: effectiveAtDate,
            source: 'manual',
            manual: true,
          },
        ],
      }),
    };

    const result = await adapter.listExchangeRates(client, { workspaceId });

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];

    expect(sql).toContain('from public.exchange_rates');
    expect(sql).toContain('where workspace_id = $1::uuid');
    expect(sql).toContain('order by effective_at desc, id desc');
    // D1: No limit / offset pagination in SQL query
    expect(sql).not.toContain('limit');
    expect(sql).not.toContain('offset');
    expect(values).toEqual([workspaceId]);

    // D6: Rate is preserved as exact string '0.9200' without renormalisation
    expect(result).toEqual([
      {
        id: '00000000-0000-0000-0000-000000000fx1',
        baseCurrency: 'USD',
        quoteCurrency: 'EUR',
        rate: '0.9200',
        effectiveAt: '2026-08-28T12:00:00.000Z',
        source: 'manual',
        manual: true,
      },
    ]);
  });

  it('proves tie-breaking by id desc when two exchange rates have identical effective_at (D2)', async () => {
    const tiedTimestamp = new Date('2026-08-28T12:00:00.000Z');
    const rowHighId = {
      id: '00000000-0000-0000-0000-000000000002',
      baseCurrency: 'USD',
      quoteCurrency: 'GBP',
      rate: '0.7800',
      effectiveAt: tiedTimestamp,
      source: 'manual',
      manual: true,
    };
    const rowLowId = {
      id: '00000000-0000-0000-0000-000000000001',
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      rate: '0.9200',
      effectiveAt: tiedTimestamp,
      source: 'manual',
      manual: true,
    };

    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({
        rows: [rowHighId, rowLowId],
      }),
    };

    const result = await adapter.listExchangeRates(client, { workspaceId });

    const [sql] = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain('order by effective_at desc, id desc');

    expect(result[0].id).toBe('00000000-0000-0000-0000-000000000002');
    expect(result[1].id).toBe('00000000-0000-0000-0000-000000000001');
    expect(result[0].effectiveAt).toBe(result[1].effectiveAt);
  });

  it('applies baseCurrency filter alone (D3)', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await adapter.listExchangeRates(client, {
      workspaceId,
      baseCurrency: 'USD',
    });

    const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain('workspace_id = $1::uuid and base_currency = $2');
    expect(values).toEqual([workspaceId, 'USD']);
  });

  it('applies quoteCurrency filter alone (D3)', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await adapter.listExchangeRates(client, {
      workspaceId,
      quoteCurrency: 'EUR',
    });

    const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain('workspace_id = $1::uuid and quote_currency = $2');
    expect(values).toEqual([workspaceId, 'EUR']);
  });

  it('applies from filter with inclusive lower bound effective_at >= $2::timestamptz (D3)', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await adapter.listExchangeRates(client, {
      workspaceId,
      from: '2026-08-01',
    });

    const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain(
      'workspace_id = $1::uuid and effective_at >= $2::timestamptz',
    );
    expect(values).toEqual([workspaceId, '2026-08-01']);
  });

  it("applies to filter with inclusive upper bound effective_at < ($2::timestamptz + interval '1 day') (D3)", async () => {
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await adapter.listExchangeRates(client, {
      workspaceId,
      to: '2026-08-28',
    });

    const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain(
      "workspace_id = $1::uuid and effective_at < ($2::timestamptz + interval '1 day')",
    );
    expect(values).toEqual([workspaceId, '2026-08-28']);
  });

  it('combines all filters parameterized without string interpolation (D3)', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await adapter.listExchangeRates(client, {
      workspaceId,
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      from: '2026-08-01',
      to: '2026-08-28',
    });

    const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain('workspace_id = $1::uuid');
    expect(sql).toContain('base_currency = $2');
    expect(sql).toContain('quote_currency = $3');
    expect(sql).toContain('effective_at >= $4::timestamptz');
    expect(sql).toContain(
      "effective_at < ($5::timestamptz + interval '1 day')",
    );
    expect(values).toEqual([
      workspaceId,
      'USD',
      'EUR',
      '2026-08-01',
      '2026-08-28',
    ]);
  });

  it('returns empty array when query returns no rows (empty result is 200, not error)', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    const result = await adapter.listExchangeRates(client, { workspaceId });
    expect(result).toEqual([]);
  });
});
