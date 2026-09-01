import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  normalizeImportDescription,
  parseCsv,
  parseXlsx,
} from '../../src/imports/import-parsers.js';

describe('import parsers', () => {
  it('parses quoted commas, newlines, doubled quotes, BOM and CRLF', () => {
    const rows = parseCsv(
      Buffer.from(
        '\ufeffdate,amount,description\r\n2026-01-01,10,"A, B"\r\n2026-01-02,20,"line 1\nline 2\r\nsaid ""yes"""\r\n',
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.parsedDescription).toBe('A, B');
    expect(rows[1]?.parsedDescription).toBe('line 1\nline 2\r\nsaid "yes"');
  });
  it('normalizes case and collapsed whitespace for duplicate identity', () => {
    expect(normalizeImportDescription('  Coffee   Shop ')).toBe('coffee shop');
  });
  it('counts malformed rows as errors', () => {
    expect(
      parseCsv(Buffer.from('date,amount,description\nnot-a-date,nope,\n')).at(0)
        ?.classification,
    ).toBe('error');
  });
  it('reads an XLSX workbook instead of inspecting a byte fixture', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('statement');
    sheet.addRow(['date', 'amount', 'description']);
    sheet.addRow(['2026-01-01', 1250, 'Salary']);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const rows = await parseXlsx(bytes);
    expect(rows).toEqual([
      expect.objectContaining({
        parsedDate: '2026-01-01',
        parsedAmountMinor: 1250,
        parsedDescription: 'Salary',
        classification: 'valid',
      }),
    ]);
  });
});
