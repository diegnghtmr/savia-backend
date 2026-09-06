import { describe, expect, it } from 'vitest';
import {
  REPORT_PRESETS,
  REPORT_PRESETS_LIST,
} from '../../src/reports/report-presets.js';

describe('report presets', () => {
  it('exports the pinned twelve presets in order', () => {
    expect(REPORT_PRESETS_LIST).toEqual([
      'monthly_summary',
      'cash_flow',
      'expenses',
      'income',
      'budget',
      'net_worth',
      'debts',
      'funds',
      'family_workspace',
      'multi_currency',
      'forecast',
      'period_comparison',
    ]);
    expect(REPORT_PRESETS.expenses).toEqual({
      dimensions: ['category'],
      measures: ['converted_value', 'percentage'],
      visualization: 'donut',
      typeFilter: 'expense',
    });
    expect(REPORT_PRESETS.cash_flow).toEqual({
      dimensions: ['month', 'transaction_type'],
      measures: ['converted_value', 'balance'],
      visualization: 'line',
    });
  });
});
