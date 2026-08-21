import {
  add,
  currencyValue,
  localeValue,
  nameValue,
  timezoneValue,
  type FieldViolation,
} from './bootstrap-command.js';

// prettier-ignore
const PROFILE_UPDATE_FIELDS = ['displayName', 'locale', 'timezone', 'defaultCurrency', 'privacyModeEnabled'] as const;

export interface ProfileUpdateCommand {
  readonly displayName?: string;
  readonly locale?: string;
  readonly timezone?: string;
  readonly defaultCurrency?: string;
  readonly privacyModeEnabled?: boolean;
}

export class ProfileUpdateValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Profile update command validation failed.');
  }
}

export function createProfileUpdateCommand(
  body: unknown,
): ProfileUpdateCommand {
  const violations: FieldViolation[] = [];
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new ProfileUpdateValidationError(violations);
  }

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);

  if (keys.length === 0) {
    add(
      violations,
      'body',
      'empty-update',
      'must contain at least one field to update',
    );
  }

  for (const key of keys) {
    if (!PROFILE_UPDATE_FIELDS.includes(key as never)) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }

  const command: {
    displayName?: string;
    locale?: string;
    timezone?: string;
    defaultCurrency?: string;
    privacyModeEnabled?: boolean;
  } = {};

  if ('displayName' in record) {
    command.displayName = nameValue(
      record.displayName,
      'displayName',
      violations,
    );
  }
  if ('locale' in record) {
    command.locale = localeValue(record.locale, violations);
  }
  if ('timezone' in record) {
    command.timezone = timezoneValue(record.timezone, violations);
  }
  if ('defaultCurrency' in record) {
    command.defaultCurrency = currencyValue(
      record.defaultCurrency,
      'defaultCurrency',
      violations,
    );
  }
  if ('privacyModeEnabled' in record) {
    if (typeof record.privacyModeEnabled === 'boolean') {
      command.privacyModeEnabled = record.privacyModeEnabled;
    } else {
      add(
        violations,
        'privacyModeEnabled',
        'invalid-type',
        'must be a boolean',
      );
    }
  }

  if (violations.length > 0) {
    throw new ProfileUpdateValidationError(
      violations.sort(
        (left, right) =>
          left.field.localeCompare(right.field) ||
          left.message.localeCompare(right.message),
      ),
    );
  }

  return Object.freeze(command);
}
