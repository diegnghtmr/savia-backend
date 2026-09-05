import { describe, expect, it } from 'vitest';
import {
  createForecastCommand,
  ForecastCommandValidationError,
} from '../../src/forecasts/forecast-command.js';
import {
  validateForecastId,
  ForecastQueryValidationError,
} from '../../src/forecasts/forecast-query.js';

describe('createForecastCommand', () => {
  it('defaults horizonDays to 90 and includeScenarios to false when omitted', () => {
    const command = createForecastCommand({});
    expect(command.horizonDays).toBe(90);
    expect(command.includeScenarios).toBe(false);
    expect(command.accountIds).toBeUndefined();
  });

  it('accepts horizonDays boundary values 1 and 730', () => {
    expect(createForecastCommand({ horizonDays: 1 }).horizonDays).toBe(1);
    expect(createForecastCommand({ horizonDays: 730 }).horizonDays).toBe(730);
  });

  it('rejects horizonDays of 0', () => {
    expect(() => createForecastCommand({ horizonDays: 0 })).toThrow(
      ForecastCommandValidationError,
    );
    try {
      createForecastCommand({ horizonDays: 0 });
    } catch (err) {
      const error = err as ForecastCommandValidationError;
      expect(error.violations.some((v) => v.field === 'horizonDays')).toBe(
        true,
      );
    }
  });

  it('rejects horizonDays of 731', () => {
    expect(() => createForecastCommand({ horizonDays: 731 })).toThrow(
      ForecastCommandValidationError,
    );
    try {
      createForecastCommand({ horizonDays: 731 });
    } catch (err) {
      const error = err as ForecastCommandValidationError;
      expect(error.violations.some((v) => v.field === 'horizonDays')).toBe(
        true,
      );
    }
  });

  it('rejects non-integer horizonDays 90.5', () => {
    expect(() => createForecastCommand({ horizonDays: 90.5 })).toThrow(
      ForecastCommandValidationError,
    );
    try {
      createForecastCommand({ horizonDays: 90.5 });
    } catch (err) {
      const error = err as ForecastCommandValidationError;
      expect(error.violations.some((v) => v.field === 'horizonDays')).toBe(
        true,
      );
    }
  });

  it('rejects string horizonDays "90"', () => {
    expect(() => createForecastCommand({ horizonDays: '90' })).toThrow(
      ForecastCommandValidationError,
    );
    try {
      createForecastCommand({ horizonDays: '90' });
    } catch (err) {
      const error = err as ForecastCommandValidationError;
      expect(error.violations.some((v) => v.field === 'horizonDays')).toBe(
        true,
      );
    }
  });

  it('rejects null horizonDays', () => {
    expect(() => createForecastCommand({ horizonDays: null })).toThrow(
      ForecastCommandValidationError,
    );
    try {
      createForecastCommand({ horizonDays: null });
    } catch (err) {
      const error = err as ForecastCommandValidationError;
      expect(error.violations.some((v) => v.field === 'horizonDays')).toBe(
        true,
      );
    }
  });

  it('accepts valid unique accountIds', () => {
    const id1 = '11111111-1111-4111-8111-111111111111';
    const id2 = '22222222-2222-4222-8222-222222222222';
    const command = createForecastCommand({ accountIds: [id1, id2] });
    expect(command.accountIds).toEqual([id1, id2]);
  });

  it('rejects duplicate accountIds', () => {
    const id1 = '11111111-1111-4111-8111-111111111111';
    expect(() => createForecastCommand({ accountIds: [id1, id1] })).toThrow(
      ForecastCommandValidationError,
    );
    try {
      createForecastCommand({ accountIds: [id1, id1] });
    } catch (err) {
      const error = err as ForecastCommandValidationError;
      expect(error.violations.some((v) => v.field === 'accountIds')).toBe(true);
    }
  });

  it('rejects non-uuid in accountIds', () => {
    expect(() =>
      createForecastCommand({ accountIds: ['not-a-valid-uuid'] }),
    ).toThrow(ForecastCommandValidationError);
    try {
      createForecastCommand({ accountIds: ['not-a-valid-uuid'] });
    } catch (err) {
      const error = err as ForecastCommandValidationError;
      expect(error.violations.some((v) => v.field === 'accountIds')).toBe(true);
    }
  });

  it('rejects non-array accountIds', () => {
    expect(() =>
      createForecastCommand({
        accountIds: '11111111-1111-4111-8111-111111111111',
      }),
    ).toThrow(ForecastCommandValidationError);
  });

  it('accepts includeScenarios boolean', () => {
    expect(
      createForecastCommand({ includeScenarios: true }).includeScenarios,
    ).toBe(true);
    expect(
      createForecastCommand({ includeScenarios: false }).includeScenarios,
    ).toBe(false);
  });

  it('rejects non-boolean includeScenarios', () => {
    expect(() => createForecastCommand({ includeScenarios: 'true' })).toThrow(
      ForecastCommandValidationError,
    );
    try {
      createForecastCommand({ includeScenarios: 'true' });
    } catch (err) {
      const error = err as ForecastCommandValidationError;
      expect(error.violations.some((v) => v.field === 'includeScenarios')).toBe(
        true,
      );
    }
  });

  it('rejects unknown top-level properties', () => {
    expect(() => createForecastCommand({ unexpectedProperty: 123 })).toThrow(
      ForecastCommandValidationError,
    );
    try {
      createForecastCommand({ unexpectedProperty: 123 });
    } catch (err) {
      const error = err as ForecastCommandValidationError;
      expect(
        error.violations.some((v) => v.field === 'unexpectedProperty'),
      ).toBe(true);
    }
  });

  it('rejects non-object body', () => {
    expect(() => createForecastCommand('invalid-body')).toThrow(
      ForecastCommandValidationError,
    );
    expect(() => createForecastCommand(null)).toThrow(
      ForecastCommandValidationError,
    );
    expect(() => createForecastCommand([])).toThrow(
      ForecastCommandValidationError,
    );
  });
});

describe('validateForecastId', () => {
  it('accepts valid uuid', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(validateForecastId(id)).toBe(id);
  });

  it('rejects invalid uuid with ForecastQueryValidationError', () => {
    expect(() => validateForecastId('not-a-uuid')).toThrow(
      ForecastQueryValidationError,
    );
    try {
      validateForecastId('not-a-uuid');
    } catch (err) {
      const error = err as ForecastQueryValidationError;
      expect(error.violations.some((v) => v.field === 'forecastId')).toBe(true);
    }
  });
});
