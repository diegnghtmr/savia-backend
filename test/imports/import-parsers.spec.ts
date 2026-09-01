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
    expect(normalizeImportDescription('İSTANBUL')).toBe('i̇stanbul');
  });
  it('counts malformed rows as errors', () => {
    expect(
      parseCsv(Buffer.from('date,amount,description\nnot-a-date,nope,\n')).at(0)
        ?.classification,
    ).toBe('error');
  });
  it.each([
    ['wider', '2026-01-01,10,Coffee,unexpected', 4],
    ['narrower', '2026-01-01,10', 2],
  ])('rejects a %s row/header width mismatch', (_, row, width) => {
    const parsed = parseCsv(
      Buffer.from(`date,amount,description\n${row}\n`),
    )[0];
    expect(parsed?.classification).toBe('error');
    expect(parsed?.error?.detail).toContain(`row has ${width} fields`);
  });
  it('handles empty, header-only and lone carriage-return files', () => {
    expect(parseCsv(Buffer.from(''))).toHaveLength(0);
    expect(parseCsv(Buffer.from('date,amount,description\n'))).toHaveLength(0);
    expect(parseCsv(Buffer.from('date,amount,description\r'))).toHaveLength(0);
  });
  it('rejects an unterminated quoted field', () => {
    expect(() =>
      parseCsv(Buffer.from('date,amount,description\n2026-01-01,1,"bad')),
    ).toThrow('unterminated');
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
  it('rejects invalid ZIP/XML before ExcelJS materializes it', async () => {
    await expect(parseXlsx(Buffer.from('not a zip'))).rejects.toThrow(
      'invalid',
    );
  });
  it('rejects excessive worksheets during parsing', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('one').addRow(['date', 'amount', 'description']);
    workbook.addWorksheet('two').addRow(['date', 'amount', 'description']);
    await expect(
      parseXlsx(Buffer.from(await workbook.xlsx.writeBuffer())),
    ).rejects.toThrow('worksheet');
  });
  it('rejects excessive cells per row during parsing', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook
      .addWorksheet('statement')
      .addRow(Array.from({ length: 101 }, () => 'x'));
    await expect(
      parseXlsx(Buffer.from(await workbook.xlsx.writeBuffer())),
    ).rejects.toThrow('cells');
  });
  it('rejects an expanded shared string before workbook materialization', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('statement');
    sheet.addRow(['date', 'amount', 'description']);
    sheet.addRow(['2026-01-01', 1, 'x'.repeat(100_001)]);
    await expect(
      parseXlsx(Buffer.from(await workbook.xlsx.writeBuffer())),
    ).rejects.toThrow('characters');
  });
});
