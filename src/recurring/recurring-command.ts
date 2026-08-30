import {
  add,
  enumValue,
  nameValue,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import {
  createTransactionCommand,
  TransactionCommandValidationError,
} from '../ledger/transaction-command.js';
import {
  computeNextOccurrence,
  RECURRING_BEHAVIORS,
  RECURRING_FREQUENCIES,
  type RecurringBehavior,
  type RecurringFrequency,
} from './occurrence.js';
import type { CreateRecurringRuleCommand } from './recurring.port.js';

export type { CreateRecurringRuleCommand };

const ALLOWED_FIELDS = [
  'name',
  'frequency',
  'rrule',
  'behavior',
  'template',
  'startsAt',
  'endsAt',
] as const;

const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export class RecurringCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Recurring rule command validation failed.');
    this.name = 'RecurringCommandValidationError';
  }
}

/**
 * Validates a CreateRecurringRuleRequest body and computes initial nextOccurrenceAt.
 *
 * RULING 51 — nextOccurrenceAt is COMPUTED, never received.
 * RULING 52 — frequency: custom REQUIRES rrule; every other frequency FORBIDS it.
 * RULING 53 — template is FULLY validated at rule-creation time with prefixed field errors.
 * RULING 54 — monthly and yearly arithmetic CLAMPS to the last valid day, and the ANCHOR is preserved.
 * RULING 55 — endsAt must be strictly after the effective start, and a rule that can never fire is rejected.
 * RULING 56 — All timestamps and arithmetic in UTC.
 */
