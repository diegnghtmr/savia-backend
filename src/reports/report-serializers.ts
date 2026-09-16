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

function headers(grid: ReportGrid): readonly string[] {
  return [...grid.dimensions, ...grid.measures];
}

function values(grid: ReportGrid): readonly (string | null)[][] {
  return grid.rows.map((row) => [
    ...row.key,
    ...row.cells.map((cell) => cell.value),
  ]);
}

function serializeJson(grid: ReportGrid): Buffer {
  return Buffer.from(JSON.stringify(grid));
}

function serializeCsv(grid: ReportGrid): Buffer {
  const columns = headers(grid);
  const neutralize = (value: string): string =>
    /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)
      ? value
      : /^[=+\-@]|^[\t\r]/.test(value)
        ? `'${value}`
        : value;
  const row = (items: readonly (string | null)[]): string =>
    items.map((item) => escapeCsvField(item, neutralize)).join(',');
  return Buffer.from(
    [columns.join(','), ...values(grid).map((items) => row(items))].join('\n'),
  );
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
    try {
      document.destroy();
    } catch {
      // A single pdfkit text() or end() flush has no abort hook.
    }
  };
  try {
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
      content: serializeJson(grid),
      contentType: 'application/json',
      extension: 'json',
    };
  }
  if (format === 'csv') {
    return {
      content: serializeCsv(grid),
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
