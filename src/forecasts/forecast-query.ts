import { UUID_PATTERN } from '../platform/uuid.js';
import type { FieldViolation } from '../platform/problem-details.js';

export class ForecastQueryValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Forecast query validation failed.');
    this.name = 'ForecastQueryValidationError';
  }
}

export function validateForecastId(forecastId: unknown): string {
  if (typeof forecastId !== 'string' || !UUID_PATTERN.test(forecastId.trim())) {
    throw new ForecastQueryValidationError([
      Object.freeze({
        field: 'forecastId',
        code: 'invalid',
        message: 'forecastId must be a valid UUID.',
      }),
    ]);
  }
  return forecastId.trim().toLowerCase();
}
