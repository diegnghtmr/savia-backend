import { describe, expect, it } from 'vitest';
import {
  REPORT_DIMENSIONS,
  REPORT_MEASURES,
  REPORT_VISUALIZATIONS,
} from '../../src/reports/report.port.js';
import {
  createReportDefinitionCommand,
  ReportCommandValidationError,
} from '../../src/reports/report-command.js';

describe('createReportDefinitionCommand', () => {
  const validPayload = {
    name: 'Monthly Revenue',
    dimensions: ['month', 'category'],
    measures: ['sum', 'count'],
    visualization: 'bar',
  };

  it('accepts valid minimal command and defaults filters to empty object', () => {
    const result = createReportDefinitionCommand(validPayload);
    expect(result).toEqual({
      name: 'Monthly Revenue',
      dimensions: ['month', 'category'],
      measures: ['sum', 'count'],
      visualization: 'bar',
      filters: {},
    });
  });

  it('preserves order and duplicates in dimensions and measures without sorting or deduplication', () => {
    // Shuffled fixture with intentional duplicates
    const shuffledWithDuplicates = {
      name: 'Custom Order Report',
      dimensions: ['month', 'date', 'month', 'category'],
      measures: ['variance', 'sum', 'variance', 'count'],
      visualization: 'table',
      filters: { active: true },
    };

    const result = createReportDefinitionCommand(shuffledWithDuplicates);
    expect(result.dimensions).toEqual(['month', 'date', 'month', 'category']);
    expect(result.measures).toEqual(['variance', 'sum', 'variance', 'count']);
    expect(result.filters).toEqual({ active: true });
  });

  it('accepts empty dimensions array', () => {
    const result = createReportDefinitionCommand({
      ...validPayload,
      dimensions: [],
    });
    expect(result.dimensions).toEqual([]);
  });

  it('counts name length in Unicode code points and accepts a 120-astral-character name', () => {
    const astralChar = '🚀'; // 1 code point, 2 UTF-16 code units
    const name120Astral = astralChar.repeat(120);
    expect(name120Astral.length).toBe(240); // UTF-16 code units
    expect([...name120Astral].length).toBe(120); // Unicode code points

    const result = createReportDefinitionCommand({
      ...validPayload,
      name: name120Astral,
    });
    expect(result.name).toBe(name120Astral);
  });

  it('rejects a 121-astral-character name exceeding 120 code points', () => {
    const astralChar = '🚀';
    const name121Astral = astralChar.repeat(121);
    expect([...name121Astral].length).toBe(121);

    expect(() =>
      createReportDefinitionCommand({
        ...validPayload,
        name: name121Astral,
      }),
    ).toThrow(ReportCommandValidationError);

    try {
      createReportDefinitionCommand({
        ...validPayload,
        name: name121Astral,
      });
      expect.fail('Should have thrown');
    } catch (e) {
      if (!(e instanceof ReportCommandValidationError)) throw e;
      expect(e.violations).toContainEqual(
        expect.objectContaining({ field: 'name', code: 'invalid' }),
      );
    }
  });

  it('rejects non-object input', () => {
    expect(() => createReportDefinitionCommand(null)).toThrow(
      ReportCommandValidationError,
    );
    expect(() => createReportDefinitionCommand([])).toThrow(
      ReportCommandValidationError,
    );
    expect(() => createReportDefinitionCommand('string')).toThrow(
      ReportCommandValidationError,
    );
  });

  it('rejects unknown top-level fields', () => {
    try {
      createReportDefinitionCommand({
        ...validPayload,
        unknownField: 'bad',
      });
      expect.fail('Should have thrown');
    } catch (e) {
      if (!(e instanceof ReportCommandValidationError)) throw e;
      expect(e.violations).toContainEqual(
        expect.objectContaining({ field: 'unknownField', code: 'not-allowed' }),
      );
    }
  });

  it('rejects empty name or non-string name', () => {
    expect(() =>
      createReportDefinitionCommand({ ...validPayload, name: '' }),
    ).toThrow(ReportCommandValidationError);
    expect(() =>
      createReportDefinitionCommand({ ...validPayload, name: 123 }),
    ).toThrow(ReportCommandValidationError);
  });

  it('rejects empty measures array (minItems 1 required)', () => {
    try {
      createReportDefinitionCommand({ ...validPayload, measures: [] });
      expect.fail('Should have thrown');
    } catch (e) {
      if (!(e instanceof ReportCommandValidationError)) throw e;
      expect(e.violations).toContainEqual(
        expect.objectContaining({ field: 'measures', code: 'invalid' }),
      );
    }
  });

  it('rejects invalid dimension enum values with indexed field path', () => {
    try {
      createReportDefinitionCommand({
        ...validPayload,
        dimensions: ['date', 'invalid_dim'],
      });
      expect.fail('Should have thrown');
    } catch (e) {
      if (!(e instanceof ReportCommandValidationError)) throw e;
      expect(e.violations).toContainEqual(
        expect.objectContaining({ field: 'dimensions.1', code: 'invalid' }),
      );
    }
  });

  it('rejects invalid measure enum values with indexed field path', () => {
    try {
      createReportDefinitionCommand({
        ...validPayload,
        measures: ['sum', 'not_a_measure'],
      });
      expect.fail('Should have thrown');
    } catch (e) {
      if (!(e instanceof ReportCommandValidationError)) throw e;
      expect(e.violations).toContainEqual(
        expect.objectContaining({ field: 'measures.1', code: 'invalid' }),
      );
    }
  });

  it('rejects invalid visualization', () => {
    try {
      createReportDefinitionCommand({
        ...validPayload,
        visualization: 'scatter',
      });
      expect.fail('Should have thrown');
    } catch (e) {
      if (!(e instanceof ReportCommandValidationError)) throw e;
      expect(e.violations).toContainEqual(
        expect.objectContaining({ field: 'visualization', code: 'invalid' }),
      );
    }
  });

  it('rejects non-object filters (e.g. array, string, null)', () => {
    for (const badFilter of [null, [], 'invalid', 123]) {
      try {
        createReportDefinitionCommand({
          ...validPayload,
          filters: badFilter,
        });
        expect.fail(`Should have thrown for filter: ${String(badFilter)}`);
      } catch (e) {
        if (!(e instanceof ReportCommandValidationError)) throw e;
        expect(e.violations).toContainEqual(
          expect.objectContaining({ field: 'filters', code: 'invalid' }),
        );
      }
    }
  });

  describe('table-driven enum coverage (FIX 2)', () => {
    const AUTHORITY_DIMENSIONS = [
      'date',
      'day',
      'week',
      'month',
      'quarter',
      'year',
      'account',
      'account_type',
      'category',
      'tag',
      'payee',
      'currency',
      'member',
      'status',
      'transaction_type',
    ] as const;

    const AUTHORITY_MEASURES = [
      'sum',
      'count',
      'average',
      'minimum',
      'maximum',
      'variation',
      'percentage',
      'balance',
      'budget',
      'variance',
      'moving_average',
      'converted_value',
    ] as const;

    const AUTHORITY_VISUALIZATIONS = [
      'table',
      'kpi',
      'bar',
      'line',
      'area',
      'donut',
      'heatmap',
      'calendar',
      'pivot',
    ] as const;

    it('asserts authority enum counts and exact member parity', () => {
      expect(REPORT_DIMENSIONS).toHaveLength(15);
      expect(REPORT_MEASURES).toHaveLength(12);
      expect(REPORT_VISUALIZATIONS).toHaveLength(9);
      expect([...REPORT_DIMENSIONS].sort()).toEqual(
        [...AUTHORITY_DIMENSIONS].sort(),
      );
      expect([...REPORT_MEASURES].sort()).toEqual(
        [...AUTHORITY_MEASURES].sort(),
      );
      expect([...REPORT_VISUALIZATIONS].sort()).toEqual(
        [...AUTHORITY_VISUALIZATIONS].sort(),
      );
    });

    describe('dimensions acceptance', () => {
      it.each(AUTHORITY_DIMENSIONS)(
        'accepts authority dimension: %s',
        (dimension) => {
          const result = createReportDefinitionCommand({
            ...validPayload,
            dimensions: [dimension],
          });
          expect(result.dimensions).toEqual([dimension]);
        },
      );

      it.each(REPORT_DIMENSIONS)(
        'accepts exported dimension: %s',
        (dimension) => {
          const result = createReportDefinitionCommand({
            ...validPayload,
            dimensions: [dimension],
          });
          expect(result.dimensions).toEqual([dimension]);
        },
      );

      it('rejects variability dimension as an invalid enum value', () => {
        try {
          createReportDefinitionCommand({
            ...validPayload,
            dimensions: ['month', 'variability'],
          });
          expect.fail('Should have thrown');
        } catch (e) {
          if (!(e instanceof ReportCommandValidationError)) throw e;
          expect(e.violations).toContainEqual(
            expect.objectContaining({
              field: 'dimensions.1',
               code: 'invalid',
               message: 'must be a supported report dimension',
            }),
          );
        }
      });
    });

    describe('measures acceptance', () => {
      it.each(AUTHORITY_MEASURES)(
        'accepts authority measure: %s',
        (measure) => {
          const result = createReportDefinitionCommand({
            ...validPayload,
            measures: [measure],
          });
          expect(result.measures).toEqual([measure]);
        },
      );

      it.each(REPORT_MEASURES)('accepts exported measure: %s', (measure) => {
        const result = createReportDefinitionCommand({
          ...validPayload,
          measures: [measure],
        });
        expect(result.measures).toEqual([measure]);
      });
    });

    describe('visualizations acceptance', () => {
      it.each(AUTHORITY_VISUALIZATIONS)(
        'accepts authority visualization: %s',
        (visualization) => {
          const result = createReportDefinitionCommand({
            ...validPayload,
            visualization,
          });
          expect(result.visualization).toBe(visualization);
        },
      );

      it.each(REPORT_VISUALIZATIONS)(
        'accepts exported visualization: %s',
        (visualization) => {
          const result = createReportDefinitionCommand({
            ...validPayload,
            visualization,
          });
          expect(result.visualization).toBe(visualization);
        },
      );
    });
  });
});
