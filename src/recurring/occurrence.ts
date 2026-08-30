/**
 * Pure occurrence arithmetic module for recurring rules.
 *
 * RULING 51 — nextOccurrenceAt is COMPUTED, never received.
 * RULING 54 — monthly and yearly arithmetic CLAMPS to the last valid day, and the ANCHOR is preserved.
 * RULING 55 — endsAt must be strictly after the effective start, and a rule that can never fire is rejected.
 * RULING 56 — All timestamps are timestamptz and all arithmetic is performed in UTC.
 * RULING 57 — Reject every RRULE part that is not fully honoured by the computation.
 * RULING 58 — nextOccurrenceAt must be strictly in the future.
 */

export type RecurringFrequency =
  | 'daily'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'yearly'
  | 'custom';

export const RECURRING_FREQUENCIES: readonly RecurringFrequency[] = [
  'daily',
  'weekly',
  'biweekly',
  'monthly',
  'yearly',
  'custom',
] as const;

export type RecurringBehavior =
  | 'remind'
  | 'create_draft'
  | 'create_pending'
  | 'confirm_automatically';

export const RECURRING_BEHAVIORS: readonly RecurringBehavior[] = [
  'remind',
  'create_draft',
  'create_pending',
  'confirm_automatically',
] as const;

/**
 * RULING 57 — Reject every RRULE part or constraint that is not fully honoured by the computation.
 *
 * Explicit allowlist per frequency:
 * - DAILY: FREQ, INTERVAL
 * - WEEKLY: FREQ, INTERVAL, BYDAY
 * - MONTHLY: FREQ, INTERVAL, BYMONTHDAY
 * - YEARLY: FREQ, INTERVAL, BYMONTH, BYMONTHDAY
 *
 * Any other part (including COUNT, UNTIL, BYSETPOS, BYYEARDAY, BYWEEKNO, BYHOUR, BYMINUTE, BYSECOND, WKST,
 * or unsupported BY* combinations for the selected frequency) must be rejected with an OccurrenceCalculationError.
 */
export const ALLOWED_RRULE_PARTS_BY_FREQ: Record<
  'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY',
  readonly string[]
> = {
  DAILY: ['FREQ', 'INTERVAL'],
  WEEKLY: ['FREQ', 'INTERVAL', 'BYDAY'],
  MONTHLY: ['FREQ', 'INTERVAL', 'BYMONTHDAY'],
  YEARLY: ['FREQ', 'INTERVAL', 'BYMONTH', 'BYMONTHDAY'],
} as const;

const POSITIVE_INTEGER_REGEX = /^[1-9]\d*$/;
const MONTH_DAY_REGEX = /^-?(?:[1-9]|[12]\d|3[01])$/;
const MONTH_REGEX = /^(?:[1-9]|1[0-2])$/;
const WEEKDAY_CODE_REGEX =
  /^(?:SU|MO|TU|WE|TH|FR|SA)(?:,(?:SU|MO|TU|WE|TH|FR|SA))*$/;

export interface ParsedRRule {
  readonly freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  readonly interval: number;
  readonly byMonthDay?: number;
  readonly byDay?: readonly string[];
  readonly byMonth?: number;
}

export class OccurrenceCalculationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OccurrenceCalculationError';
  }
}

/**
 * Checks if a given year is a leap year in the Gregorian calendar.
 */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Returns the number of days in a given month (0-indexed: 0 = Jan, 1 = Feb, ..., 11 = Dec) in UTC.
 */
export function daysInMonth(year: number, month: number): number {
  const normalisedMonth = ((month % 12) + 12) % 12;
  const normalisedYear = year + Math.floor(month / 12);

  switch (normalisedMonth) {
    case 1: // February
      return isLeapYear(normalisedYear) ? 29 : 28;
    case 3: // April
    case 5: // June
    case 8: // September
    case 10: // November
      return 30;
    default:
      return 31;
  }
}

const DAY_CODES: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

/**
 * Parses an RFC 5545 RRULE string according to RULING 57 (explicit allowlist and strict integer parsing).
 */
