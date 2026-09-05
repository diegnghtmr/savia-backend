import {
  add,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import {
  SCENARIO_ASSUMPTION_TYPES,
  type CreateScenarioRequest,
  type ScenarioAssumption,
  type ScenarioAssumptionType,
} from './scenario.port.js';

export class ScenarioCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Scenario command validation failed.');
    this.name = 'ScenarioCommandValidationError';
  }
}

const TOP_LEVEL_FIELDS = ['name', 'description', 'assumptions'] as const;
const ASSUMPTION_FIELDS = ['type', 'value'] as const;

export function createScenarioCommand(input: unknown): CreateScenarioRequest {
  const violations: FieldViolation[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new ScenarioCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  const body = input as Record<string, unknown>;

  Object.keys(body).forEach((key) => {
    if (!TOP_LEVEL_FIELDS.includes(key as (typeof TOP_LEVEL_FIELDS)[number])) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  });

  const name = body.name;
  if (typeof name !== 'string' || name.length < 1 || name.length > 120) {
    add(violations, 'name', 'invalid', 'must be between 1 and 120 characters');
  }

  const description = body.description;
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string' || description.length > 1000) {
      add(
        violations,
        'description',
        'invalid',
        'must be a string at most 1000 characters or null',
      );
    }
  }

  const assumptionsRaw = body.assumptions;
  const validatedAssumptions: ScenarioAssumption[] = [];

  if (!Array.isArray(assumptionsRaw)) {
    add(violations, 'assumptions', 'invalid', 'must be an array');
  } else if (assumptionsRaw.length === 0) {
    add(
      violations,
      'assumptions',
      'invalid',
      'must contain at least 1 assumption',
    );
  } else {
    for (let index = 0; index < assumptionsRaw.length; index += 1) {
      const item = assumptionsRaw[index];
      const prefix = `assumptions.${index}`;

      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        add(violations, prefix, 'invalid', 'must be an object');
        continue;
      }

      const itemRecord = item as Record<string, unknown>;

      Object.keys(itemRecord).forEach((key) => {
        if (
          !ASSUMPTION_FIELDS.includes(key as (typeof ASSUMPTION_FIELDS)[number])
        ) {
          add(violations, `${prefix}.${key}`, 'not-allowed', 'is not allowed');
        }
      });

      const type = itemRecord.type;
      const isAllowedType =
        typeof type === 'string' &&
        SCENARIO_ASSUMPTION_TYPES.includes(type as ScenarioAssumptionType);

      if (!isAllowedType) {
        add(
          violations,
          `${prefix}.type`,
          'invalid',
          'must be a supported assumption type',
        );
      }

      const value = itemRecord.value;
      const isObjectValue =
        typeof value === 'object' && value !== null && !Array.isArray(value);

      if (!isObjectValue) {
        add(violations, `${prefix}.value`, 'invalid', 'must be an object');
      }

      if (isAllowedType && isObjectValue) {
        validatedAssumptions.push({
          type: type as ScenarioAssumptionType,
          value: value as Record<string, unknown>,
        });
      }
    }
  }

  if (violations.length > 0) {
    throw new ScenarioCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  return {
    name: name as string,
    ...(description !== undefined
      ? { description: description as string | null }
      : {}),
    assumptions: validatedAssumptions,
  };
}
