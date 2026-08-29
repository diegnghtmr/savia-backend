import { describe, expect, it, vi } from 'vitest';

import {
  negateAmountMinor,
  toIso,
  multiplyMinorByRate,
  PostgresAccountsAdapter,
} from '../../src/accounts/postgres-accounts.adapter.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';

describe('multiplyMinorByRate', () => {
  it('multiplies positive minor units by decimal rate without floating point', () => {
    expect(multiplyMinorByRate('10000', '1.0800')).toBe('10800');
    expect(multiplyMinorByRate('100', '0.9200')).toBe('92');
  });

  it('rounds half away from zero for positive amounts', () => {
    expect(multiplyMinorByRate('100', '1.0850')).toBe('109');
    expect(multiplyMinorByRate('100', '1.0849')).toBe('108');
    expect(multiplyMinorByRate('1', '1.5')).toBe('2');
  });

  it('rounds half away from zero for negative amounts', () => {
    expect(multiplyMinorByRate('-100', '1.0850')).toBe('-109');
    expect(multiplyMinorByRate('-100', '1.0849')).toBe('-108');
    expect(multiplyMinorByRate('-1', '1.5')).toBe('-2');
  });

  it('handles integer rate without decimal point', () => {
    expect(multiplyMinorByRate('5000', '2')).toBe('10000');
    expect(multiplyMinorByRate('-5000', '2')).toBe('-10000');
  });

  it('preserves precision for amounts past 2^53 without JS number truncation', () => {
    const huge = '9007199254740993';
    expect(multiplyMinorByRate(huge, '1.5')).toBe('13510798882111490');
  });
});

describe('negateAmountMinor', () => {
  it('negates positive amountMinor without number conversion', () => {
    expect(negateAmountMinor('10000')).toBe('-10000');
    expect(negateAmountMinor('9007199254740993')).toBe('-9007199254740993');
  });

  it('negates negative amountMinor without number conversion', () => {
    expect(negateAmountMinor('-10000')).toBe('10000');
    expect(negateAmountMinor('-9007199254740993')).toBe('9007199254740993');
  });

  it('handles zero without producing negative zero', () => {
    expect(negateAmountMinor('0')).toBe('0');
    expect(negateAmountMinor('-0')).toBe('0');
  });
});

describe('toIso', () => {
  it('formats a Date to an ISO string', () => {
    const date = new Date('2026-07-01T12:34:56.789Z');
    expect(toIso(date)).toBe('2026-07-01T12:34:56.789Z');
  });

  it('fails loudly when passed a string instead of a Date', () => {
    expect(() => toIso('2026-07-01 12:34:56+00')).toThrow(TypeError);
  });

  it('fails loudly when passed null or undefined', () => {
    expect(() => toIso(null as unknown as Date)).toThrow(TypeError);
    expect(() => toIso(undefined as unknown as Date)).toThrow(TypeError);
  });

  it('refuses to negate int64-min rather than minting an out-of-range counter-leg', () => {
    // The validator rejects this upstream, but the guard belongs here too: this
    // function is what mints the external leg, and PostgreSQL would answer 22003
    // mid-write, turning a validated request into a 500.
    expect(() => negateAmountMinor('-9223372036854775808')).toThrow(RangeError);
    // One step inside the negatable range still works.
    expect(negateAmountMinor('-9223372036854775807')).toBe(
      '9223372036854775807',
    );
  });
});

