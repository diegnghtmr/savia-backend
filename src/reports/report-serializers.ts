import PDFDocument from 'pdfkit';
import { escapeCsvField } from '../exports/export-serializers.js';
import type { ReportGrid } from './report-engine.js';

export interface SerializedReport {
  readonly content: Buffer;
  readonly contentType: string;
  readonly extension: 'json' | 'csv' | 'pdf';
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

function serializePdf(grid: ReportGrid): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ margin: 36 });
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
    const columns = headers(grid);
    document.fontSize(10).text(columns.join(' | '));
    for (const row of values(grid)) {
      document.moveDown(0.25).text(row.map((item) => item ?? '').join(' | '));
    }
    document.end();
  });
}

export async function serializeReport(
  format: 'json' | 'csv' | 'pdf',
  grid: ReportGrid,
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
    content: await serializePdf(grid),
    contentType: 'application/pdf',
    extension: 'pdf',
  };
}
