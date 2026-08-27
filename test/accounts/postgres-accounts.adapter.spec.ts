import { describe, expect, it, vi } from 'vitest';

import {
  negateAmountMinor,
  toIso,
  PostgresAccountsAdapter,
} from '../../src/accounts/postgres-accounts.adapter.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';

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
