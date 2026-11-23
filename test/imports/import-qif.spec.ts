import { describe, expect, it } from 'vitest';
import { parseImport } from '../../src/imports/import-parsers.js';

const transaction = "D2/ 9'26\nT-1,234.56\nPCoffee Shop\nMMemo\nN0102\n^\n";
const statement = (body: string) => Buffer.from(`!Type:Bank\n${body}`);

describe('QIF statements', () => {
  it('normalizes signed amounts, dates, payee/memo and reference for mapping', async () => {
    const bytes = Buffer.from(
      `\ufeff!Type:CCard\n${transaction}D2/10/2026\nT+0.10\nMRefund\n^\n`.replace(
        /\n/gu,
        '\r\n',
      ),
    );
    expect(await parseImport('qif', bytes)).toEqual([
      {
        rowNumber: 2,
        rawValues: ["2/ 9'26", '-1234.56', 'Coffee Shop', '0102'],
        parsedDate: '2026-02-09',
        parsedAmountMinor: '-123456',
        parsedDescription: 'Coffee Shop',
        classification: 'valid',
        error: null,
        sourceColumns: ['date', 'amount', 'description', 'reference'],
      },
      {
        rowNumber: 3,
        rawValues: ['2/10/2026', '0.1', 'Refund', ''],
        parsedDate: '2026-02-10',
        parsedAmountMinor: '10',
        parsedDescription: 'Refund',
        classification: 'valid',
        error: null,
        sourceColumns: ['date', 'amount', 'description', 'reference'],
      },
    ]);
  });

  it('accepts U amounts, prefers T when both are present, and preserves exact large amounts', async () => {
    const rows = await parseImport(
      'qif',
      statement(
        'D2026-02-09\nU-90,071,992,547,409.93\nMMemo only\nN0001\n^\n' +
          'D2-10-26\nU99.99\nT+0.10\nPRefund\n^\n',
      ),
    );
    expect(rows).toMatchObject([
      {
        parsedDate: '2026-02-09',
        parsedAmountMinor: '-9007199254740993',
        parsedDescription: 'Memo only',
        classification: 'valid',
        error: null,
      },
      {
        parsedDate: '2026-02-10',
        parsedAmountMinor: '10',
        parsedDescription: 'Refund',
        classification: 'valid',
        error: null,
      },
    ]);
  });

  it.each(['', '!Type:Bank\n'])(
    'rejects an empty statement (%j)',
    async (text) => {
      await expect(parseImport('qif', Buffer.from(text))).rejects.toThrow(
        'QIF statement is invalid or unsupported.',
      );
    },
  );

  it.each(['', 'T0.00001\n', 'T1e3\n', 'T9223372036854775808.00\n'])(
    'reports invalid calendar dates, amounts (%j) and missing descriptions as row errors',
    async (amount) => {
      const [row] = await parseImport(
        'qif',
        statement(`D2/30/2026\n${amount}^`),
      );
      expect(row).toMatchObject({
        classification: 'error',
        parsedDate: null,
        parsedAmountMinor: null,
        parsedDescription: null,
        error: {
          status: 422,
          code: 'import-row-invalid',
          detail:
            'date must be YYYY-MM-DD; amount must be valid for the statement format and ledger range; description is required',
        },
      });
    },
  );

  it.each([
    ['missing header', Buffer.from(transaction)],
    ['missing terminator', statement('D2/9/2026\nT1\nPTest')],
    ['repeated amount', statement('D2/9/2026\nT1\nT2\nPTest\n^')],
    [
      'another account section',
      statement(`${transaction}!Type:Bank\n${transaction}`),
    ],
  ])('rejects a malformed statement with %s', async (_, bytes) => {
    await expect(parseImport('qif', bytes)).rejects.toThrow(
      'QIF statement is invalid or unsupported.',
    );
  });

  it('bounds file size, line length and record count', async () => {
    await expect(
      parseImport('qif', Buffer.alloc(5 * 1024 * 1024 + 1)),
    ).rejects.toThrow('The uploaded file exceeds the maximum size.');
    await expect(
      parseImport('qif', statement(`P${'a'.repeat(100_000)}\n^`)),
    ).rejects.toThrow('Import lines may contain at most 100000 characters.');
    expect(
      await parseImport('qif', statement(transaction.repeat(10_000))),
    ).toHaveLength(10_000);
    await expect(
      parseImport('qif', statement(transaction.repeat(10_001))),
    ).rejects.toThrow('The import exceeds the maximum of 10000 rows.');
  });
});
