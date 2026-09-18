import type { QueryResult } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresTransactionAdapter } from '../../src/ledger/postgres-transaction.adapter.js';
import { PostgresImportAdapter } from '../../src/imports/postgres-import.adapter.js';
import { IMPORT_COMMIT_BATCH_SIZE } from '../../src/platform/import-batch-policy.js';
import {
  IMPORT_COMMIT_CALLBACK_TIMEOUT_MS,
  IMPORT_COMMIT_STATEMENT_TIMEOUT_MS,
  ImportService,
} from '../../src/imports/import.service.js';
import type { ImportJob, ImportStore } from '../../src/imports/import.port.js';
import type { IdempotencyStore } from '../../src/platform/idempotency.port.js';
import type { JobWriter } from '../../src/platform/job-writer.port.js';
import type {
  ImportedTransactionCommand,
  LedgerWriter,
} from '../../src/platform/ledger-writer.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';

function mockQueryResult<Row extends Record<string, unknown>>(
  rows: Row[],
): QueryResult<Row> {
  return {
    rows,
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
  };
}

describe('import commit statement bounding', () => {
  const BATCH_SIZE = IMPORT_COMMIT_BATCH_SIZE;

  it('shares a single batch-size source across adapters and service', () => {
    expect(PostgresTransactionAdapter.BATCH_SIZE).toBe(
      IMPORT_COMMIT_BATCH_SIZE,
    );
    expect(PostgresImportAdapter.BATCH_SIZE).toBe(IMPORT_COMMIT_BATCH_SIZE);
    expect(IMPORT_COMMIT_BATCH_SIZE).toBe(2_500);
  });

  it('pins separate statement and callback timeouts with derived arithmetic', () => {
    const batches = Math.ceil(10_000 / IMPORT_COMMIT_BATCH_SIZE);
    const budgetedPerBatchMs = 1_000;
    const fixedOverheadMs = 1_000;
    const derivedCallbackTimeoutMs =
      batches * budgetedPerBatchMs + fixedOverheadMs;

    expect(IMPORT_COMMIT_STATEMENT_TIMEOUT_MS).toBe(2_000);
    expect(IMPORT_COMMIT_STATEMENT_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
    expect(IMPORT_COMMIT_CALLBACK_TIMEOUT_MS).toBe(derivedCallbackTimeoutMs);
    expect(IMPORT_COMMIT_CALLBACK_TIMEOUT_MS).toBe(5_000);
    expect(IMPORT_COMMIT_STATEMENT_TIMEOUT_MS).not.toBe(
      IMPORT_COMMIT_CALLBACK_TIMEOUT_MS,
    );
  });

  const dummyTerminalJob: Record<string, unknown> = {
    id: '00000000-0000-4000-8000-000000000099',
    type: 'import_commit',
    status: 'completed',
    progressPercent: 100,
    resultResourceId: 'res-1',
    error: null,
    createdAt: '2026-01-01T00:00:00Z',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:00:00Z',
  };

  it('bounds statement round-trips by ceil(N / batch) and chunks row count', async () => {
    const adapter = new PostgresTransactionAdapter();
    const statements: Array<{ sql: string; rowCount: number }> = [];
    const client: TransactionClient = {
      query: async <Row extends Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ): Promise<QueryResult<Row>> => {
        const rowCount = Array.isArray(values?.[0]) ? values[0].length : 1;
        statements.push({ sql: text, rowCount });
        const rows = Array.isArray(values?.[0])
          ? values[0].map((_, index) => ({
              id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
              account_id: '00000000-0000-4000-8000-000000000001',
              amount_minor: '100',
              currency: 'USD',
              occurred_at: new Date('2026-01-01T00:00:00Z'),
            }))
          : [];
        return mockQueryResult(rows as unknown as Row[]);
      },
    };

    const count = 5_000;
    const commands: ImportedTransactionCommand[] = Array.from(
      { length: count },
      (_, i) => ({
        accountId: '00000000-0000-4000-8000-000000000001',
        amountMinor: '100',
        currency: 'USD',
        occurredAt: '2026-01-01T00:00:00.000Z',
        description: `Coffee ${i}`,
        importJobId: '00000000-0000-4000-8000-000000000099',
      }),
    );

    await adapter.createImportedTransactions(
      client,
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-0000-0000-000000000003',
      commands,
    );

    const transactionInserts = statements.filter((s) =>
      s.sql.includes('insert into public.transactions'),
    );
    const postingInserts = statements.filter((s) =>
      s.sql.includes('insert into public.ledger_postings'),
    );

    const expectedBatches = Math.ceil(count / BATCH_SIZE);
    expect(transactionInserts).toHaveLength(expectedBatches);
    expect(postingInserts).toHaveLength(expectedBatches);
    for (const insert of transactionInserts) {
      expect(insert.rowCount).toBeLessThanOrEqual(BATCH_SIZE);
    }
  });

  it('commitImport delegates to batched ledger write without per-row round-trips', async () => {
    let perRowCalls = 0;
    let batchCalls = 0;
    let batchRowCount = 0;

    const dummyTx = {
      run: async <T>(
        _subject: string,
        cb: (c: TransactionClient) => Promise<T>,
      ): Promise<T> =>
        cb({
          query: async <Row extends Record<string, unknown>>() =>
            mockQueryResult<Row>([]),
        }),
      runRead: async <T>(
        _subject: string,
        cb: (c: TransactionClient) => Promise<T>,
      ): Promise<T> =>
        cb({
          query: async <Row extends Record<string, unknown>>() =>
            mockQueryResult<Row>([]),
        }),
    };

    const count = 100;
    const store: ImportStore = {
      readActiveRole: async () => 'owner',
      createId: () => 'id',
      createJob: async () => ({
        id: 'job-1',
        status: 'awaiting_mapping',
        fileName: 'test.csv',
        accountId: null,
        detectedFormat: 'csv',
        totalRows: count,
        validRows: count,
        duplicateRows: 0,
        errorRows: 0,
        createdAt: '2026-01-01T00:00:00Z',
        sourceColumns: ['date', 'amount', 'description'],
      }),
      find: async () => ({
        id: 'job-1',
        status: 'awaiting_mapping',
        fileName: 'test.csv',
        accountId: null,
        detectedFormat: 'csv',
        totalRows: count,
        validRows: count,
        duplicateRows: 0,
        errorRows: 0,
        createdAt: '2026-01-01T00:00:00Z',
        sourceColumns: ['date', 'amount', 'description'],
      }),
      lockAccount: async () => ({ status: 'active', currency: 'USD' }),
      lockWorkspace: async () => {},
      findRows: async () =>
        Array.from({ length: count }, (_, i) => ({
          rowNumber: i + 2,
          rawValues: ['2026-01-01', 100, `Item ${i}`],
          parsedDate: '2026-01-01',
          parsedAmountMinor: 100,
          parsedDescription: `Item ${i}`,
          classification: 'valid' as const,
        })),
      complete: async () => ({
        id: 'job-1',
        status: 'completed',
        fileName: 'test.csv',
        accountId: '00000000-0000-4000-8000-000000000004',
        detectedFormat: 'csv',
        totalRows: count,
        validRows: count,
        duplicateRows: 0,
        errorRows: 0,
        createdAt: '2026-01-01T00:00:00Z',
        sourceColumns: ['date', 'amount', 'description'],
      }),
      findExisting: async () => false,
      findExistingBatch: async () => new Set(),
      findImportedTransactions: async () => [],
    };

    const idem: IdempotencyStore = {
      read: async () => undefined,
      write: async () => true,
    };
    const jobs = {
      createTerminalJob: async () => dummyTerminalJob,
    } as unknown as JobWriter;
    const ledger: LedgerWriter = {
      createTransaction: async () => {},
      createAdjustmentTransaction: async () => {},
      createImportedTransaction: async () => {
        perRowCalls += 1;
      },
      createImportedTransactions: async (_c, _w, _s, commands) => {
        batchCalls += 1;
        batchRowCount += commands.length;
      },
      voidTransaction: async () => {},
    };

    const service = new ImportService(
      dummyTx,
      store,
      idem,
      jobs,
      ledger,
      dummyTx,
    );
    const result = await service.commitImport(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      {
        accountId: '00000000-0000-4000-8000-000000000004',
        columnMapping: {
          date: 'date',
          amount: 'amount',
          description: 'description',
        },
      },
      'key-1',
    );

    expect(result.kind).toBe('ok');
    expect(perRowCalls).toBe(0);
    expect(batchCalls).toBe(1);
    expect(batchRowCount).toBe(count);
  });

  it('commits only rows with valid classification and ignores error or duplicate rows', async () => {
    let committedCommands: ImportedTransactionCommand[] = [];

    const dummyTx = {
      run: async <T>(
        _subject: string,
        cb: (c: TransactionClient) => Promise<T>,
      ): Promise<T> =>
        cb({
          query: async <Row extends Record<string, unknown>>() =>
            mockQueryResult<Row>([]),
        }),
      runRead: async <T>(
        _subject: string,
        cb: (c: TransactionClient) => Promise<T>,
      ): Promise<T> =>
        cb({
          query: async <Row extends Record<string, unknown>>() =>
            mockQueryResult<Row>([]),
        }),
    };

    const dummyImportJob: ImportJob = {
      id: 'job-1',
      status: 'awaiting_mapping',
      fileName: 'test.csv',
      accountId: null,
      detectedFormat: 'csv',
      totalRows: 3,
      validRows: 1,
      duplicateRows: 1,
      errorRows: 1,
      createdAt: '2026-01-01T00:00:00Z',
      sourceColumns: ['date', 'amount', 'description'],
    };

    const store: ImportStore = {
      readActiveRole: async () => 'owner',
      createId: () => 'id',
      createJob: async () => dummyImportJob,
      find: async () => dummyImportJob,
      lockAccount: async () => ({ status: 'active', currency: 'USD' }),
      lockWorkspace: async () => {},
      findRows: async () => [
        {
          rowNumber: 2,
          rawValues: ['2026-01-01', 100, 'Valid item'],
          parsedDate: '2026-01-01',
          parsedAmountMinor: 100,
          parsedDescription: 'Valid item',
          classification: 'valid' as const,
        },
        {
          rowNumber: 3,
          rawValues: ['2026-01-01', 200, 'Error item'],
          parsedDate: '2026-01-01',
          parsedAmountMinor: 200,
          parsedDescription: 'Error item',
          classification: 'error' as const,
        },
        {
          rowNumber: 4,
          rawValues: ['2026-01-01', 300, 'Duplicate item'],
          parsedDate: '2026-01-01',
          parsedAmountMinor: 300,
          parsedDescription: 'Duplicate item',
          classification: 'duplicate' as const,
        },
      ],
      complete: async () => dummyImportJob,
      findExisting: async () => false,
      findExistingBatch: async () => new Set(),
      findImportedTransactions: async () => [],
    };

    const idem: IdempotencyStore = {
      read: async () => undefined,
      write: async () => true,
    };
    const jobs = {
      createTerminalJob: async () => dummyTerminalJob,
    } as unknown as JobWriter;
    const ledger: LedgerWriter = {
      createTransaction: async () => {},
      createAdjustmentTransaction: async () => {},
      createImportedTransaction: async () => {},
      createImportedTransactions: async (_c, _w, _s, commands) => {
        committedCommands = [...commands];
      },
      voidTransaction: async () => {},
    };

    const service = new ImportService(
      dummyTx,
      store,
      idem,
      jobs,
      ledger,
      dummyTx,
    );
    const result = await service.commitImport(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      {
        accountId: '00000000-0000-4000-8000-000000000004',
        columnMapping: {
          date: 'date',
          amount: 'amount',
          description: 'description',
        },
      },
      'key-1',
    );

    expect(result.kind).toBe('ok');
    expect(committedCommands).toHaveLength(1);
    expect(committedCommands[0].description).toBe('Valid item');
  });
});
