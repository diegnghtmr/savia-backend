import { describe, expect, it } from 'vitest';
import { DeliveryDeadlineExceededError } from '../../src/platform/delivery-deadline.js';
import {
  REPORT_DIMENSION,
  REPORT_MEASURE,
} from '../../src/reports/report.port.js';
import type { ReportGrid } from '../../src/reports/report-engine.js';
import { serializeReport } from '../../src/reports/report-serializers.js';

const grid: ReportGrid = {
  dimensions: [REPORT_DIMENSION.PAYEE],
  measures: [REPORT_MEASURE.CONVERTED_VALUE],
  baseCurrency: 'USD',
  warnings: [],
  rows: [
    {
      key: ['Payee, "quoted"\nline'],
      cells: [{ measure: REPORT_MEASURE.CONVERTED_VALUE, value: '123.45' }],
    },
  ],
};

const pinnedGrid: ReportGrid = {
  dimensions: [REPORT_DIMENSION.PAYEE, REPORT_DIMENSION.CATEGORY],
  measures: [REPORT_MEASURE.CONVERTED_VALUE, REPORT_MEASURE.PERCENTAGE],
  baseCurrency: 'USD',
  warnings: ['Bucket unbudgeted warning'],
  rows: [
    {
      key: ['Acme, Inc.', 'Tools & "Hardware"'],
      cells: [
        { measure: REPORT_MEASURE.CONVERTED_VALUE, value: '1234.50' },
        { measure: REPORT_MEASURE.PERCENTAGE, value: '25.5' },
      ],
    },
    {
      key: ['=SUM(A1)', '-50.00'],
      cells: [
        { measure: REPORT_MEASURE.CONVERTED_VALUE, value: '-50.00' },
        { measure: REPORT_MEASURE.PERCENTAGE, value: null },
      ],
    },
    {
      key: ['Line 1\nLine 2', '@special\tkey'],
      cells: [
        { measure: REPORT_MEASURE.CONVERTED_VALUE, value: '0.00' },
        { measure: REPORT_MEASURE.PERCENTAGE, value: '0.0' },
      ],
    },
  ],
};

const PINNED_JSON =
  '{"dimensions":["payee","category"],"measures":["converted_value","percentage"],"baseCurrency":"USD","warnings":["Bucket unbudgeted warning"],"rows":[{"key":["Acme, Inc.","Tools & \\"Hardware\\""],"cells":[{"measure":"converted_value","value":"1234.50"},{"measure":"percentage","value":"25.5"}]},{"key":["=SUM(A1)","-50.00"],"cells":[{"measure":"converted_value","value":"-50.00"},{"measure":"percentage","value":null}]},{"key":["Line 1\\nLine 2","@special\\tkey"],"cells":[{"measure":"converted_value","value":"0.00"},{"measure":"percentage","value":"0.0"}]}]}';

const PINNED_CSV =
  'payee,category,converted_value,percentage\n' +
  '"Acme, Inc.","Tools & ""Hardware""","1234.50","25.5"\n' +
  '"\'=SUM(A1)","-50.00","-50.00",""\n' +
  '"Line 1\nLine 2","\'@special\tkey","0.00","0.0"';

function largeGrid(rowCount = 50_000): ReportGrid {
  return {
    dimensions: [REPORT_DIMENSION.PAYEE],
    measures: [REPORT_MEASURE.CONVERTED_VALUE],
    baseCurrency: 'USD',
    warnings: [],
    rows: Array.from({ length: rowCount }, (_, index) => ({
      key: [`Payee ${String(index).padStart(5, '0')} ${'n'.repeat(24)}`],
      cells: [
        { measure: REPORT_MEASURE.CONVERTED_VALUE, value: String(index) },
      ],
    })),
  };
}

describe('serializeReport', () => {
  it('escapes CSV fields containing commas, quotes, and newlines', async () => {
    const result = await serializeReport('csv', grid);
    expect(result.contentType).toBe('text/csv');
    expect(result.content.toString()).toContain('"Payee, ""quoted""\nline"');
  });

  it('keeps JSON money values as strings', async () => {
    const result = await serializeReport('json', grid);
    expect(JSON.parse(result.content.toString()).rows[0].cells[0].value).toBe(
      '123.45',
    );
  });

  it('renders a PDF with the PDF magic bytes', async () => {
    const result = await serializeReport('pdf', grid);
    expect(result.contentType).toBe('application/pdf');
    expect(result.content.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('produces byte-identical output for a pinned multi-row fixture in JSON and CSV', async () => {
    const jsonResult = await serializeReport('json', pinnedGrid);
    expect(jsonResult.content.toString('utf8')).toBe(PINNED_JSON);

    const csvResult = await serializeReport('csv', pinnedGrid);
    expect(csvResult.content.toString('utf8')).toBe(PINNED_CSV);
  });

  it('aborts JSON serialization when the remaining budget is already exhausted', async () => {
    const large = largeGrid(50_000);
    await expect(
      serializeReport('json', large, {
        remainingMs: () => 0,
      }),
    ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
  });

  it('aborts CSV serialization when the remaining budget is already exhausted', async () => {
    const large = largeGrid(50_000);
    await expect(
      serializeReport('csv', large, {
        remainingMs: () => 0,
      }),
    ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
  });

  it('aborts JSON serialization when the signal is already aborted', async () => {
    const large = largeGrid(50_000);
    await expect(
      serializeReport('json', large, {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
  });

  it('aborts CSV serialization when the signal is already aborted', async () => {
    const large = largeGrid(50_000);
    await expect(
      serializeReport('csv', large, {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
  });

  it('aborts JSON serialization when the budget elapses part-way through a large grid', async () => {
    const large = largeGrid(50_000);
    const started = performance.now();
    await expect(
      serializeReport('json', large, {
        remainingMs: () => 5 - (performance.now() - started),
      }),
    ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
    expect(performance.now() - started).toBeLessThan(2_000);
  }, 10_000);

  it('aborts CSV serialization when the budget elapses part-way through a large grid', async () => {
    const large = largeGrid(50_000);
    const started = performance.now();
    await expect(
      serializeReport('csv', large, {
        remainingMs: () => 5 - (performance.now() - started),
      }),
    ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
    expect(performance.now() - started).toBeLessThan(2_000);
  }, 10_000);

  it('serializes normal-size grids under a normal cap for JSON, CSV, and PDF', async () => {
    const options = { remainingMs: () => 5_000 };
    const jsonResult = await serializeReport('json', grid, options);
    expect(jsonResult.contentType).toBe('application/json');
    expect(JSON.parse(jsonResult.content.toString('utf8')).rows).toHaveLength(
      1,
    );

    const csvResult = await serializeReport('csv', grid, options);
    expect(csvResult.contentType).toBe('text/csv');
    expect(csvResult.content.toString('utf8')).toContain('Payee');

    const pdfResult = await serializeReport('pdf', grid, options);
    expect(pdfResult.contentType).toBe('application/pdf');
    expect(pdfResult.content.subarray(0, 5).toString('utf8')).toBe('%PDF-');
  });

  it('aborts a large PDF when the remaining budget is exhausted', async () => {
    const large = largeGrid(10_000);
    const started = performance.now();
    await expect(
      serializeReport('pdf', large, {
        remainingMs: () => 1 - (performance.now() - started),
      }),
    ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
    expect(performance.now() - started).toBeLessThan(2_000);
  }, 10_000);
});
