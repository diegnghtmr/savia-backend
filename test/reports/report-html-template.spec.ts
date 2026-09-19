import { describe, expect, it } from 'vitest';
import { DeliveryDeadlineExceededError } from '../../src/platform/delivery-deadline.js';
import type { ReportGrid } from '../../src/reports/report-engine.js';
import { renderReportHtml } from '../../src/reports/report-html-template.js';
import { serializeReport } from '../../src/reports/report-serializers.js';
import {
  REPORT_DIMENSION,
  REPORT_MEASURE,
} from '../../src/reports/report.port.js';

function makeGrid(overrides?: Partial<ReportGrid>): ReportGrid {
  return {
    dimensions: [REPORT_DIMENSION.MONTH],
    measures: [REPORT_MEASURE.CONVERTED_VALUE, REPORT_MEASURE.COUNT],
    baseCurrency: 'USD',
    warnings: [],
    rows: [
      {
        key: ['2026-01'],
        cells: [
          { measure: REPORT_MEASURE.CONVERTED_VALUE, value: '150000' },
          { measure: REPORT_MEASURE.COUNT, value: '3' },
        ],
      },
      {
        key: ['2026-02'],
        cells: [
          { measure: REPORT_MEASURE.CONVERTED_VALUE, value: '200000' },
          { measure: REPORT_MEASURE.COUNT, value: '5' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('Report HTML template', () => {
  it('produces valid HTML with headers matching grid dimensions and measures', () => {
    const grid = makeGrid();
    const html = renderReportHtml(grid);

    expect(html).toContain('<table');
    expect(html).toContain('<th>month</th>');
    expect(html).toContain('<th>converted_value</th>');
    expect(html).toContain('<th>count</th>');
    expect(html).toContain('<td>2026-01</td>');
    expect(html).toContain('<td>150000</td>');
    expect(html).toContain('<td>3</td>');
    expect(html).toContain('<td>2026-02</td>');
    expect(html).toContain('<td>200000</td>');
    expect(html).toContain('<td>5</td>');
    expect(html).toContain('<p id="base-currency">USD</p>');
  });

  it('HTML-escapes injected <script> in dimension keys', () => {
    const grid = makeGrid({
      rows: [
        {
          key: ['<script>alert("xss")</script>'],
          cells: [
            { measure: REPORT_MEASURE.CONVERTED_VALUE, value: '100' },
            { measure: REPORT_MEASURE.COUNT, value: '1' },
          ],
        },
      ],
    });
    const html = renderReportHtml(grid);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('HTML-escapes "><img onerror> injection in cell values', () => {
    const grid = makeGrid({
      rows: [
        {
          key: ['2026-01'],
          cells: [
            {
              measure: REPORT_MEASURE.CONVERTED_VALUE,
              value: '"><img onerror=alert(1) src=x>',
            },
            { measure: REPORT_MEASURE.COUNT, value: '1' },
          ],
        },
      ],
    });
    const html = renderReportHtml(grid);

    expect(html).not.toContain('<img');
    expect(html).toContain('&quot;&gt;&lt;img');
  });

  it('HTML-escapes ampersands in values', () => {
    const grid = makeGrid({
      rows: [
        {
          key: ['Tom & Jerry'],
          cells: [
            { measure: REPORT_MEASURE.CONVERTED_VALUE, value: 'A & B' },
            { measure: REPORT_MEASURE.COUNT, value: '1' },
          ],
        },
      ],
    });
    const html = renderReportHtml(grid);

    expect(html).toContain('Tom &amp; Jerry');
    expect(html).toContain('A &amp; B');
    expect(html).not.toMatch(/Tom & Jerry/);
  });

  it('HTML-escapes quotes in dimension keys', () => {
    const grid = makeGrid({
      rows: [
        {
          key: ['"quoted" value'],
          cells: [
            { measure: REPORT_MEASURE.CONVERTED_VALUE, value: '100' },
            { measure: REPORT_MEASURE.COUNT, value: '1' },
          ],
        },
      ],
    });
    const html = renderReportHtml(grid);

    expect(html).toContain('&quot;quoted&quot; value');
  });

  it('renders null cell values as empty strings', () => {
    const grid = makeGrid({
      rows: [
        {
          key: ['2026-01'],
          cells: [
            { measure: REPORT_MEASURE.CONVERTED_VALUE, value: null },
            { measure: REPORT_MEASURE.COUNT, value: '1' },
          ],
        },
      ],
    });
    const html = renderReportHtml(grid);

    expect(html).toContain('<td></td>');
  });

  it('escapes warnings and includes base-currency meta from the grid', () => {
    const grid = makeGrid({
      warnings: ['Rows are counted once per tag; <script>'],
    });
    const html = renderReportHtml(grid);

    expect(html).toContain('<p id="base-currency">USD</p>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('grid headers and row values match what json/csv serializers compute', async () => {
    const grid = makeGrid();
    const html = renderReportHtml(grid);
    const csv = await serializeReport('csv', grid);
    const json = await serializeReport('json', grid);

    const csvLines = csv.content.toString('utf8').split('\n');
    const csvHeaders = csvLines[0]?.split(',') ?? [];
    expect(csvHeaders).toEqual([...grid.dimensions, ...grid.measures]);
    for (const header of csvHeaders) {
      expect(html).toContain(`<th>${header}</th>`);
    }

    const parsed = JSON.parse(json.content.toString('utf8')) as {
      dimensions: string[];
      measures: string[];
      baseCurrency: string;
      warnings: string[];
      rows: Array<{ key: string[]; cells: Array<{ value: string | null }> }>;
    };
    expect(parsed.dimensions).toEqual(grid.dimensions);
    expect(parsed.measures).toEqual(grid.measures);
    expect(parsed.baseCurrency).toBe(grid.baseCurrency);
    expect(html).toContain(`<p id="base-currency">${parsed.baseCurrency}</p>`);

    for (const row of parsed.rows) {
      for (const key of row.key) {
        expect(html).toContain(`<td>${key}</td>`);
      }
      for (const cell of row.cells) {
        if (cell.value !== null) {
          expect(html).toContain(`<td>${cell.value}</td>`);
        }
      }
    }
  });

  it('throws when the render budget is already exhausted', () => {
    expect(() =>
      renderReportHtml(makeGrid(), { remainingMs: () => 0 }),
    ).toThrow(DeliveryDeadlineExceededError);
  });

  it('throws when the abort signal is already aborted', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      renderReportHtml(makeGrid(), { signal: controller.signal }),
    ).toThrow(DeliveryDeadlineExceededError);
  });

  it('checks the budget cooperatively while building rows', () => {
    const rows = Array.from({ length: 300 }, (_, index) => ({
      key: [`2026-${String(index).padStart(2, '0')}`],
      cells: [
        { measure: REPORT_MEASURE.CONVERTED_VALUE, value: '1' },
        { measure: REPORT_MEASURE.COUNT, value: '1' },
      ],
    }));
    let checks = 0;
    expect(() =>
      renderReportHtml(makeGrid({ rows }), {
        remainingMs: () => {
          checks += 1;
          return checks === 1 ? 100 : 0;
        },
      }),
    ).toThrow(DeliveryDeadlineExceededError);
    expect(checks).toBeGreaterThan(1);
  });
});
