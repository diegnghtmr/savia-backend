import { describe, expect, it } from 'vitest';
import {
  createAnalyticsSummaryQuery,
  createCashFlowAnalyticsQuery,
  createAdvancedAnalyticsQuery,
  AnalyticsQueryValidationError,
} from '../../src/analytics/analytics-query.js';
import { ADVANCED_METRIC } from '../../src/analytics/analytics.port.js';

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

  describe('createAdvancedAnalyticsQuery', () => {
    const fixedClock = new Date('2026-09-04T12:00:00.000Z');

    it('accepts valid metric, from, and to dates', () => {
      const q = createAdvancedAnalyticsQuery(
        {
          workspaceId: validWorkspaceId,
          metricParam: ADVANCED_METRIC.RECURRING_VS_VARIABLE,
          fromParam: '2026-01-01',
          toParam: '2026-06-30',
        },
        fixedClock,
      );
      expect(q.workspaceId).toBe(validWorkspaceId);
      expect(q.metric).toBe(ADVANCED_METRIC.RECURRING_VS_VARIABLE);
      expect(q.from).toBe('2026-01-01');
      expect(q.to).toBe('2026-06-30');
    });

    it('defaults both from and to when omitted using injected clock (12-month window ending today)', () => {
      const q = createAdvancedAnalyticsQuery(
        {
          workspaceId: validWorkspaceId,
          metricParam: ADVANCED_METRIC.FINANCIAL_CALENDAR,
        },
        fixedClock,
      );
      // to is today's UTC date: 2026-09-04
      // from is first day of month 11 months before September 2026: 2025-10-01
      expect(q.to).toBe('2026-09-04');
      expect(q.from).toBe('2025-10-01');
    });

    it('defaults from to first day of month 11 months before to when only to is provided', () => {
      const q = createAdvancedAnalyticsQuery(
        {
          workspaceId: validWorkspaceId,
          metricParam: ADVANCED_METRIC.BALANCE_PROJECTION,
          toParam: '2026-03-15',
        },
        fixedClock,
      );
      expect(q.to).toBe('2026-03-15');
      expect(q.from).toBe('2025-04-01');
    });

    it('rejects missing metric', () => {
      try {
        createAdvancedAnalyticsQuery(
          {
            workspaceId: validWorkspaceId,
          },
          fixedClock,
        );
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AnalyticsQueryValidationError);
        const v = (error as AnalyticsQueryValidationError).violations;
        expect(v).toContainEqual(
          expect.objectContaining({ field: 'metric', code: 'required' }),
        );
      }
    });

    it('rejects unknown metric (enum rejection)', () => {
      try {
        createAdvancedAnalyticsQuery(
          {
            workspaceId: validWorkspaceId,
            metricParam: 'unknown_future_metric',
          },
          fixedClock,
        );
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AnalyticsQueryValidationError);
        const v = (error as AnalyticsQueryValidationError).violations;
        expect(v).toContainEqual(
          expect.objectContaining({ field: 'metric', code: 'invalid-metric' }),
        );
      }
    });

    it('rejects malformed from date', () => {
      expect(() =>
        createAdvancedAnalyticsQuery(
          {
            workspaceId: validWorkspaceId,
            metricParam: ADVANCED_METRIC.WEEKDAY_HEATMAP,
            fromParam: '2026-02-30',
            toParam: '2026-03-15',
          },
          fixedClock,
        ),
      ).toThrow(AnalyticsQueryValidationError);
    });

    it('rejects malformed to date', () => {
      expect(() =>
        createAdvancedAnalyticsQuery(
          {
            workspaceId: validWorkspaceId,
            metricParam: ADVANCED_METRIC.WEEKDAY_HEATMAP,
            fromParam: '2026-01-01',
            toParam: 'not-a-date',
          },
          fixedClock,
        ),
      ).toThrow(AnalyticsQueryValidationError);
    });

    it('rejects from > to', () => {
      try {
        createAdvancedAnalyticsQuery(
          {
            workspaceId: validWorkspaceId,
            metricParam: ADVANCED_METRIC.WEEKDAY_HEATMAP,
            fromParam: '2026-08-01',
            toParam: '2026-07-01',
          },
          fixedClock,
        );
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AnalyticsQueryValidationError);
        const v = (error as AnalyticsQueryValidationError).violations;
        expect(v).toContainEqual(
          expect.objectContaining({ field: 'to', code: 'invalid-range' }),
        );
      }
    });

    it('rejects invalid workspaceId', () => {
      expect(() =>
        createAdvancedAnalyticsQuery(
          {
            workspaceId: 'invalid-uuid',
            metricParam: ADVANCED_METRIC.WEEKDAY_HEATMAP,
          },
          fixedClock,
        ),
      ).toThrow(AnalyticsQueryValidationError);
    });
  });
});
