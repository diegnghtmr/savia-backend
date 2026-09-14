import {
  add,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import type { ForecastRequest } from './forecast.port.js';

export class ForecastCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Forecast command validation failed.');
    this.name = 'ForecastCommandValidationError';
  }
}

const TOP_LEVEL_FIELDS = [
  'horizonDays',
  'accountIds',
  'includeScenarios',
] as const;

export function createForecastCommand(input: unknown): ForecastRequest {
  const violations: FieldViolation[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new ForecastCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  const body = input as Record<string, unknown>;

  Object.keys(body).forEach((key) => {
    if (!TOP_LEVEL_FIELDS.includes(key as (typeof TOP_LEVEL_FIELDS)[number])) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  });

  let horizonDays = 90;
  if (body.horizonDays !== undefined) {
    if (
      typeof body.horizonDays !== 'number' ||
      !Number.isInteger(body.horizonDays) ||
      body.horizonDays < 1 ||
      body.horizonDays > 730
    ) {
      add(
        violations,
        'horizonDays',
        'invalid',
        'must be an integer between 1 and 730',
      );
    } else {
      horizonDays = body.horizonDays;
    }
  }

  let accountIds: string[] | undefined = undefined;
  if (body.accountIds !== undefined) {
    if (!Array.isArray(body.accountIds)) {
      add(
        violations,
        'accountIds',
        'invalid-type',
        'must be an array of UUIDs',
      );
    } else {
      const ids: string[] = [];
      const seen = new Set<string>();
      let hasDuplicate = false;
      let hasInvalidUuid = false;

      for (const item of body.accountIds) {
        if (typeof item !== 'string' || !UUID_PATTERN.test(item)) {
          hasInvalidUuid = true;
        } else {
          if (seen.has(item)) {
            hasDuplicate = true;
          }
          seen.add(item);
          ids.push(item);
        }
      }

      if (hasInvalidUuid) {
        add(
          violations,
          'accountIds',
          'invalid',
          'each accountId must be a valid UUID',
        );
      }
      if (hasDuplicate) {
        add(
          violations,
          'accountIds',
          'duplicate',
          'accountIds must not contain duplicates',
        );
      }
      if (!hasInvalidUuid && !hasDuplicate) {
        accountIds = ids;
      }
    }
  }

  let includeScenarios = false;
  if (body.includeScenarios !== undefined) {
    if (typeof body.includeScenarios !== 'boolean') {
      add(violations, 'includeScenarios', 'invalid-type', 'must be a boolean');
    } else {
      includeScenarios = body.includeScenarios;
    }
  }

  if (violations.length > 0) {
    throw new ForecastCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  return {
    horizonDays,
    accountIds,
    includeScenarios,
  };
}
