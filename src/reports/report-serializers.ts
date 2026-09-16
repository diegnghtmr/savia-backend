import PDFDocument from 'pdfkit';
import { escapeCsvField } from '../platform/csv.js';
import { DeliveryDeadlineExceededError } from '../platform/delivery-deadline.js';
import type { ReportGrid } from './report-engine.js';

export interface SerializedReport {
  readonly content: Buffer;
  readonly contentType: string;
  readonly extension: 'json' | 'csv' | 'pdf';
}

export interface SerializeReportOptions {
  readonly signal?: AbortSignal;
  readonly remainingMs?: () => number;
}

function isRenderBudgetExhausted(options?: SerializeReportOptions): boolean {
  if (options?.signal?.aborted) {
    return true;
  }
  return options?.remainingMs !== undefined && options.remainingMs() <= 0;
}

function throwIfRenderBudgetExhausted(options?: SerializeReportOptions): void {
  if (isRenderBudgetExhausted(options)) {
    throw new DeliveryDeadlineExceededError(
      'Report rendering exceeded the delivery work cap.',
    );
  }
}

const JSON_ROW_BATCH_SIZE = 250;

function headers(grid: ReportGrid): readonly string[] {
  return [...grid.dimensions, ...grid.measures];
}

function values(grid: ReportGrid): readonly (string | null)[][] {
  return grid.rows.map((row) => [
    ...row.key,
    ...row.cells.map((cell) => cell.value),
  ]);
}

function serializeJson(
  grid: ReportGrid,
  options?: SerializeReportOptions,
): Buffer {
  throwIfRenderBudgetExhausted(options);
  const keys = Object.keys(grid);
  const parts: string[] = [];
  for (const key of keys) {
    if (key === 'rows') {
      const rowChunks: string[] = [];
      for (let i = 0; i < grid.rows.length; i += JSON_ROW_BATCH_SIZE) {
        throwIfRenderBudgetExhausted(options);
        const batch = grid.rows.slice(i, i + JSON_ROW_BATCH_SIZE);
        const batchJson = JSON.stringify(batch);
        rowChunks.push(batchJson.slice(1, -1));
      }
      parts.push(`"rows":[${rowChunks.join(',')}]`);
    } else {
      const value = grid[key as keyof ReportGrid];
      if (value !== undefined) {
        parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
      }
    }
  }
  return Buffer.from(`{${parts.join(',')}}`);
}

function serializeCsv(
  grid: ReportGrid,
  options?: SerializeReportOptions,
): Buffer {
  throwIfRenderBudgetExhausted(options);
  const columns = headers(grid);
  const neutralize = (value: string): string =>
    /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)
      ? value
      : /^[=+\-@]|^[\t\r]/.test(value)
        ? `'${value}`
        : value;
  const formatRow = (items: readonly (string | null)[]): string =>
    items.map((item) => escapeCsvField(item, neutralize)).join(',');

  const lines: string[] = [columns.join(',')];
  for (let index = 0; index < grid.rows.length; index += 1) {
    throwIfRenderBudgetExhausted(options);
    const row = grid.rows[index];
    if (row === undefined) {
      continue;
    }
    const items = [...row.key, ...row.cells.map((cell) => cell.value)];
    lines.push(formatRow(items));
  }
  return Buffer.from(lines.join('\n'));
}

async function serializePdf(
  grid: ReportGrid,
  options?: SerializeReportOptions,
): Promise<Buffer> {
  const document = new PDFDocument({ margin: 36 });
  const chunks: Buffer[] = [];
  let settled = false;
  const done = new Promise<Buffer>((resolve, reject) => {
    document.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    document.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    document.on('error', (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
  const abandon = (): void => {
    document.removeAllListeners();
    // pdfkit has no abort hook: a started text() or end() flush keeps running.
  };
  try {
    throwIfRenderBudgetExhausted(options);
    const columns = headers(grid);
    document.fontSize(10).text(columns.join(' | '));
    const rows = values(grid);
    for (let index = 0; index < rows.length; index += 1) {
      throwIfRenderBudgetExhausted(options);
      const row = rows[index];
      if (row === undefined) {
        continue;
      }
      document.moveDown(0.25).text(row.map((item) => item ?? '').join(' | '));
    }
    document.end();
    return await done;
  } catch (error) {
    abandon();
    throw error;
  }
}

export async function serializeReport(
  format: 'json' | 'csv' | 'pdf',
  grid: ReportGrid,
  options?: SerializeReportOptions,
): Promise<SerializedReport> {
  if (format === 'json') {
    return {
      content: serializeJson(grid, options),
      contentType: 'application/json',
      extension: 'json',
    };
  }
  if (format === 'csv') {
    return {
      content: serializeCsv(grid, options),
      contentType: 'text/csv',
      extension: 'csv',
    };
  }
  return {
    content: await serializePdf(grid, options),
    contentType: 'application/pdf',
    extension: 'pdf',
  };
}