export function parseRRule(rruleStr: string): ParsedRRule {
  const clean = rruleStr.trim().replace(/^RRULE:/i, '');
  if (!clean) {
    throw new OccurrenceCalculationError('RRULE string must not be empty.');
  }

  const parts = clean.split(';');
  const dict: Record<string, string> = {};
  const seenKeys = new Set<string>();

  for (const part of parts) {
    if (!part || !part.includes('=')) {
      throw new OccurrenceCalculationError(`Invalid RRULE segment: '${part}'.`);
    }
    const eqIdx = part.indexOf('=');
    const rawKey = part.slice(0, eqIdx).trim().toUpperCase();
    const rawVal = part.slice(eqIdx + 1).trim();

    if (!rawKey || !rawVal) {
      throw new OccurrenceCalculationError(`Invalid RRULE segment: '${part}'.`);
    }
    if (seenKeys.has(rawKey)) {
      throw new OccurrenceCalculationError(
        `Duplicate RRULE part: '${rawKey}'.`,
      );
    }
    seenKeys.add(rawKey);
    dict[rawKey] = rawVal;
  }

  const rawFreq = dict.FREQ?.toUpperCase();
  if (!rawFreq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rawFreq)) {
    throw new OccurrenceCalculationError(
      `Unsupported or missing RRULE FREQ: '${dict.FREQ}'. Must be DAILY, WEEKLY, MONTHLY, or YEARLY.`,
    );
  }
  const freq = rawFreq as 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

  // RULING 57: Validate all parts belong to the frequency allowlist
  const allowedParts = ALLOWED_RRULE_PARTS_BY_FREQ[freq];
  for (const key of seenKeys) {
    if (!allowedParts.includes(key)) {
      throw new OccurrenceCalculationError(
        `Unsupported RRULE part: '${key}' (RULING 57).`,
      );
    }
  }

  let interval = 1;
  if (dict.INTERVAL !== undefined) {
    if (!POSITIVE_INTEGER_REGEX.test(dict.INTERVAL)) {
      throw new OccurrenceCalculationError(
        `Invalid RRULE INTERVAL: '${dict.INTERVAL}'. Must be a positive integer >= 1.`,
      );
    }
    const parsed = Number(dict.INTERVAL);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new OccurrenceCalculationError(
        `Invalid RRULE INTERVAL: '${dict.INTERVAL}'. Must be a positive integer >= 1.`,
      );
    }
    interval = parsed;
  }

  let byMonthDay: number | undefined;
  if (dict.BYMONTHDAY !== undefined) {
    if (!MONTH_DAY_REGEX.test(dict.BYMONTHDAY)) {
      throw new OccurrenceCalculationError(
        `Invalid RRULE BYMONTHDAY: '${dict.BYMONTHDAY}'. Must be between -31 and 31 (excluding 0).`,
      );
    }
    byMonthDay = Number(dict.BYMONTHDAY);
  }

  let byDay: readonly string[] | undefined;
  if (dict.BYDAY !== undefined) {
    const rawByDay = dict.BYDAY.toUpperCase();
    if (!WEEKDAY_CODE_REGEX.test(rawByDay)) {
      throw new OccurrenceCalculationError(
        `Invalid RRULE BYDAY: '${dict.BYDAY}'. Must be comma-separated weekday codes (SU, MO, TU, WE, TH, FR, SA).`,
      );
    }
    const days = rawByDay.split(',');
    byDay = Object.freeze(days);
  }

  let byMonth: number | undefined;
  if (dict.BYMONTH !== undefined) {
    if (!MONTH_REGEX.test(dict.BYMONTH)) {
      throw new OccurrenceCalculationError(
        `Invalid RRULE BYMONTH: '${dict.BYMONTH}'. Must be an integer 1..12.`,
      );
    }
    byMonth = Number(dict.BYMONTH);
  }

  return Object.freeze({
    freq,
    interval,
    ...(byMonthDay !== undefined ? { byMonthDay } : {}),
    ...(byDay !== undefined ? { byDay } : {}),
    ...(byMonth !== undefined ? { byMonth } : {}),
  });
}

export interface ComputeNextOccurrenceOptions {
  readonly frequency: RecurringFrequency;
  readonly rrule?: string | null;
  readonly startsAt?: string | Date;
  readonly currentOccurrence?: string | Date;
  readonly anchorDayOfMonth?: number;
  readonly anchorMonth?: number;
  readonly after?: string | Date;
}

export interface NextOccurrenceResult {
  readonly nextOccurrenceAt: Date;
  readonly anchorDayOfMonth: number;
  readonly anchorMonth: number;
}

/**
 * Computes the next occurrence of a recurring rule based on frequency and anchor in pure UTC.
 *
 * RULING 51: nextOccurrenceAt is COMPUTED, never received.
 * RULING 54: Monthly and yearly arithmetic CLAMPS to the last valid day, preserving anchorDayOfMonth.
 * RULING 56: All calculations in UTC.
 * RULING 57: Fully honours parsed RRULE allowlist.
 * RULING 58: nextOccurrenceAt advances to strictly future date when after is provided.
 */
