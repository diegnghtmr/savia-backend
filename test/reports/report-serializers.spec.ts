import { describe, expect, it } from 'vitest';
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
});