export function createRecurringRuleCommand(
  input: unknown,
): CreateRecurringRuleCommand {
  const violations: FieldViolation[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new RecurringCommandValidationError(Object.freeze(violations));
  }

  const body = input as Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.includes(key as (typeof ALLOWED_FIELDS)[number])) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }

  // 1. name: string 1..120
  const name = nameValue(body.name, 'name', violations, 120);

  // 2. frequency: enum daily|weekly|biweekly|monthly|yearly|custom
  const frequency = enumValue(
    body.frequency,
    'frequency',
    RECURRING_FREQUENCIES,
    violations,
    'frequency must be one of daily, weekly, biweekly, monthly, yearly, custom',
  ) as RecurringFrequency;

  // 3. behavior: enum remind|create_draft|create_pending|confirm_automatically
  const behavior = enumValue(
    body.behavior,
    'behavior',
    RECURRING_BEHAVIORS,
    violations,
    'behavior must be one of remind, create_draft, create_pending, confirm_automatically',
  ) as RecurringBehavior;

  // 4. rrule: string or null (RULING 52)
  let rrule: string | null = null;
  if (frequency === 'custom') {
    if (
      body.rrule === undefined ||
      body.rrule === null ||
      typeof body.rrule !== 'string' ||
      body.rrule.trim() === ''
    ) {
      add(
        violations,
        'rrule',
        'required',
        'rrule is required when frequency is custom (RULING 52)',
      );
    } else {
      rrule = body.rrule.trim();
    }
  } else {
    // Non-custom frequency: rrule omitted or null are equivalent and accepted. Non-null is forbidden.
    if (body.rrule !== undefined && body.rrule !== null) {
      add(
        violations,
        'rrule',
        'not-allowed',
        'rrule is forbidden when frequency is not custom (RULING 52)',
      );
    }
  }

  // 5. template: CreateTransactionRequest (RULING 53)
  let validatedTemplate: CreateRecurringRuleCommand['template'] | undefined;
  if (body.template === undefined) {
    add(violations, 'template', 'required', 'must be an object');
  } else if (
    typeof body.template !== 'object' ||
    body.template === null ||
    Array.isArray(body.template)
  ) {
    add(violations, 'template', 'invalid-type', 'must be an object');
  } else {
    try {
      validatedTemplate = createTransactionCommand(body.template);
    } catch (error) {
      if (error instanceof TransactionCommandValidationError) {
        for (const tv of error.violations) {
          add(violations, `template.${tv.field}`, tv.code, tv.message);
        }
      } else {
        throw error;
      }
    }
  }

  // 6. startsAt: DateTime optional, defaults to now() in UTC (RULING 51, 56)
  let startsAtDate: Date;
  let startsAtString: string;
  if (body.startsAt === undefined) {
    startsAtDate = new Date();
    startsAtString = startsAtDate.toISOString();
  } else if (typeof body.startsAt !== 'string') {
    add(violations, 'startsAt', 'invalid-type', 'must be a string');
    startsAtDate = new Date();
    startsAtString = startsAtDate.toISOString();
  } else {
    const trimmed = body.startsAt.trim();
    if (!trimmed || !ISO_DATE_TIME_PATTERN.test(trimmed)) {
      add(
        violations,
        'startsAt',
        'invalid-date',
        'must be a valid ISO 8601 date-time string',
      );
      startsAtDate = new Date();
      startsAtString = startsAtDate.toISOString();
    } else {
      const parsed = new Date(trimmed);
      if (Number.isNaN(parsed.getTime())) {
        add(
          violations,
          'startsAt',
          'invalid-date',
          'must be a valid ISO 8601 date-time string',
        );
        startsAtDate = new Date();
        startsAtString = startsAtDate.toISOString();
      } else {
        startsAtDate = parsed;
        startsAtString = trimmed;
      }
    }
  }

  // 7. endsAt: date-time or null optional (RULING 55)
  let endsAtString: string | null = null;
  let endsAtDate: Date | null = null;
  if ('endsAt' in body && body.endsAt !== undefined && body.endsAt !== null) {
    if (typeof body.endsAt !== 'string') {
      add(violations, 'endsAt', 'invalid-type', 'must be a string or null');
    } else {
      const trimmed = body.endsAt.trim();
      if (!trimmed || !ISO_DATE_TIME_PATTERN.test(trimmed)) {
        add(
          violations,
          'endsAt',
          'invalid-date',
          'must be a valid ISO 8601 date-time string',
        );
      } else {
        const parsed = new Date(trimmed);
        if (Number.isNaN(parsed.getTime())) {
          add(
            violations,
            'endsAt',
            'invalid-date',
            'must be a valid ISO 8601 date-time string',
          );
        } else {
          endsAtDate = parsed;
          endsAtString = trimmed;

          // RULING 55: endsAt must be strictly after startsAt
          if (endsAtDate.getTime() <= startsAtDate.getTime()) {
            add(
              violations,
              'endsAt',
              'invalid-range',
              'endsAt must be strictly after startsAt (RULING 55)',
            );
          }
        }
      }
    }
  }

  // 8. RULING 51, 54, 55: Compute nextOccurrenceAt and verify rule can fire
  let nextOccurrenceAtString = '';
  let anchorDayOfMonth = startsAtDate.getUTCDate();

  if (
    frequency &&
    RECURRING_FREQUENCIES.includes(frequency) &&
    (frequency !== 'custom' || rrule)
  ) {
    try {
      const occurrenceResult = computeNextOccurrence({
        frequency,
        rrule,
        startsAt: startsAtDate,
        after: new Date(),
      });
      anchorDayOfMonth = occurrenceResult.anchorDayOfMonth;
      nextOccurrenceAtString = occurrenceResult.nextOccurrenceAt.toISOString();

      // RULING 55: A rule that can never fire is rejected with 422
      if (
        endsAtDate !== null &&
        occurrenceResult.nextOccurrenceAt.getTime() > endsAtDate.getTime()
      ) {
        add(
          violations,
          'endsAt',
          'unfireable-rule',
          'next occurrence falls after endsAt (RULING 55)',
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      add(violations, 'rrule', 'invalid-rrule', message);
    }
  }

  if (violations.length > 0) {
    throw new RecurringCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  return Object.freeze({
    name,
    frequency,
    rrule,
    behavior,
    template: validatedTemplate!,
    startsAt: startsAtString,
    endsAt: endsAtString,
    nextOccurrenceAt: nextOccurrenceAtString,
    anchorDayOfMonth,
  });
}