export function computeNextOccurrence(
  options: ComputeNextOccurrenceOptions,
): NextOccurrenceResult {
  const { frequency, rrule } = options;

  // Determine base date: if currentOccurrence is given, step from it; else step from startsAt (or now)
  const baseDate = options.currentOccurrence
    ? typeof options.currentOccurrence === 'string'
      ? new Date(options.currentOccurrence)
      : options.currentOccurrence
    : options.startsAt
      ? typeof options.startsAt === 'string'
        ? new Date(options.startsAt)
        : options.startsAt
      : new Date();

  if (Number.isNaN(baseDate.getTime())) {
    throw new OccurrenceCalculationError('Invalid base date provided.');
  }

  // Anchor day of month (1..31) in UTC (RULING 54)
  const anchorDayOfMonth =
    options.anchorDayOfMonth !== undefined
      ? options.anchorDayOfMonth
      : baseDate.getUTCDate();

  // Anchor month (0..11) in UTC
  const anchorMonth =
    options.anchorMonth !== undefined
      ? options.anchorMonth
      : baseDate.getUTCMonth();

  let parsedRRule: ParsedRRule | undefined;
  if (frequency === 'custom') {
    if (!rrule) {
      throw new OccurrenceCalculationError(
        'RRULE is required when frequency is custom (RULING 52).',
      );
    }
    parsedRRule = parseRRule(rrule);
  }

  let nextOccurrenceAt = computeSingleOccurrenceStep(
    baseDate,
    frequency,
    parsedRRule,
    anchorDayOfMonth,
    anchorMonth,
  );

  // RULING 58: nextOccurrenceAt must be strictly in the future (> after)
  if (options.after !== undefined) {
    const targetAfter =
      typeof options.after === 'string'
        ? new Date(options.after)
        : options.after;

    if (Number.isNaN(targetAfter.getTime())) {
      throw new OccurrenceCalculationError('Invalid after date provided.');
    }

    const targetTime = targetAfter.getTime();
    let iterations = 0;
    const MAX_ITERATIONS = 10_000;

    while (nextOccurrenceAt.getTime() <= targetTime) {
      if (++iterations > MAX_ITERATIONS) {
        throw new OccurrenceCalculationError(
          'Cannot compute next occurrence: maximum iteration limit reached.',
        );
      }
      nextOccurrenceAt = computeSingleOccurrenceStep(
        nextOccurrenceAt,
        frequency,
        parsedRRule,
        anchorDayOfMonth,
        anchorMonth,
      );
    }
  }

  return {
    nextOccurrenceAt,
    anchorDayOfMonth,
    anchorMonth,
  };
}

function computeSingleOccurrenceStep(
  baseDate: Date,
  frequency: RecurringFrequency,
  parsedRRule: ParsedRRule | undefined,
  anchorDayOfMonth: number,
  anchorMonth: number,
): Date {
  const hours = baseDate.getUTCHours();
  const minutes = baseDate.getUTCMinutes();
  const seconds = baseDate.getUTCSeconds();
  const ms = baseDate.getUTCMilliseconds();

  switch (frequency) {
    case 'daily':
      return new Date(baseDate.getTime() + 86_400_000);

    case 'weekly':
      return new Date(baseDate.getTime() + 7 * 86_400_000);

    case 'biweekly':
      return new Date(baseDate.getTime() + 14 * 86_400_000);

    case 'monthly': {
      // RULING 54: Clamps to last valid day of target month while preserving anchorDayOfMonth.
      const curYear = baseDate.getUTCFullYear();
      const curMonth = baseDate.getUTCMonth();
      const targetMonthIndex = curMonth + 1;
      const targetYear = curYear + Math.floor(targetMonthIndex / 12);
      const targetMonth = ((targetMonthIndex % 12) + 12) % 12;

      const maxDays = daysInMonth(targetYear, targetMonth);
      const clampedDay = Math.min(anchorDayOfMonth, maxDays);

      return new Date(
        Date.UTC(
          targetYear,
          targetMonth,
          clampedDay,
          hours,
          minutes,
          seconds,
          ms,
        ),
      );
    }

    case 'yearly': {
      // RULING 54: Preserves anchor month and anchorDayOfMonth, clamping on leap year boundary.
      const targetYear = baseDate.getUTCFullYear() + 1;
      const targetMonth = anchorMonth;
      const maxDays = daysInMonth(targetYear, targetMonth);
      const clampedDay = Math.min(anchorDayOfMonth, maxDays);

      return new Date(
        Date.UTC(
          targetYear,
          targetMonth,
          clampedDay,
          hours,
          minutes,
          seconds,
          ms,
        ),
      );
    }

    case 'custom': {
      if (!parsedRRule) {
        throw new OccurrenceCalculationError(
          'RRULE is required when frequency is custom (RULING 52).',
        );
      }
      return computeRRuleOccurrence(
        baseDate,
        parsedRRule,
        anchorDayOfMonth,
        anchorMonth,
      );
    }

    default:
      throw new OccurrenceCalculationError(
        `Unknown frequency: '${String(frequency)}'.`,
      );
  }
}

