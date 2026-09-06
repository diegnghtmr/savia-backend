import { describe, expect, it } from 'vitest';
import {
  createReportRunCommand,
  ReportRunCommandValidationError,
} from '../../src/reports/report-run-command.js';

describe('createReportRunCommand', () => {
  it('accepts a preset and preserves unknown filters', () => {
    expect(
      createReportRunCommand({
        preset: 'expenses',
        format: 'json',
        filters: { custom: true },
      }),
    ).toEqual({
      preset: 'expenses',
      format: 'json',
      filters: { custom: true },
    });
  });

  it.each([
    {
      definitionId: 'aaaaaaaa-0000-4000-8000-000000000001',
      preset: 'expenses',
      format: 'json',
    },
    { format: 'json' },
  ])('rejects invalid XOR shape: %j', (body) => {
    expect(() => createReportRunCommand(body)).toThrow(
      ReportRunCommandValidationError,
    );
  });

  it('rejects invalid date filters', () => {
    expect(() =>
      createReportRunCommand({
        preset: 'income',
        format: 'csv',
        filters: { from: '2026-02-31' },
      }),
    ).toThrow(ReportRunCommandValidationError);
  });
});
