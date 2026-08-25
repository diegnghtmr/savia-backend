const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const;
const NUMBER_FORMATS = ['1,234.56', '1.234,56'] as const;
// prettier-ignore
const ALL_FIELDS = ['email', 'displayName', 'locale', 'countryCode', 'timezone', 'dateFormat', 'weekStartsOn', 'numberFormat', 'defaultCurrency', 'workspaceName', 'baseCurrency', 'privacyModeEnabled'] as const;
const REPLAY_FIELDS = ['subject', ...ALL_FIELDS] as const;
// prettier-ignore
const EMAIL_PATTERN = /^[A-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?$/i;
const ACTIVE_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
// prettier-ignore
const ISO_COUNTRIES = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));

export type BootstrapDateFormat = (typeof DATE_FORMATS)[number];
export type BootstrapNumberFormat = (typeof NUMBER_FORMATS)[number];
export interface BootstrapCommand {
  readonly subject: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: string;
  readonly countryCode: string;
  readonly timezone: string;
  readonly dateFormat: BootstrapDateFormat;
  readonly weekStartsOn: number;
  readonly numberFormat: BootstrapNumberFormat;
  readonly defaultCurrency: string;
  readonly privacyModeEnabled: boolean;
  readonly workspaceName: string;
  readonly baseCurrency: string;
}
import type { FieldViolation } from '../platform/problem-details.js';

export type { FieldViolation };
export class BootstrapCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Onboarding command validation failed.');
  }
}
export function createBootstrapCommand(
  subject: string,
  input: unknown,
): BootstrapCommand {
  const violations: FieldViolation[] = [];
  const body = readBody(input, violations);
  const command = {
    subject: stringValue(subject, 'subject', violations),
    email: emailValue(body.email, violations),
    displayName: nameValue(body.displayName, 'displayName', violations),
    locale: localeValue(body.locale, violations),
    countryCode: countryValue(body.countryCode, violations),
    timezone: timezoneValue(body.timezone, violations),
    dateFormat: enumValue(
      body.dateFormat,
      'dateFormat',
      DATE_FORMATS,
      violations,
    ),
    weekStartsOn: weekStart(body.weekStartsOn, violations),
    numberFormat: enumValue(
      body.numberFormat,
      'numberFormat',
      NUMBER_FORMATS,
      violations,
    ),
    defaultCurrency: currencyValue(
      body.defaultCurrency,
      'defaultCurrency',
      violations,
    ),
    privacyModeEnabled: booleanValue(body.privacyModeEnabled, violations),
    workspaceName: nameValue(body.workspaceName, 'workspaceName', violations),
    baseCurrency: currencyValue(body.baseCurrency, 'baseCurrency', violations),
  };
  // prettier-ignore
  if (violations.length) throw new BootstrapCommandValidationError(violations.sort((left, right) => left.field.localeCompare(right.field) || left.message.localeCompare(right.message)));
  return Object.freeze(command);
}
export function isExactBootstrapReplay(
  left: BootstrapCommand,
  right: BootstrapCommand,
): boolean {
  return REPLAY_FIELDS.every((field) => left[field] === right[field]);
}

function readBody(
  input: unknown,
  violations: FieldViolation[],
): Readonly<Record<string, unknown>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    return {};
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body))
    if (!ALL_FIELDS.includes(key as never))
      add(violations, key, 'not-allowed', 'is not allowed');
  return body;
}
export function stringValue(
  value: unknown,
  field: string,
  violations: FieldViolation[],
): string {
  if (typeof value !== 'string') {
    add(violations, field, 'required', 'must be a non-empty string');
    return '';
  }
  // PostgreSQL text columns cannot represent U+0000 and raise SQLSTATE 22021
  // (invalid byte sequence for encoding "UTF8": 0x00), which a length check does not catch.
  if (value.includes('\0')) {
    add(
      violations,
      field,
      'invalid-characters',
      'must not contain null characters',
    );
    return '';
  }
  const trimmed = value.trim();
  if (trimmed) return trimmed;
  add(violations, field, 'required', 'must be a non-empty string');
  return '';
}
function emailValue(value: unknown, violations: FieldViolation[]): string {
  const email = stringValue(value, 'email', violations).toLowerCase();
  // prettier-ignore
  if (email.length > 254 || email.indexOf('@') > 64 || !EMAIL_PATTERN.test(email)) add(violations, 'email', 'invalid-email', 'must be a valid email address');
  return email;
}
export function nameValue(
  value: unknown,
  field: string,
  violations: FieldViolation[],
): string {
  const name = stringValue(value, field, violations);
  if ([...name].length > 120)
    add(violations, field, 'max-length', 'must be at most 120 characters');
  return name;
}
export function localeValue(
  value: unknown,
  violations: FieldViolation[],
): string {
  const locale = stringValue(value, 'locale', violations);
  try {
    const [canonical] = Intl.getCanonicalLocales(locale);
    // prettier-ignore
    if (!canonical || !Intl.DateTimeFormat.supportedLocalesOf([canonical]).length) throw new Error();
    return canonical;
  } catch {
    add(violations, 'locale', 'invalid-locale', 'must be a supported locale');
    return '';
  }
}
function countryValue(value: unknown, violations: FieldViolation[]): string {
  const country = stringValue(value, 'countryCode', violations).toUpperCase();
  if (!ISO_COUNTRIES.has(country))
    add(
      violations,
      'countryCode',
      'invalid-country-code',
      'must be an ISO 3166-1 alpha-2 code',
    );
  return country;
}
export function timezoneValue(
  value: unknown,
  violations: FieldViolation[],
): string {
  const timezone = stringValue(value, 'timezone', violations);
  try {
    return new Intl.DateTimeFormat('en', {
      timeZone: timezone,
    }).resolvedOptions().timeZone;
  } catch {
    add(violations, 'timezone', 'invalid-timezone', 'must be an IANA timezone');
    return '';
  }
}
export function currencyValue(
  value: unknown,
  field: string,
  violations: FieldViolation[],
): string {
  const currency = stringValue(value, field, violations).toUpperCase();
  if (!ACTIVE_CURRENCIES.has(currency))
    add(
      violations,
      field,
      'invalid-currency',
      'must be an active ISO 4217 currency',
    );
  return currency;
}
function enumValue<T extends readonly string[]>(
  value: unknown,
  field: string,
  values: T,
  violations: FieldViolation[],
): T[number] {
  const candidate = stringValue(value, field, violations);
  if (!values.includes(candidate as T[number]))
    add(violations, field, 'unsupported', 'is unsupported');
  return candidate as T[number];
}
function weekStart(value: unknown, violations: FieldViolation[]): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 6
  )
    add(
      violations,
      'weekStartsOn',
      'invalid-range',
      'must be an integer from 0 through 6',
    );
  return value as number;
}
function booleanValue(value: unknown, violations: FieldViolation[]): boolean {
  if (value === undefined || typeof value === 'boolean') return value ?? false;
  add(violations, 'privacyModeEnabled', 'invalid-type', 'must be a boolean');
  return false;
}
export function add(
  violations: FieldViolation[],
  field: string,
  code: string,
  message: string,
): void {
  violations.push(Object.freeze({ field, code, message }));
}