describe('PostgresAccountsAdapter.updateAccount', () => {
  const adapter = new PostgresAccountsAdapter();
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const accountId = '00000000-0000-0000-0000-000000000a01';

  it('updates dynamic fields and maps row to Account domain model', async () => {
    const createdAt = new Date('2026-07-01T00:00:00.000Z');
    const updatedAt = new Date('2026-07-02T00:00:00.000Z');
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: accountId,
            name: 'Updated Name',
            type: 'checking',
            currency: 'USD',
            status: 'active',
            institution: null,
            maskedNumber: '**** 1234',
            description: 'New Description',
            colorToken: null,
            icon: null,
            includeInNetWorth: true,
            createdAt,
            updatedAt,
            version: 2,
          },
        ],
      }),
    };

    const result = await adapter.updateAccount(
      client,
      workspaceId,
      accountId,
      {
        name: 'Updated Name',
        institution: null, // explicit null clears field
        maskedNumber: '**** 1234',
        description: 'New Description',
        includeInNetWorth: true,
        status: 'active',
      },
      1,
    );

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain('update public.accounts');
    expect(sql).toContain('updated_at = now()');
    expect(sql).toContain('version = version + 1');
    expect(sql).toContain('name = $3');
    expect(sql).toContain('institution = $4');
    expect(sql).toContain('masked_number = $5');
    expect(sql).toContain('description = $6');
    expect(sql).toContain('include_in_net_worth = $7');
    expect(sql).toContain('status = $8');
    expect(sql).toContain('where workspace_id = $1::uuid');
    expect(sql).toContain('and id = $2::uuid');
    expect(values).toEqual([
      workspaceId,
      accountId,
      'Updated Name',
      null,
      '**** 1234',
      'New Description',
      true,
      'active',
      [1],
    ]);

    expect(result).toEqual({
      id: accountId,
      name: 'Updated Name',
      type: 'checking',
      currency: 'USD',
      status: 'active',
      institution: null,
      maskedNumber: '**** 1234',
      description: 'New Description',
      colorToken: null,
      icon: null,
      includeInNetWorth: true,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
      version: 2,
    });
  });

  it('returns undefined when client.query returns no rows', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    const result = await adapter.updateAccount(
      client,
      workspaceId,
      accountId,
      { name: 'Updated' },
      undefined,
    );

    expect(result).toBeUndefined();
  });
});

describe('PostgresAccountsAdapter.readWorkspaceBaseCurrency', () => {
  const adapter = new PostgresAccountsAdapter();
  const workspaceId = '00000000-0000-0000-0000-000000000951';

  it('takes advisory lock and queries public.workspaces scoped by workspace_id and returns base_currency', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ base_currency: 'USD' }],
        }),
    };

    const result = await adapter.readWorkspaceBaseCurrency(client, workspaceId);

    expect(client.query).toHaveBeenCalledTimes(2);
    const [lockSql, lockValues] = (client.query as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [string, unknown[]];
    expect(lockSql).toContain(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
    );
    expect(lockValues).toEqual([workspaceId.toLowerCase()]);

    const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[1] as [string, unknown[]];
    expect(sql).toContain(
      'select base_currency from public.workspaces where id = $1::uuid',
    );
    expect(values).toEqual([workspaceId]);
    expect(result).toBe('USD');
  });

  it('returns undefined when no workspace row exists', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    };

    const result = await adapter.readWorkspaceBaseCurrency(client, workspaceId);

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(result).toBeUndefined();
  });
});

