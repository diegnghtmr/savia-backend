import { describe, expect, it } from 'vitest';
import {
  computePreparedReportGrid,
  resolveReportPeriod,
  resolveShapeTypeFilter,
} from '../../src/reports/report-computation.js';

const FIXED_NOW = new Date('2026-09-15T12:00:00.000Z');

describe('resolveReportPeriod', () => {
  it('defaults the period from a fixed clock instant', () => {
    expect(resolveReportPeriod(FIXED_NOW, undefined, {})).toEqual({
      periodStart: '2025-10-01',
      periodTo: '2026-09-15',
    });
  });

  it('intersects definition and caller bounds without widening', () => {
    expect(
      resolveReportPeriod(
        FIXED_NOW,
        { from: '2026-04-01', to: '2026-06-30' },
        { from: '2026-01-01', to: '2026-12-31' },
      ),
    ).toEqual({
      periodStart: '2026-04-01',
      periodTo: '2026-06-30',
    });
  });
});

describe('resolveShapeTypeFilter', () => {
  it('prefers an explicit typeFilter over definition filters', () => {
    expect(
      resolveShapeTypeFilter({
        dimensions: ['category'],
        measures: ['sum'],
        typeFilter: 'expense',
        filters: { type: 'income' },
      }),
    ).toBe('expense');
  });
});

describe('computePreparedReportGrid', () => {
  it('adds a budget warning for unbudgeted buckets', () => {
    const grid = computePreparedReportGrid({
      rows: [],
      dimensions: ['month', 'category'],
      measures: ['budget'],
      baseCurrency: 'USD',
      budgetedMinorByBucket: new Map(),
      preset: 'budget',
    });
    expect(grid.warnings).toEqual([]);
  });
});
