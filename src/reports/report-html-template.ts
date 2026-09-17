import { DeliveryDeadlineExceededError } from '../platform/delivery-deadline.js';
import type { ReportGrid } from './report-engine.js';

export interface RenderReportHtmlOptions {
  readonly signal?: AbortSignal;
  readonly remainingMs?: () => number;
}

const HTML_ROW_BATCH_SIZE = 250;

function isRenderBudgetExhausted(options?: RenderReportHtmlOptions): boolean {
  if (options?.signal?.aborted) {
    return true;
  }
  return options?.remainingMs !== undefined && options.remainingMs() <= 0;
}

function throwIfRenderBudgetExhausted(options?: RenderReportHtmlOptions): void {
  if (isRenderBudgetExhausted(options)) {
    throw new DeliveryDeadlineExceededError(
      'Report rendering exceeded the delivery work cap.',
    );
  }
}

export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Renders a ReportGrid into a standalone HTML document with a table.
 * Every user-supplied value is HTML-escaped. Headers and row values use the
 * same dimension-then-measure order as the JSON/CSV serializers.
 */
export function renderReportHtml(
  grid: ReportGrid,
  options?: RenderReportHtmlOptions,
): string {
  throwIfRenderBudgetExhausted(options);

  const headers = [...grid.dimensions, ...grid.measures];
  const headerCells = headers
    .map((header) => `<th>${escapeHtml(header)}</th>`)
    .join('');

  const bodyRows: string[] = [];
  for (let index = 0; index < grid.rows.length; index += 1) {
    if (index % HTML_ROW_BATCH_SIZE === 0) {
      throwIfRenderBudgetExhausted(options);
    }
    const row = grid.rows[index];
    if (row === undefined) {
      continue;
    }
    const keyCells = row.key
      .map((key) => `<td>${escapeHtml(key)}</td>`)
      .join('');
    const valueCells = row.cells
      .map(
        (cell) =>
          `<td>${cell.value !== null ? escapeHtml(cell.value) : ''}</td>`,
      )
      .join('');
    bodyRows.push(`<tr>${keyCells}${valueCells}</tr>`);
  }

  throwIfRenderBudgetExhausted(options);

  const warningItems = grid.warnings
    .map((warning) => `<li>${escapeHtml(warning)}</li>`)
    .join('');
  const warningsBlock =
    warningItems.length > 0 ? `<ul id="warnings">${warningItems}</ul>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Report</title>
<style>
body{font-family:system-ui,sans-serif;margin:24px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ccc;padding:6px 10px;text-align:left;font-size:12px}
th{background:#f5f5f5;font-weight:600}
tr:nth-child(even){background:#fafafa}
</style>
</head>
<body>
<p id="base-currency">${escapeHtml(grid.baseCurrency)}</p>
${warningsBlock}
<table>
<thead><tr>${headerCells}</tr></thead>
<tbody>
${bodyRows.join('\n')}
</tbody>
</table>
</body>
</html>`;
}
