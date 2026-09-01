import ExcelJS from 'exceljs';
import type { ImportFormat, ParsedImportRow } from './import.port.js';

export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 10_000;
export function normalizeImportDescription(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}
function fieldIndex(
  headers: readonly string[],
  names: readonly string[],
): number {
  return headers.findIndex((h) => names.includes(h.toLocaleLowerCase().trim()));
}
function parseRows(
  values: readonly (readonly unknown[])[],
): readonly ParsedImportRow[] {
  const headers = (values[0] ?? []).map((v) => String(v ?? ''));
  const dateAt = fieldIndex(headers, ['date', 'fecha', 'occurred_at']);
  const amountAt = fieldIndex(headers, [
    'amount',
    'amount_minor',
    'importe',
    'value',
  ]);
  const descriptionAt = fieldIndex(headers, [
    'description',
    'descripcion',
    'memo',
    'payee',
  ]);
  return values.slice(1).map((raw, index) => {
    const date = dateAt < 0 ? '' : String(raw[dateAt] ?? '').trim();
    const amountText =
      amountAt < 0
        ? ''
        : String(raw[amountAt] ?? '')
            .trim()
            .replace(',', '.');
    const description =
      descriptionAt < 0 ? '' : String(raw[descriptionAt] ?? '').trim();
    const amount = Number(amountText);
    const errors: string[] = [];
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
      Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())
    )
      errors.push('date must be YYYY-MM-DD');
    if (!Number.isSafeInteger(amount) || !Number.isFinite(amount))
      errors.push('amount must be a safe integer minor-unit amount');
    if (!description) errors.push('description is required');
    return {
      rowNumber: index + 2,
      rawValues: raw,
      parsedDate: errors.length ? null : date,
      parsedAmountMinor: errors.length ? null : amount,
      parsedDescription: errors.length ? null : description,
      classification: errors.length ? 'error' : 'valid',
      error: errors.length
        ? {
            type: 'https://savia.app/problems/import-row-invalid',
            title: 'Import row is invalid',
            status: 422,
            code: 'import-row-invalid',
            traceId: 'import',
            detail: errors.join('; '),
          }
        : null,
    };
  });
}
export function parseCsv(bytes: Buffer): readonly ParsedImportRow[] {
  const text = bytes.toString('utf8').replace(/^\uFEFF/u, '');
  const rows: string[][] = [[]];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        value += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else value += c;
    } else if (c === '"' && value === '') quoted = true;
    else if (c === ',') {
      rows.at(-1)!.push(value);
      value = '';
    } else if (c === '\n' || c === '\r') {
      rows.at(-1)!.push(value);
      value = '';
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      if (i + 1 < text.length) rows.push([]);
    } else value += c;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  if (value || rows.at(-1)!.length) rows.at(-1)!.push(value);
  return parseRows(rows.filter((r) => r.some((v) => v !== '')));
}
export async function parseXlsx(
  bytes: Buffer,
): Promise<readonly ParsedImportRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as never);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('XLSX contains no worksheets.');
  const rows: unknown[][] = [];
  sheet.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
  return parseRows(rows);
}
export async function parseImport(
  format: ImportFormat,
  bytes: Buffer,
): Promise<readonly ParsedImportRow[]> {
  if (format === 'csv') return parseCsv(bytes);
  if (format === 'xlsx') return parseXlsx(bytes);
  throw new Error(
    `The declared ${format.toUpperCase()} format is not yet supported.`,
  );
}
