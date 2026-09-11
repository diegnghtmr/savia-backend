import { describe, expect, it } from 'vitest';
import {
  createAnalyticsSummaryQuery,
  createCashFlowAnalyticsQuery,
  AnalyticsQueryValidationError,
} from '../../src/analytics/analytics-query.js';

describe('analytics-query', () => {
  const validWorkspaceId = '00000000-0000-4000-8000-000000000001';

  describe('createAnalyticsSummaryQuery', () => {
    it('accepts valid from and to dates', () => {
      const q = createAnalyticsSummaryQuery({
        workspaceId: validWorkspaceId,
        fromParam: '2026-01-01',
        toParam: '2026-01-31',
      });
      expect(q.workspaceId).toBe(validWorkspaceId);
      expect(q.from).toBe('2026-01-01');
      expect(q.to).toBe('2026-01-31');
      expect(q.presentationCurrency).toBeUndefined();
    });

    it('accepts optional presentationCurrency', () => {
      const q = createAnalyticsSummaryQuery({
        workspaceId: validWorkspaceId,
        fromParam: '2026-01-01',
        toParam: '2026-01-31',
        presentationCurrencyParam: 'EUR',
      });
      expect(q.presentationCurrency).toBe('EUR');
    });

    it('rejects missing from', () => {
      expect(() =>
        createAnalyticsSummaryQuery({
          workspaceId: validWorkspaceId,
          toParam: '2026-01-31',
        }),
      ).toThrow(AnalyticsQueryValidationError);
    });

    it('rejects missing to', () => {
      expect(() =>
        createAnalyticsSummaryQuery({
          workspaceId: validWorkspaceId,
          fromParam: '2026-01-01',
        }),
      ).toThrow(AnalyticsQueryValidationError);
    });

    it('rejects malformed date (invalid calendar date)', () => {
      expect(() =>
        createAnalyticsSummaryQuery({
          workspaceId: validWorkspaceId,
          fromParam: '2026-02-30',
          toParam: '2026-03-01',
        }),
      ).toThrow(AnalyticsQueryValidationError);
    });

    it('rejects from > to', () => {
      expect(() =>
        createAnalyticsSummaryQuery({
          workspaceId: validWorkspaceId,
          fromParam: '2026-02-01',
          toParam: '2026-01-01',
        }),
      ).toThrow(AnalyticsQueryValidationError);
    });

    it('rejects invalid presentationCurrency', () => {
      expect(() =>
        createAnalyticsSummaryQuery({
          workspaceId: validWorkspaceId,
          fromParam: '2026-01-01',
          toParam: '2026-01-31',
          presentationCurrencyParam: 'INVALID',
        }),
      ).toThrow(AnalyticsQueryValidationError);
    });
  });

  describe('createCashFlowAnalyticsQuery', () => {
    it('defaults granularity to month when omitted', () => {
      const q = createCashFlowAnalyticsQuery({
        workspaceId: validWorkspaceId,
        fromParam: '2026-01-01',
        toParam: '2026-01-31',
      });
      expect(q.granularity).toBe('month');
    });

    it('accepts supported granularities: day, week, month, quarter', () => {
      for (const g of ['day', 'week', 'month', 'quarter'] as const) {
        const q = createCashFlowAnalyticsQuery({
          workspaceId: validWorkspaceId,
          fromParam: '2026-01-01',
          toParam: '2026-01-31',
          granularityParam: g,
        });
        expect(q.granularity).toBe(g);
      }
    });

    it('rejects unknown granularity', () => {
      expect(() =>
        createCashFlowAnalyticsQuery({
          workspaceId: validWorkspaceId,
          fromParam: '2026-01-01',
          toParam: '2026-01-31',
          granularityParam: 'year',
        }),
      ).toThrow(AnalyticsQueryValidationError);
    });
  });
});
