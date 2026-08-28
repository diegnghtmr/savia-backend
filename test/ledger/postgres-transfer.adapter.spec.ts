import { describe, expect, it, vi } from 'vitest';

import { PostgresTransferAdapter } from '../../src/ledger/postgres-transfer.adapter.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import type { CreateTransferCommand } from '../../src/ledger/transfer.port.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ACCOUNT_A = '00000000-0000-4000-8000-00000000000a';
const ACCOUNT_B = '00000000-0000-4000-8000-00000000000b';
const TRANSFER_ID = '00000000-0000-4000-8000-000000000099';

describe('PostgresTransferAdapter', () => {
  describe('lockAndReadAccounts sorted advisory lock order', () => {
    it('always acquires advisory locks in lexicographically sorted order even when arguments are reversed', async () => {
      const adapter = new PostgresTransferAdapter();
      const queries: { sql: string; values?: readonly unknown[] }[] = [];

      const client: TransactionClient = {
        query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
          queries.push({ sql, values });
          if (sql.includes('select a.id::text')) {
            return {
              rows: [
                { id: ACCOUNT_B, status: 'active', currency: 'USD' },
                { id: ACCOUNT_A, status: 'active', currency: 'USD' },
              ],
            };
          }
          return { rows: [] };
        }) as unknown as TransactionClient['query'],
      };

      // Call with ACCOUNT_B as source and ACCOUNT_A as destination (reversed order)
      const res = await adapter.lockAndReadAccounts(
        client,
        WORKSPACE_ID,
        ACCOUNT_B,
        ACCOUNT_A,
      );

      expect(res.sourceAccount?.id).toBe(ACCOUNT_B);
      expect(res.destinationAccount?.id).toBe(ACCOUNT_A);

      // Verify queries: first two queries MUST be the advisory lock queries in sorted order (A then B)
      const lockQueries = queries.filter((q) =>
        q.sql.includes('pg_advisory_xact_lock'),
      );
      expect(lockQueries).toHaveLength(2);
      expect(lockQueries[0].values).toEqual([ACCOUNT_A.toLowerCase()]);
      expect(lockQueries[1].values).toEqual([ACCOUNT_B.toLowerCase()]);
    });

    it('returns undefined for accounts not found in the workspace', async () => {
      const adapter = new PostgresTransferAdapter();
      const client: TransactionClient = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('select a.id::text')) {
            return { rows: [] };
          }
          return { rows: [] };
        }) as unknown as TransactionClient['query'],
      };

      const res = await adapter.lockAndReadAccounts(
        client,
        WORKSPACE_ID,
        ACCOUNT_A,
        ACCOUNT_B,
      );
      expect(res.sourceAccount).toBeUndefined();
      expect(res.destinationAccount).toBeUndefined();
    });
  });

  describe('createTransfer SQL and posting generation', () => {
    it('inserts transfer row into public.transfers (never public.transactions) and balanced postings into public.ledger_postings', async () => {
      const adapter = new PostgresTransferAdapter();
      const queries: { sql: string; values?: readonly unknown[] }[] = [];

      const client: TransactionClient = {
        query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
          queries.push({ sql, values });
          if (sql.includes('insert into public.transfers')) {
            return {
              rows: [
                {
                  id: TRANSFER_ID,
                  sourceAccountId: ACCOUNT_A,
                  destinationAccountId: ACCOUNT_B,
                  sourceAmountMinor: '5000',
                  sourceCurrency: 'USD',
                  destinationAmountMinor: '5000',
                  destinationCurrency: 'USD',
                  feeAmountMinor: null,
                  feeCurrency: null,
                  exchangeRate: null,
                  referenceRate: null,
                  occurredAt: new Date('2026-08-25T10:00:00.000Z'),
                  status: 'confirmed',
                  transactionId: null,
                  createdAt: new Date('2026-08-25T10:00:00.000Z'),
                  updatedAt: new Date('2026-08-25T10:00:00.000Z'),
                  version: 1,
                },
              ],
            };
          }
          return { rows: [] };
        }) as unknown as TransactionClient['query'],
      };

      const command: CreateTransferCommand = {
        sourceAccountId: ACCOUNT_A,
        destinationAccountId: ACCOUNT_B,
        amount: { amountMinor: '5000', currency: 'USD' },
        occurredAt: '2026-08-25T10:00:00.000Z',
        description: 'Test Transfer',
      };

      const transfer = await adapter.createTransfer(
        client,
        WORKSPACE_ID,
        SUBJECT,
        command,
      );

      expect(transfer.id).toBe(TRANSFER_ID);
      expect(transfer.sourceAccountId).toBe(ACCOUNT_A);
      expect(transfer.destinationAccountId).toBe(ACCOUNT_B);
      expect(transfer.sourceAmount).toEqual({
        amountMinor: '5000',
        currency: 'USD',
      });
      expect(transfer.destinationAmount).toEqual({
        amountMinor: '5000',
        currency: 'USD',
      });
      expect(transfer.status).toBe('confirmed');
      expect(transfer.fee).toBeUndefined();
      expect(transfer.transactionId).toBeUndefined();

      // 1. Verify transfer insert query is into public.transfers (NOT public.transactions)
      const transferInsert = queries.find((q) =>
        q.sql.includes('insert into public.transfers'),
      );
      expect(transferInsert).toBeDefined();
      expect(
        queries.some((q) => q.sql.includes('insert into public.transactions')),
      ).toBe(false);

      // 2. Verify postings insert query has transfer_id set and transaction_id null
      const postingsInsert = queries.find((q) =>
        q.sql.includes('insert into public.ledger_postings'),
      );
      expect(postingsInsert).toBeDefined();
      expect(postingsInsert?.sql).toContain('transfer_id');
      expect(postingsInsert?.sql).toContain('null'); // transaction_id is null

      // Check values for postings: source leg is negated (-5000), dest leg is positive (5000)
      const values = postingsInsert?.values;
      expect(values).toBeDefined();
      expect(values?.[0]).toBe(WORKSPACE_ID);
      expect(values?.[1]).toBe(TRANSFER_ID);
      expect(values?.[2]).toBe(ACCOUNT_A);
      expect(values?.[3]).toBe('-5000'); // negated source leg
      expect(values?.[4]).toBe('USD');
      expect(values?.[6]).toBe(ACCOUNT_B);
      expect(values?.[7]).toBe('5000'); // positive dest leg

      // 3. Verify enforceDeferredConstraints was called
      const deferredCheck = queries.find((q) =>
        q.sql.includes('set constraints all immediate'),
      );
      expect(deferredCheck).toBeDefined();
    });

    it('emits fee in Transfer body when fee is present and omits transactionId when no fee is present', async () => {
      const adapter = new PostgresTransferAdapter();

      const clientNoFee: TransactionClient = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('insert into public.transfers')) {
            return {
              rows: [
                {
                  id: TRANSFER_ID,
                  sourceAccountId: ACCOUNT_A,
                  destinationAccountId: ACCOUNT_B,
                  sourceAmountMinor: '5000',
                  sourceCurrency: 'USD',
                  destinationAmountMinor: '5000',
                  destinationCurrency: 'USD',
                  feeAmountMinor: null,
                  feeCurrency: null,
                  exchangeRate: null,
                  referenceRate: null,
                  occurredAt: new Date('2026-08-25T10:00:00.000Z'),
                  status: 'confirmed',
                  transactionId: null,
                  createdAt: new Date('2026-08-25T10:00:00.000Z'),
                  updatedAt: new Date('2026-08-25T10:00:00.000Z'),
                  version: 1,
                },
              ],
            };
          }
          return { rows: [] };
        }) as unknown as TransactionClient['query'],
      };

      const transferNoFee = await adapter.createTransfer(
        clientNoFee,
        WORKSPACE_ID,
        SUBJECT,
        {
          sourceAccountId: ACCOUNT_A,
          destinationAccountId: ACCOUNT_B,
          amount: { amountMinor: '5000', currency: 'USD' },
          occurredAt: '2026-08-25T10:00:00.000Z',
        },
      );
      expect(transferNoFee.fee).toBeUndefined();
      expect(transferNoFee.transactionId).toBeUndefined();
      expect('transactionId' in transferNoFee).toBe(false);

      const clientWithFee: TransactionClient = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('insert into public.transfers')) {
            return {
              rows: [
                {
                  id: TRANSFER_ID,
                  sourceAccountId: ACCOUNT_A,
                  destinationAccountId: ACCOUNT_B,
                  sourceAmountMinor: '5000',
                  sourceCurrency: 'USD',
                  destinationAmountMinor: '5000',
                  destinationCurrency: 'USD',
                  feeAmountMinor: '100',
                  feeCurrency: 'USD',
                  exchangeRate: null,
                  referenceRate: null,
                  occurredAt: new Date('2026-08-25T10:00:00.000Z'),
                  status: 'confirmed',
                  transactionId: null,
                  createdAt: new Date('2026-08-25T10:00:00.000Z'),
                  updatedAt: new Date('2026-08-25T10:00:00.000Z'),
                  version: 1,
                },
              ],
            };
          }
          return { rows: [] };
        }) as unknown as TransactionClient['query'],
      };

      const transferWithFee = await adapter.createTransfer(
        clientWithFee,
        WORKSPACE_ID,
        SUBJECT,
        {
          sourceAccountId: ACCOUNT_A,
          destinationAccountId: ACCOUNT_B,
          amount: { amountMinor: '5000', currency: 'USD' },
          occurredAt: '2026-08-25T10:00:00.000Z',
          fee: { amountMinor: '100', currency: 'USD' },
        },
      );
      expect(transferWithFee.fee).toEqual({
        amountMinor: '100',
        currency: 'USD',
      });
    });
  });
});