function computeRRuleOccurrence(
  baseDate: Date,
  rrule: ParsedRRule,
  anchorDayOfMonth: number,
  anchorMonth: number,
): Date {
  const hours = baseDate.getUTCHours();
  const minutes = baseDate.getUTCMinutes();
  const seconds = baseDate.getUTCSeconds();
  const ms = baseDate.getUTCMilliseconds();

  switch (rrule.freq) {
    case 'DAILY':
      return new Date(baseDate.getTime() + rrule.interval * 86_400_000);

    case 'WEEKLY': {
      if (!rrule.byDay || rrule.byDay.length === 0) {
        return new Date(baseDate.getTime() + rrule.interval * 7 * 86_400_000);
      }

      // BYDAY list handling
      const currentDayOfWeek = baseDate.getUTCDay();
      const targetDayNumbers = rrule.byDay
        .map((d) => DAY_CODES[d])
        .filter((n): n is number => n !== undefined)
        .sort((a, b) => a - b);

      // Find next day in the same week strictly after currentDayOfWeek
      const nextInWeek = targetDayNumbers.find((d) => d > currentDayOfWeek);
      if (nextInWeek !== undefined) {
        const diffDays = nextInWeek - currentDayOfWeek;
        return new Date(baseDate.getTime() + diffDays * 86_400_000);
      }

      // Otherwise, jump to the first matching day in the next interval cycle
      const firstInWeek = targetDayNumbers[0]!;
      const daysUntilEndOfWeek = 7 - currentDayOfWeek;
      const additionalWeeks = (rrule.interval - 1) * 7;
      const totalDays = daysUntilEndOfWeek + additionalWeeks + firstInWeek;
      return new Date(baseDate.getTime() + totalDays * 86_400_000);
    }

    case 'MONTHLY': {
      const curYear = baseDate.getUTCFullYear();
      const curMonth = baseDate.getUTCMonth();
      const targetMonthIndex = curMonth + rrule.interval;
      const targetYear = curYear + Math.floor(targetMonthIndex / 12);
      const targetMonth = ((targetMonthIndex % 12) + 12) % 12;

      const maxDays = daysInMonth(targetYear, targetMonth);

      let targetDay: number;
      if (rrule.byMonthDay !== undefined) {
        if (rrule.byMonthDay > 0) {
          targetDay = Math.min(rrule.byMonthDay, maxDays);
        } else {
          targetDay = Math.max(1, maxDays + 1 + rrule.byMonthDay);
        }
      } else {
        targetDay = Math.min(anchorDayOfMonth, maxDays);
      }

      return new Date(
        Date.UTC(
          targetYear,
          targetMonth,
          targetDay,
          hours,
          minutes,
          seconds,
          ms,
        ),
      );
    }

    case 'YEARLY': {
      const targetYear = baseDate.getUTCFullYear() + rrule.interval;
      const targetMonth =
        rrule.byMonth !== undefined ? rrule.byMonth - 1 : anchorMonth;
      const maxDays = daysInMonth(targetYear, targetMonth);

      let targetDay: number;
      if (rrule.byMonthDay !== undefined) {
        if (rrule.byMonthDay > 0) {
          targetDay = Math.min(rrule.byMonthDay, maxDays);
        } else {
          targetDay = Math.max(1, maxDays + 1 + rrule.byMonthDay);
        }
      } else {
        targetDay = Math.min(anchorDayOfMonth, maxDays);
      }

      return new Date(
        Date.UTC(
          targetYear,
          targetMonth,
          targetDay,
          hours,
          minutes,
          seconds,
          ms,
        ),
      );
    }
  }
}
