import { describe, expect, it } from 'vitest';
import { parseImport } from '../../src/imports/import-parsers.js';

const bank = (currency: string, records: string) =>
  `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>${currency}<BANKTRANLIST>${records}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
const header =
  'OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\nCHARSET:1252\r\n\r\n';
const xml = (content: string) =>
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n<?OFX OFXHEADER="200" VERSION="211"?>\n${content}`,
  );
const debit =
  '<STMTTRN><DTPOSTED>20260209235500.000[-5:EST]</DTPOSTED><TRNAMT>-12.34</TRNAMT><FITID>001</FITID><NAME>A &amp; B</NAME></STMTTRN>';

function normalized(
  date: string,
  amount: string,
  name: string,
  reference: string,
  currency: string,
  fitid: string,
) {
  return {
    rowNumber: 2,
    rawValues: [date, amount, name, reference, currency, fitid],
    parsedDate: date,
    parsedAmountMinor: amount,
    parsedDescription: name,
    classification: 'valid',
    error: null,
    sourceColumns: [
      'date',
      'amount',
      'description',
      'reference',
      'currency',
      'fitid',
    ],
  };
}

describe('OFX and QFX statements', () => {
  it('reads OFX 1.x SGML scalar tags without closing tags and honors Windows-1252', async () => {
    const record =
      '<STMTTRN>\n<DTPOSTED>20260209\n<TRNAMT>-500\n<FITID>0007\n<NAME>Café &amp; tea\n</STMTTRN>';
    const rows = await parseImport(
      'ofx',
      Buffer.from(`${header}${bank('<CURDEF>JPY', record)}`, 'latin1'),
    );
    expect(rows).toEqual([
      normalized('2026-02-09', '-500', 'Café & tea', '0007', 'JPY', '0007'),
    ]);
  });

  it('reads OFX 2.x XML, preserving the statement day and signed minor units', async () => {
    expect(
      await parseImport('ofx', xml(bank('<CURDEF>USD</CURDEF>', debit))),
    ).toEqual([
      normalized('2026-02-09', '-1234', 'A & B', '001', 'USD', '001'),
    ]);
  });

  it('reads QFX credit-card XML with three-decimal currency and a reference fallback', async () => {
    const bytes = xml(
      '<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>KWD</CURDEF><BANKTRANLIST><STMTTRN><DTPOSTED>20260210</DTPOSTED><TRNAMT>+1.2340</TRNAMT><REFNUM>0002</REFNUM><MEMO>Credit &#x26; refund</MEMO></STMTTRN></BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>',
    );
    expect(await parseImport('qfx', bytes)).toEqual([
      normalized('2026-02-10', '1234', 'Credit & refund', '0002', 'KWD', ''),
    ]);
  });

  it('preserves a signed amount above 2^53 through normalization', async () => {
    const bytes = xml(
      bank(
        '<CURDEF>USD</CURDEF>',
        debit.replace('-12.34', '-90071992547409.93'),
      ),
    );
    expect(await parseImport('ofx', bytes)).toMatchObject([
      {
        parsedAmountMinor: '-9007199254740993',
        classification: 'valid',
        error: null,
      },
    ]);
  });

  it('reads an omitted empty SGML NAME tag and falls back to MEMO', async () => {
    const records =
      '<STMTTRN><DTPOSTED>20260209<TRNAMT>+2.00<NAME>\n<MEMO>Refund</STMTTRN>';
    const bytes = Buffer.from(header + bank('<CURDEF>USD', records));
    expect(await parseImport('ofx', bytes)).toMatchObject([
      {
        parsedAmountMinor: '200',
        parsedDescription: 'Refund',
        classification: 'valid',
      },
    ]);
  });

  it.each(['', bank('<CURDEF>USD</CURDEF>', '')])(
    'rejects an empty statement (%j)',
    async (text) => {
      await expect(parseImport('ofx', Buffer.from(text))).rejects.toThrow(
        'OFX statement is invalid or unsupported.',
      );
    },
  );

  it('marks invalid datetime, precision and missing description as row errors', async () => {
    const [row] = await parseImport(
      'ofx',
      xml(
        bank(
          '<CURDEF>USD</CURDEF>',
          '<STMTTRN><DTPOSTED>20260230246000</DTPOSTED><TRNAMT>1.011</TRNAMT></STMTTRN>',
        ),
      ),
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
  });

  it.each([
    [
      'OFX XML with unclosed scalar',
      'ofx',
      xml(bank('<CURDEF>USD</CURDEF>', debit.replace('</NAME>', ''))),
    ],
    [
      'OFX SGML with unclosed aggregate',
      'ofx',
      Buffer.from(
        header + bank('<CURDEF>USD', debit.replace('</STMTTRN>', '')),
      ),
    ],
    [
      'QFX with a malformed closing tag',
      'qfx',
      xml(bank('<CURDEF>USD</CURDEF>', debit.replace('</NAME>', '</MEMO>'))),
    ],
    [
      'QFX with an entity declaration',
      'qfx',
      xml(`<!DOCTYPE OFX>${bank('<CURDEF>USD</CURDEF>', debit)}`),
    ],
    [
      'OFX with an unknown entity',
      'ofx',
      xml(bank('<CURDEF>USD</CURDEF>', debit.replace('&amp;', '&custom;'))),
    ],
    [
      'OFX with unsupported currency',
      'ofx',
      xml(bank('<CURDEF>ZZZ</CURDEF>', debit)),
    ],
    [
      'OFX exceeding nesting limits',
      'ofx',
      xml(`<OFX>${'<N>'.repeat(40)}${'</N>'.repeat(40)}</OFX>`),
    ],
    [
      'OFX with a repeated transaction list',
      'ofx',
      xml(
        bank(
          '<CURDEF>USD</CURDEF>',
          `${debit}</BANKTRANLIST><BANKTRANLIST>${debit}`,
        ),
      ),
    ],
  ] as const)('rejects %s', async (_, format, bytes) => {
    await expect(parseImport(format, bytes)).rejects.toThrow(
      'OFX statement is invalid or unsupported.',
    );
  });

  it('enforces the line and row bounds for OFX files', async () => {
    const currency = '<CURDEF>USD</CURDEF>';
    await expect(
      parseImport(
        'qfx',
        xml(bank(currency, debit.replace('A &amp; B', 'x'.repeat(100_001)))),
      ),
    ).rejects.toThrow('Import lines may contain at most 100000 characters.');
    const atLimit = xml(bank(currency, `${debit}\n`.repeat(10_000)));
    expect(await parseImport('ofx', atLimit)).toHaveLength(10_000);
    await expect(
      parseImport('ofx', xml(bank(currency, `${debit}\n`.repeat(10_001)))),
    ).rejects.toThrow('The import exceeds the maximum of 10000 rows.');
  });
});
