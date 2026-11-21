import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import type {
  CommitImportCommand,
  ImportCommitRow,
  ImportJob,
  ImportStore,
} from '../../src/imports/import.port.js';
import {
  ImportService,
  type ImportTransaction,
} from '../../src/imports/import.service.js';
import type { JobWriter } from '../../src/platform/job-writer.port.js';
import type {
  ImportedTransactionCommand,
  LedgerWriter,
} from '../../src/platform/ledger-writer.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';

const columns = ['date', 'amount', 'description'];
const records = [
  ['2026-04-05', -125, 'Coffee'],
  ['2026-04-05', -125, ' coffee '],
  ['2026-04-06', 300, 'Already booked'],
  ['invalid date', 50, 'Invalid row'],
];

async function fixture(format: 'csv' | 'xlsx'): Promise<Buffer> {
  if (format === 'csv') {
    return Buffer.from(
      [columns, ...records].map((row) => row.join(',')).join('\n'),
    );
  }
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('transactions');
  sheet.addRows([columns, ...records]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function harness() {
  let job: ImportJob | undefined;
  let rows: readonly ImportCommitRow[] = [];
  const booked: ImportedTransactionCommand[] = [];
  const client: TransactionClient = {
    query: async () => {
      throw new Error('Unexpected SQL query');
    },
  };
  const run: ImportTransaction['run'] = async (_subject, callback) =>
    callback(client);
  const findExistingBatch = vi.fn<ImportStore['findExistingBatch']>(
    async (_client, _workspace, _account, prepared) =>
      new Set(
        prepared.flatMap((row, index) =>
          row.description === 'Already booked' ? [index] : [],
        ),
      ),
  );
  const store: ImportStore = {
    readActiveRole: async () => 'owner',
    createId: () => 'unused',
    createJob: async (
      _client,
      _workspace,
      _subject,
      id,
      fileName,
      detectedFormat,
      parsed,
      sourceColumns,
      counts,
    ) => {
      rows = parsed;
      job = {
        id,
        fileName,
        detectedFormat,
        sourceColumns,
        status: 'awaiting_mapping',
        accountId: null,
        totalRows: counts.total,
        validRows: counts.valid,
        duplicateRows: counts.duplicate,
        errorRows: counts.errors,
        createdAt: '2026-01-01T00:00:00Z',
      };
      return job;
    },
    lockAccount: async () => ({ status: 'active', currency: 'USD' }),
    lockWorkspace: async () => {},
    findRows: async () => rows,
    findExisting: async () => false,
    findExistingBatch,
    findImportedTransactions: async () => [],
    complete: async (_client, _workspace, _id, accountId, status) => {
      if (job) job = { ...job, status, accountId };
      return job;
    },
    find: async () => job,
  };
  const ledger: LedgerWriter = {
    createTransaction: async () => {},
    createAdjustmentTransaction: async () => {},
    createImportedTransaction: async () => {},
    createImportedTransactions: async (_client, _ws, _actor, batch) => {
      booked.push(...batch);
    },
    voidTransaction: async () => {},
  };
  const unexpectedJobCall = async () => {
    throw new Error('Unexpected job operation');
  };
  const jobs: JobWriter = {
    createTerminalJob: async () => ({ status: 'completed' }),
    createQueuedJob: unexpectedJobCall,
    transitionToProcessing: unexpectedJobCall,
    completeJob: unexpectedJobCall,
    failJob: unexpectedJobCall,
    deadLetter: unexpectedJobCall,
    findJobById: unexpectedJobCall,
  };
  const imports = new ImportService(
    { run, runRead: run },
    store,
    { read: async () => undefined, write: async () => true },
    jobs,
    ledger,
  );
  return {
    booked,
    findExistingBatch,
    upload: async (fileName: string, bytes: Buffer) => {
      const result = await imports.createImportJob(
        'subject',
        'workspace',
        { fileName, bytes, formatHint: null },
        'upload-key',
      );
      if (result.kind !== 'created') throw new Error(JSON.stringify(result));
      return result.job;
    },
    commit: (id: string, overrides: Partial<CommitImportCommand> = {}) =>
      imports.commitImport(
        'subject',
        'workspace',
        id,
        {
          accountId: 'account',
          columnMapping: {
            date: 'date',
            amount: 'amount',
            description: 'description',
          },
          ...overrides,
        },
        'commit-key',
      ),
  };
}

describe('QIF commit date mapping', () => {
  it.each([
    ['04/05/2026', 'DD/MM/YYYY', '2026-05-04'],
    ['14/05/2026', 'DD/MM/YYYY', '2026-05-14'],
    ['04/05/2026', undefined, '2026-04-05'],
  ])('books %s with dateFormat %s on %s', async (source, dateFormat, date) => {
    const imports = harness();
    const job = await imports.upload(
      'bank.qif',
      Buffer.from(`!Type:Bank\nD${source}\nT-1.25\nPPayee\n^\n`),
    );
    expect(job).toMatchObject({ validRows: 1, errorRows: 0 });
    expect(await imports.commit(job.id, { dateFormat })).toMatchObject({
      kind: 'ok',
    });
    expect(imports.booked).toEqual([
      {
        accountId: 'account',
        amountMinor: '-125',
        currency: 'USD',
        occurredAt: `${date}T00:00:00.000Z`,
        description: 'Payee',
        importJobId: job.id,
      },
    ]);
  });
});

describe('CSV/XLSX parity', () => {
  it.each(['csv', 'xlsx'] as const)(
    'keeps upload counts and default/true deduplication in %s',
    async (format) => {
      const bytes = await fixture(format);
      for (const skipDuplicateCandidates of [undefined, true]) {
        const imports = harness();
        const job = await imports.upload(`bank.${format}`, bytes);
        expect(job).toMatchObject({
          detectedFormat: format,
          sourceColumns: columns,
          totalRows: 4,
          validRows: 2,
          duplicateRows: 1,
          errorRows: 1,
        });
        expect(
          await imports.commit(job.id, { skipDuplicateCandidates }),
        ).toMatchObject({ kind: 'ok' });
        expect(imports.findExistingBatch).toHaveBeenCalledOnce();
        expect(imports.booked).toEqual([
          {
            accountId: 'account',
            amountMinor: '-125',
            currency: 'USD',
            occurredAt: '2026-04-05T00:00:00.000Z',
            description: 'Coffee',
            importJobId: job.id,
          },
        ]);
      }
    },
  );
});

it('retains CSV duplicates when skipping is disabled', async () => {
  const imports = harness();
  const job = await imports.upload('bank.csv', await fixture('csv'));
  expect(job).toMatchObject({ validRows: 2, duplicateRows: 1, errorRows: 1 });
  expect(
    await imports.commit(job.id, { skipDuplicateCandidates: false }),
  ).toMatchObject({ kind: 'ok' });
  expect(imports.findExistingBatch).not.toHaveBeenCalled();
  expect(imports.booked.map((transaction) => transaction.description)).toEqual([
    'Coffee',
    'coffee',
    'Already booked',
  ]);
});
