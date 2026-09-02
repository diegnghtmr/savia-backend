import ExcelJS from 'exceljs';
import type { ExportFormat, ExportRows } from './export.port.js';
function columns(rows: readonly Record<string, unknown>[]): string[] {
  return [...new Set(rows.flatMap((r) => Object.keys(r)))];
}
export function serializeCsv(rows: readonly Record<string, unknown>[]): Buffer {
  const cols = columns(rows);
  const neutralize = (value: string): string => {
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return value;
    return /^[=+\-@]|^[\t\r]/.test(value) ? `'${value}` : value;
  };
  const esc = (v: unknown) =>
    `"${neutralize(String(v ?? '')).replaceAll('"', '""')}"`;
  return Buffer.from(
    [
      cols.join(','),
      ...rows.map((r) => cols.map((c) => esc(r[c])).join(',')),
    ].join('\n'),
  );
}
export function serializeJsonBackup(rows: ExportRows): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        accounts: rows.accounts,
        transactions: rows.transactions,
      },
      null,
      2,
    ),
  );
}
export async function serializeXlsx(
  rows: readonly Record<string, unknown>[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('export');
  const cols = columns(rows);
  sheet.addRow(cols);
  for (const row of rows) sheet.addRow(cols.map((c) => row[c] ?? null));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
export async function serialize(
  format: ExportFormat,
  rows: ExportRows,
): Promise<{ content: Buffer; contentType: string; extension: string }> {
  if (format === 'csv')
    return {
      content: serializeCsv([...rows.accounts, ...rows.transactions]),
      contentType: 'text/csv',
      extension: 'csv',
    };
  if (format === 'json_backup')
    return {
      content: serializeJsonBackup(rows),
      contentType: 'application/json',
      extension: 'json',
    };
  return {
    content: await serializeXlsx([...rows.accounts, ...rows.transactions]),
    contentType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx',
  };
}
