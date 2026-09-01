// Migrations under test: 202608310003_export_jobs.sql, 202608310004_export_storage.sql
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  createExportCommand,
  ExportCommandValidationError,
} from '../../src/exports/export-command.js';
import {
  serializeCsv,
  serializeJsonBackup,
  serializeXlsx,
} from '../../src/exports/export-serializers.js';

describe('export command validation', () => {
  it('accepts every format and implemented resource', () => {
    expect(createExportCommand({ format: 'csv' })).toMatchObject({
      resource: 'all',
    });
    expect(
      createExportCommand({ format: 'json_backup', resource: 'transactions' })
        .format,
    ).toBe('json_backup');
    expect(
      createExportCommand({ format: 'xlsx', resource: 'accounts' }).format,
    ).toBe('xlsx');
  });
  it.each([
    [
      {
        format: 'csv',
        resource: 'accounts',
        resourceId: '00000000-0000-0000-0000-000000000001',
      },
      'resourceId',
    ],
    [{ format: 'csv', from: '2026-09-02', to: '2026-09-01' }, 'from'],
  ])('rejects constrained input %#', (body, field) => {
    expect(() => createExportCommand(body)).toThrow(
      ExportCommandValidationError,
    );
    try {
      createExportCommand(body);
    } catch (error) {
      expect(
        (error as ExportCommandValidationError).violations.some(
          (v) => v.field === field,
        ),
      ).toBe(true);
    }
  });
});

describe('export serializers', () => {
  const rows = [{ id: '1', name: 'A', amount: 10 }];
  it('creates parseable CSV', () =>
    expect(serializeCsv(rows).toString()).toContain('id,name,amount'));
  it('neutralizes formula-like values without changing numeric negatives', () => {
    const csv = serializeCsv([
      {
        formula: '=SUM(A1)',
        plus: '+cmd',
        minus: '-cmd',
        at: '@cmd',
        tab: '\tcmd',
        cr: '\rcmd',
        number: -5000,
      },
    ]).toString();
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).toContain("'+cmd");
    expect(csv).toContain("'-cmd");
    expect(csv).toContain("'@cmd");
    expect(csv).toContain("'\tcmd");
    expect(csv).toContain("'\rcmd");
    expect(csv).toContain('"-5000"');
  });
  it('creates parseable JSON backup', () =>
    expect(
      JSON.parse(
        serializeJsonBackup({ accounts: rows, transactions: [] }).toString(),
      ).accounts,
    ).toEqual(rows));
  it('creates a real XLSX workbook', async () => {
    const buffer = await serializeXlsx(rows);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const sheet = workbook.getWorksheet('export');
    expect(sheet).toBeDefined();
    const headers = sheet!.getRow(1).values;
    expect(Array.isArray(headers) ? headers.slice(1) : headers).toEqual([
      'id',
      'name',
      'amount',
    ]);
    expect(sheet!.rowCount).toBe(2);
    expect(sheet!.getCell('B2').value).toBe('A');
    expect(sheet!.getCell('C2').value).toBe(10);
  });
});
