import { describe, expect, it } from 'vitest';
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
    } catch (e) {
      const err = e as ReportCommandValidationError;
      expect(err.violations).toContainEqual(
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
      const err = e as ReportCommandValidationError;
      expect(err.violations).toContainEqual(
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
      const err = e as ReportCommandValidationError;
      expect(err.violations).toContainEqual(
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
      const err = e as ReportCommandValidationError;
      expect(err.violations).toContainEqual(
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
      const err = e as ReportCommandValidationError;
      expect(err.violations).toContainEqual(
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
      const err = e as ReportCommandValidationError;
      expect(err.violations).toContainEqual(
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
        const err = e as ReportCommandValidationError;
        expect(err.violations).toContainEqual(
          expect.objectContaining({ field: 'filters', code: 'invalid' }),
        );
      }
    }
  });
});