describe('PostgresAccountsAdapter.readAccountBalance', () => {
  const adapter = new PostgresAccountsAdapter();
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const accountId = '00000000-0000-0000-0000-000000000a01';

  it('returns undefined when account does not exist in workspace', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    const result = await adapter.readAccountBalance(
      client,
      workspaceId,
      accountId,
      undefined,
    );

    expect(result).toBeUndefined();
    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain('select a.currency as "accountCurrency"');
    expect(sql).toContain('join public.workspaces w');
    expect(sql).toContain('where a.workspace_id = $1::uuid');
    expect(sql).toContain('and a.id = $2::uuid');
    expect(values).toEqual([workspaceId, accountId]);
  });

  it('calculates balance buckets and returns AccountBalance without availableBalance key', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ accountCurrency: 'USD', workspaceBaseCurrency: 'USD' }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              nativeBalance: '15000',
              pendingBalance: '5000',
              reconciledBalance: '3000',
              foreignCurrencyLegs: '0',
              effectiveAsOf: '2026-07-15T12:00:00.000Z',
            },
          ],
        }),
    };

    const asOf = '2026-07-15T12:00:00.000Z';
    const result = await adapter.readAccountBalance(
      client,
      workspaceId,
      accountId,
      asOf,
    );

    expect(result).toBeDefined();
    if (!result) throw new Error('Expected result to be defined');

    expect(result).toEqual({
      accountId,
      nativeBalance: {
        amountMinor: '15000',
        currency: 'USD',
      },
      pendingBalance: {
        amountMinor: '5000',
        currency: 'USD',
      },
      reconciledBalance: {
        amountMinor: '3000',
        currency: 'USD',
      },
      baseCurrencyEquivalent: {
        original: {
          amountMinor: '15000',
          currency: 'USD',
        },
        converted: {
          amountMinor: '15000',
          currency: 'USD',
        },
        rate: '1',
        rateDate: '2026-07-15',
        rateSource: 'identity',
      },
      asOf: '2026-07-15T12:00:00.000Z',
    });

    // RULING 31: availableBalance key must be ABSENT
    expect('availableBalance' in result).toBe(false);

    expect(client.query).toHaveBeenCalledTimes(2);
    const [balanceSql, balanceValues] = (
      client.query as ReturnType<typeof vi.fn>
    ).mock.calls[1] as [string, unknown[]];
    expect(balanceSql).toContain('from public.ledger_postings posting');
    expect(balanceSql).toContain(
      "filter (where posting.currency = acct.currency and posting.status in ('confirmed', 'reconciled'))",
    );
    expect(balanceSql).toContain(
      "filter (where posting.currency = acct.currency and posting.status = 'pending')",
    );
    expect(balanceSql).toContain(
      "filter (where posting.currency = acct.currency and posting.status = 'reconciled')",
    );
    expect(balanceSql).toContain(
      'count(*) filter (where posting.currency <> acct.currency)::text as "foreignCurrencyLegs"',
    );
    expect(balanceSql).toContain(
      'to_char(coalesce($3::timestamptz, now()) at time zone \'utc\', \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') as "effectiveAsOf"',
    );
    expect(balanceSql).toContain('where posting.workspace_id = $1::uuid');
    expect(balanceSql).toContain('and posting.account_id = $2::uuid');
    expect(balanceSql).toContain(
      'and posting.occurred_at <= coalesce($3::timestamptz, now())',
    );
    expect(balanceValues).toEqual([workspaceId, accountId, asOf]);
  });

  it('scopes the balance aggregate query to matching account currency via accounts join', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ accountCurrency: 'USD', workspaceBaseCurrency: 'USD' }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              nativeBalance: '1000',
              pendingBalance: '0',
              reconciledBalance: '0',
              foreignCurrencyLegs: '0',
              effectiveAsOf: '2026-07-15T12:00:00.000Z',
            },
          ],
        }),
    };

    await adapter.readAccountBalance(client, workspaceId, accountId, undefined);

    expect(client.query).toHaveBeenCalledTimes(2);
    const [balanceSql] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[1] as [string, unknown[]];
    expect(balanceSql).toContain('join public.accounts acct');
    expect(balanceSql).toContain('on acct.id = posting.account_id');
    expect(balanceSql).toContain(
      'and acct.workspace_id = posting.workspace_id',
    );
    expect(balanceSql).toContain(
      "filter (where posting.currency = acct.currency and posting.status in ('confirmed', 'reconciled'))",
    );
    expect(balanceSql).toContain(
      'count(*) filter (where posting.currency <> acct.currency)::text as "foreignCurrencyLegs"',
    );
  });

  it('handles account with no postings by defaulting buckets to "0"', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ accountCurrency: 'COP', workspaceBaseCurrency: 'COP' }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              nativeBalance: '0',
              pendingBalance: '0',
              reconciledBalance: '0',
              foreignCurrencyLegs: '0',
              effectiveAsOf: '2026-07-15T12:00:00.000Z',
            },
          ],
        }),
    };

    const result = await adapter.readAccountBalance(
      client,
      workspaceId,
      accountId,
      undefined,
    );

    expect(result).toBeDefined();
    if (!result) throw new Error('Expected result to be defined');

    expect(result.nativeBalance).toEqual({
      amountMinor: '0',
      currency: 'COP',
    });
    expect(result.pendingBalance).toEqual({
      amountMinor: '0',
      currency: 'COP',
    });
    expect(result.reconciledBalance).toEqual({
      amountMinor: '0',
      currency: 'COP',
    });
    expect(result.baseCurrencyEquivalent.rate).toBe('1');
    expect(result.baseCurrencyEquivalent.converted).toEqual({
      amountMinor: '0',
      currency: 'COP',
    });
    expect(result.asOf).toBe('2026-07-15T12:00:00.000Z');
    expect(result.baseCurrencyEquivalent.rateDate).toBe('2026-07-15');
  });

  it('preserves 64-bit precision past 2^53 without JS number truncation', async () => {
    const hugeAmount = '9007199254741093'; // 2^53 + 101, loses precision in Number()
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ accountCurrency: 'USD', workspaceBaseCurrency: 'USD' }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              nativeBalance: hugeAmount,
              pendingBalance: '0',
              reconciledBalance: '0',
              foreignCurrencyLegs: '0',
              effectiveAsOf: '2026-07-15T12:00:00.000Z',
            },
          ],
        }),
    };

    const result = await adapter.readAccountBalance(
      client,
      workspaceId,
      accountId,
      undefined,
    );

    expect(result).toBeDefined();
    if (!result) throw new Error('Expected result to be defined');

    expect(result.nativeBalance.amountMinor).toBe(hugeAmount);
    expect(result.baseCurrencyEquivalent.converted.amountMinor).toBe(
      hugeAmount,
    );
    expect(result.asOf).toBe('2026-07-15T12:00:00.000Z');

    const [balanceSql] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[1] as [string, unknown[]];
    expect(balanceSql).toContain('::text as "nativeBalance"');
    expect(balanceSql).toContain('::text as "pendingBalance"');
    expect(balanceSql).toContain('::text as "reconciledBalance"');
    expect(balanceSql).toContain(
      'to_char(coalesce($3::timestamptz, now()) at time zone \'utc\', \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') as "effectiveAsOf"',
    );
  });

  it('derives asOf and rateDate from SQL effectiveAsOf when client asOf is omitted', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ accountCurrency: 'USD', workspaceBaseCurrency: 'USD' }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              nativeBalance: '1000',
              pendingBalance: '0',
              reconciledBalance: '1000',
              foreignCurrencyLegs: '0',
              effectiveAsOf: '2026-01-01T00:00:00.000000Z',
            },
          ],
        }),
    };

    const result = await adapter.readAccountBalance(
      client,
      workspaceId,
      accountId,
      undefined,
    );

    expect(result).toBeDefined();
    if (!result) throw new Error('Expected result to be defined');

    expect(result.asOf).toBe('2026-01-01T00:00:00.000000Z');
    expect(result.baseCurrencyEquivalent.rateDate).toBe('2026-01-01');
  });

  it('derives rateDate from canonical UTC cutoff when client asOf carries a non-UTC offset', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ accountCurrency: 'USD', workspaceBaseCurrency: 'USD' }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              nativeBalance: '1000',
              pendingBalance: '0',
              reconciledBalance: '1000',
              foreignCurrencyLegs: '0',
              effectiveAsOf: '2026-07-16T01:30:00.000000Z',
            },
          ],
        }),
    };

    const result = await adapter.readAccountBalance(
      client,
      workspaceId,
      accountId,
      '2026-07-15T23:30:00-02:00',
    );

    expect(result).toBeDefined();
    if (!result) throw new Error('Expected result to be defined');

    expect(result.asOf).toBe('2026-07-16T01:30:00.000000Z');
    expect(result.baseCurrencyEquivalent.rateDate).toBe('2026-07-16');
  });

  it('converts balance using recorded exchange rate when account currency differs from workspace base currency (D5)', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ accountCurrency: 'EUR', workspaceBaseCurrency: 'USD' }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              nativeBalance: '10000',
              pendingBalance: '2000',
              reconciledBalance: '3000',
              foreignCurrencyLegs: '0',
              effectiveAsOf: '2026-07-15T12:00:00.000Z',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              rate: '1.0800',
              rateDate: '2026-07-10',
              rateSource: 'ecb',
            },
          ],
        }),
    };

    const result = await adapter.readAccountBalance(
      client,
      workspaceId,
      accountId,
      '2026-07-15T12:00:00.000Z',
    );

    expect(result).toBeDefined();
    if (!result) throw new Error('Expected result to be defined');

    expect(result.nativeBalance).toEqual({
      amountMinor: '10000',
      currency: 'EUR',
    });
    expect(result.pendingBalance).toEqual({
      amountMinor: '2000',
      currency: 'EUR',
    });
    expect(result.reconciledBalance).toEqual({
      amountMinor: '3000',
      currency: 'EUR',
    });
    expect(result.baseCurrencyEquivalent).toEqual({
      original: {
        amountMinor: '10000',
        currency: 'EUR',
      },
      converted: {
        amountMinor: '10800',
        currency: 'USD',
      },
      rate: '1.0800',
      rateDate: '2026-07-10',
      rateSource: 'ecb',
    });

    expect(client.query).toHaveBeenCalledTimes(3);
    const [rateSql, rateValues] = (client.query as ReturnType<typeof vi.fn>)
      .mock.calls[2] as [string, unknown[]];
    expect(rateSql).toContain('from public.exchange_rates');
    expect(rateSql).toContain('base_currency = $2');
    expect(rateSql).toContain('quote_currency = $3');
    expect(rateSql).toContain(
      'effective_at <= coalesce($4::timestamptz, now())',
    );
    expect(rateSql).toContain('order by effective_at desc, id desc');
    expect(rateSql).toContain('limit 1');
    expect(rateValues).toEqual([
      workspaceId,
      'EUR',
      'USD',
      '2026-07-15T12:00:00.000Z',
    ]);
  });

  it('throws an error when cross-currency account has no recorded exchange rate (D5)', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ accountCurrency: 'EUR', workspaceBaseCurrency: 'USD' }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              nativeBalance: '10000',
              pendingBalance: '0',
              reconciledBalance: '0',
              foreignCurrencyLegs: '0',
              effectiveAsOf: '2026-07-15T12:00:00.000Z',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [],
        }),
    };

    await expect(
      adapter.readAccountBalance(
        client,
        workspaceId,
        accountId,
        '2026-07-15T12:00:00.000Z',
      ),
    ).rejects.toThrow(
      'No exchange rate found for converting account currency EUR to workspace base currency USD.',
    );
  });

  it('throws an invariant error when balance aggregate query returns zero rows', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ accountCurrency: 'USD', workspaceBaseCurrency: 'USD' }],
        })
        .mockResolvedValueOnce({
          rows: [],
        }),
    };

    await expect(
      adapter.readAccountBalance(client, workspaceId, accountId, undefined),
    ).rejects.toThrow(/Account balance aggregate query returned no row/);
  });

  it('throws an error when foreign-currency postings exist for the account', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ accountCurrency: 'USD', workspaceBaseCurrency: 'USD' }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              nativeBalance: '1000',
              pendingBalance: '0',
              reconciledBalance: '0',
              foreignCurrencyLegs: '1',
              effectiveAsOf: '2026-07-15T12:00:00.000Z',
            },
          ],
        }),
    };

    await expect(
      adapter.readAccountBalance(client, workspaceId, accountId, undefined),
    ).rejects.toThrow(
      'Cannot report single-currency balance for an account holding postings in another currency.',
    );
  });
});

