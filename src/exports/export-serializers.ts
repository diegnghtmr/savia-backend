import ExcelJS from 'exceljs';
import { escapeCsvField } from '../platform/csv.js';
import { DeliveryDeadlineExceededError } from '../platform/delivery-deadline.js';
import type { ExportFormat, ExportRows } from './export.port.js';

export interface SerializeExportOptions {
  readonly signal?: AbortSignal;
  readonly remainingMs?: () => number;
  readonly asOf?: string;
}

function isRenderBudgetExhausted(options?: SerializeExportOptions): boolean {
  if (options?.signal?.aborted) {
    return true;
  }
  return options?.remainingMs !== undefined && options.remainingMs() <= 0;
}

function throwIfRenderBudgetExhausted(options?: SerializeExportOptions): void {
  if (isRenderBudgetExhausted(options)) {
    throw new DeliveryDeadlineExceededError(
      'Export rendering exceeded the delivery work cap.',
    );
  }
}

const JSON_ROW_BATCH_SIZE = 250;

function columns(rows: readonly Record<string, unknown>[]): string[] {
  return [...new Set(rows.flatMap((r) => Object.keys(r)))];
}

export function serializeCsv(
  rows: readonly Record<string, unknown>[],
  options?: SerializeExportOptions,
): Buffer {
  throwIfRenderBudgetExhausted(options);
  const cols = columns(rows);
  const neutralize = (value: string): string => {
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return value;
    return /^[=+\-@]|^[\t\r]/.test(value) ? `'${value}` : value;
  };
  const esc = (v: unknown) => escapeCsvField(v, neutralize);
  const lines: string[] = [cols.join(',')];
  for (let index = 0; index < rows.length; index += 1) {
    throwIfRenderBudgetExhausted(options);
    const row = rows[index];
    if (row === undefined) continue;
    lines.push(cols.map((c) => esc(row[c])).join(','));
  }
  return Buffer.from(lines.join('\n'));
}

function serializeArrayBatched(
  items: readonly Record<string, unknown>[],
  options?: SerializeExportOptions,
): string {
  if (items.length === 0) {
    return '[]';
  }
  const chunks: string[] = [];
  for (let i = 0; i < items.length; i += JSON_ROW_BATCH_SIZE) {
    throwIfRenderBudgetExhausted(options);
    const batch = items.slice(i, i + JSON_ROW_BATCH_SIZE);
    const json = JSON.stringify(batch, null, 2);
    const inner = json.slice(2, -2);
    const indented = inner
      .split('\n')
      .map((line) => '  ' + line)
      .join('\n');
    chunks.push(indented);
  }
  return '[\n' + chunks.join(',\n') + '\n  ]';
}

export function serializeJsonBackup(
  rows: ExportRows,
  options?: SerializeExportOptions,
): Buffer {
  throwIfRenderBudgetExhausted(options);
  const exportedAt = options?.asOf ?? new Date().toISOString();
  const accountsJson = serializeArrayBatched(rows.accounts, options);
  const transactionsJson = serializeArrayBatched(rows.transactions, options);
  const content = `{\n  "exportedAt": ${JSON.stringify(exportedAt)},\n  "accounts": ${accountsJson},\n  "transactions": ${transactionsJson}\n}`;
  return Buffer.from(content);
}

export async function serializeXlsx(
  rows: readonly Record<string, unknown>[],
  options?: SerializeExportOptions,
): Promise<Buffer> {
  throwIfRenderBudgetExhausted(options);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('export');
  const cols = columns(rows);
  sheet.addRow(cols);
  for (const row of rows) {
    throwIfRenderBudgetExhausted(options);
    sheet.addRow(cols.map((c) => row[c] ?? null));
  }
  // Check immediately before writeBuffer(); ExcelJS writeBuffer() itself cannot be interrupted by AbortSignal.
  throwIfRenderBudgetExhausted(options);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function serialize(
  format: ExportFormat,
  rows: ExportRows,
  options?: SerializeExportOptions,
): Promise<{ content: Buffer; contentType: string; extension: string }> {
  if (format === 'csv')
    return {
      content: serializeCsv([...rows.accounts, ...rows.transactions], options),
      contentType: 'text/csv',
      extension: 'csv',
    };
  if (format === 'json_backup')
    return {
      content: serializeJsonBackup(rows, options),
      contentType: 'application/json',
      extension: 'json',
    };
  return {
    content: await serializeXlsx(
      [...rows.accounts, ...rows.transactions],
      options,
    ),
    contentType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx',
  };
}