describe('PostgresAccountsAdapter.hasUnsettledTransactions', () => {
  const adapter = new PostgresAccountsAdapter();
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const accountId = '00000000-0000-0000-0000-000000000a01';

  it('takes per-account advisory lock as first query and queries unsettled transactions in public.transactions', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }),
    };

    const result = await adapter.hasUnsettledTransactions(
      client,
      workspaceId,
      accountId,
    );

    expect(client.query).toHaveBeenCalledTimes(2);

    const [lockSql, lockValues] = (client.query as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [string, unknown[]];
    expect(lockSql).toContain(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
    );
    expect(lockValues).toEqual([accountId.toLowerCase()]);

    const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[1] as [string, unknown[]];
    expect(sql).toContain('from public.transactions');
    expect(sql).toContain("status in ('draft', 'pending')");
    expect(sql).toContain('where workspace_id = $1::uuid');
    expect(sql).toContain('and account_id = $2::uuid');
    expect(values).toEqual([workspaceId, accountId]);

    expect(result).toBe(true);
  });

  it('returns false when no unsettled transaction rows exist', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    };

    const result = await adapter.hasUnsettledTransactions(
      client,
      workspaceId,
      accountId,
    );

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(result).toBe(false);
  });
});

describe('PostgresAccountsAdapter.closeAccount', () => {
  const adapter = new PostgresAccountsAdapter();
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const accountId = '00000000-0000-0000-0000-000000000a01';

  it('issues SQL with version predicate, closed_at assignment, status closed, version increment, and binds version array', async () => {
    const createdAt = new Date('2026-07-01T00:00:00.000Z');
    const updatedAt = new Date('2026-07-02T00:00:00.000Z');
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: accountId,
            name: 'Checking Account',
            type: 'checking',
            currency: 'USD',
            status: 'closed',
            institution: null,
            maskedNumber: null,
            description: null,
            colorToken: null,
            icon: null,
            includeInNetWorth: true,
            createdAt,
            updatedAt,
            version: 2,
          },
        ],
      }),
    };

    const result = await adapter.closeAccount(
      client,
      workspaceId,
      accountId,
      1,
    );

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain('update public.accounts');
    expect(sql).toContain("status = 'closed'");
    expect(sql).toContain('closed_at = now()');
    expect(sql).toContain('updated_at = now()');
    expect(sql).toContain('version = version + 1');
    expect(sql).toContain('where workspace_id = $1::uuid');
    expect(sql).toContain('and id = $2::uuid');
    expect(sql).toContain(
      'and ($3::integer[] is null or version = any($3::integer[]))',
    );
    expect(sql).toContain('version = any($3::integer[])');
    expect(values).toEqual([workspaceId, accountId, [1]]);

    expect(result).toEqual({
      id: accountId,
      name: 'Checking Account',
      type: 'checking',
      currency: 'USD',
      status: 'closed',
      institution: null,
      maskedNumber: null,
      description: null,
      colorToken: null,
      icon: null,
      includeInNetWorth: true,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
      version: 2,
    });
  });

  it('passes null as third parameter and retains null guard when expected version is omitted', async () => {
    const createdAt = new Date('2026-07-01T00:00:00.000Z');
    const updatedAt = new Date('2026-07-02T00:00:00.000Z');
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: accountId,
            name: 'Checking Account',
            type: 'checking',
            currency: 'USD',
            status: 'closed',
            institution: null,
            maskedNumber: null,
            description: null,
            colorToken: null,
            icon: null,
            includeInNetWorth: true,
            createdAt,
            updatedAt,
            version: 2,
          },
        ],
      }),
    };

    const result = await adapter.closeAccount(
      client,
      workspaceId,
      accountId,
      undefined,
    );

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain('$3::integer[] is null or');
    expect(values).toEqual([workspaceId, accountId, null]);
    expect(result).toBeDefined();
  });

  it('returns undefined when the UPDATE matches zero rows', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    const result = await adapter.closeAccount(
      client,
      workspaceId,
      accountId,
      1,
    );

    expect(result).toBeUndefined();
  });
});
