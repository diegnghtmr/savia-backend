import { describe, expect, it } from 'vitest';
import {
  computeNextOccurrence,
  daysInMonth,
  isLeapYear,
  parseRRule,
  OccurrenceCalculationError,
} from '../../src/recurring/occurrence.js';

describe('occurrence arithmetic (RULING 51, 54, 56)', () => {
  describe('isLeapYear and daysInMonth helpers', () => {
    it('determines leap years according to Gregorian calendar rules', () => {
      expect(isLeapYear(2024)).toBe(true); // divisible by 4
      expect(isLeapYear(2023)).toBe(false); // not divisible by 4
      expect(isLeapYear(1900)).toBe(false); // divisible by 100 but not 400
      expect(isLeapYear(2000)).toBe(true); // divisible by 400
    });

    it('returns exact days in month for leap and non-leap years', () => {
      expect(daysInMonth(2023, 0)).toBe(31); // Jan
      expect(daysInMonth(2023, 1)).toBe(28); // Feb non-leap
      expect(daysInMonth(2024, 1)).toBe(29); // Feb leap
      expect(daysInMonth(2023, 3)).toBe(30); // Apr
      expect(daysInMonth(2023, 11)).toBe(31); // Dec
    });
  });

  describe('RULING 54: monthly clamping and anchor preservation', () => {
    it('Jan 31 -> Feb 28 in non-leap year (2023)', () => {
      const result = computeNextOccurrence({
        frequency: 'monthly',
        startsAt: '2023-01-31T14:30:00.000Z',
      });
      expect(result.nextOccurrenceAt.toISOString()).toBe(
        '2023-02-28T14:30:00.000Z',
      );
      expect(result.anchorDayOfMonth).toBe(31);
    });

    it('Jan 31 -> Feb 29 in leap year (2024)', () => {
      const result = computeNextOccurrence({
        frequency: 'monthly',
        startsAt: '2024-01-31T10:00:00.000Z',
      });
      expect(result.nextOccurrenceAt.toISOString()).toBe(
        '2024-02-29T10:00:00.000Z',
      );
      expect(result.anchorDayOfMonth).toBe(31);
    });

    it('Feb 28 -> Mar 31 with anchor preserved (NOT Mar 28)', () => {
      // Step from the clamped Feb 28 occurrence using preserved anchorDayOfMonth = 31
      const result = computeNextOccurrence({
        frequency: 'monthly',
        currentOccurrence: '2023-02-28T14:30:00.000Z',
        anchorDayOfMonth: 31,
      });
      expect(result.nextOccurrenceAt.toISOString()).toBe(
        '2023-03-31T14:30:00.000Z',
      );
      expect(result.anchorDayOfMonth).toBe(31);
    });

    it('Jan 29 in leap year (2024) -> Feb 29', () => {
      const result = computeNextOccurrence({
        frequency: 'monthly',
        startsAt: '2024-01-29T08:00:00.000Z',
      });
      expect(result.nextOccurrenceAt.toISOString()).toBe(
        '2024-02-29T08:00:00.000Z',
      );
      expect(result.anchorDayOfMonth).toBe(29);
    });

    it('Jan 30 in leap year (2024) -> Feb 29', () => {
      const result = computeNextOccurrence({
        frequency: 'monthly',
        startsAt: '2024-01-30T08:00:00.000Z',
      });
      expect(result.nextOccurrenceAt.toISOString()).toBe(
        '2024-02-29T08:00:00.000Z',
      );
      expect(result.anchorDayOfMonth).toBe(30);
    });

    it('Jan 31 in leap year (2024) -> Feb 29', () => {
      const result = computeNextOccurrence({
        frequency: 'monthly',
        startsAt: '2024-01-31T08:00:00.000Z',
      });
      expect(result.nextOccurrenceAt.toISOString()).toBe(
        '2024-02-29T08:00:00.000Z',
      );
      expect(result.anchorDayOfMonth).toBe(31);
    });

    it('Feb 29 with yearly -> Feb 28 in following non-leap year (and restores 29 in leap year)', () => {
      // 1. Initial yearly from leap year 2024-02-29
      const year1 = computeNextOccurrence({
        frequency: 'yearly',
        startsAt: '2024-02-29T12:00:00.000Z',
      });
      expect(year1.nextOccurrenceAt.toISOString()).toBe(
        '2025-02-28T12:00:00.000Z',
      );
      expect(year1.anchorDayOfMonth).toBe(29);
      expect(year1.anchorMonth).toBe(1);

      // 2. Step to 2026 (non-leap)
      const year2 = computeNextOccurrence({
        frequency: 'yearly',
        currentOccurrence: year1.nextOccurrenceAt,
        anchorDayOfMonth: year1.anchorDayOfMonth,
        anchorMonth: year1.anchorMonth,
      });
      expect(year2.nextOccurrenceAt.toISOString()).toBe(
        '2026-02-28T12:00:00.000Z',
      );

      // 3. Step to 2027 (non-leap)
      const year3 = computeNextOccurrence({
        frequency: 'yearly',
        currentOccurrence: year2.nextOccurrenceAt,
        anchorDayOfMonth: year2.anchorDayOfMonth,
        anchorMonth: year2.anchorMonth,
      });
      expect(year3.nextOccurrenceAt.toISOString()).toBe(
        '2027-02-28T12:00:00.000Z',
      );

      // 4. Step to 2028 (leap year) -> anchor preserved, produces Feb 29!
      const year4 = computeNextOccurrence({
        frequency: 'yearly',
        currentOccurrence: year3.nextOccurrenceAt,
        anchorDayOfMonth: year3.anchorDayOfMonth,
        anchorMonth: year3.anchorMonth,
      });
      expect(year4.nextOccurrenceAt.toISOString()).toBe(
        '2028-02-29T12:00:00.000Z',
      );
    });

    it('monthly across year boundary (Dec 31 -> Jan 31)', () => {
      const result = computeNextOccurrence({
        frequency: 'monthly',
        startsAt: '2023-12-31T23:59:59.999Z',
      });
      expect(result.nextOccurrenceAt.toISOString()).toBe(
        '2024-01-31T23:59:59.999Z',
      );
      expect(result.anchorDayOfMonth).toBe(31);
    });
  });

  describe('Standard frequencies: daily, weekly, biweekly', () => {
    it('computes daily occurrence (adds exactly 24 hours in UTC)', () => {
      const result = computeNextOccurrence({
        frequency: 'daily',
        startsAt: '2023-06-15T09:15:00.000Z',
      });
      expect(result.nextOccurrenceAt.toISOString()).toBe(
        '2023-06-16T09:15:00.000Z',
      );
    });

    it('computes weekly occurrence (adds exactly 7 days in UTC)', () => {
      const result = computeNextOccurrence({
        frequency: 'weekly',
        startsAt: '2023-06-15T09:15:00.000Z',
      });
      expect(result.nextOccurrenceAt.toISOString()).toBe(
        '2023-06-22T09:15:00.000Z',
      );
    });

    it('computes biweekly occurrence (adds exactly 14 days in UTC)', () => {
      const result = computeNextOccurrence({
        frequency: 'biweekly',
        startsAt: '2023-06-15T09:15:00.000Z',
      });
      expect(result.nextOccurrenceAt.toISOString()).toBe(
        '2023-06-29T09:15:00.000Z',
      );
    });
  });

  describe('Custom frequency with RRULE (RULING 52)', () => {
    it('throws OccurrenceCalculationError when rrule is missing for custom frequency', () => {
      expect(() =>
        computeNextOccurrence({
          frequency: 'custom',
          startsAt: '2023-01-01T00:00:00.000Z',
        }),
      ).toThrow(OccurrenceCalculationError);
    });

    it('computes custom daily with interval (FREQ=DAILY;INTERVAL=3)', () => {
      const result = computeNextOccurrence({
        frequency: 'custom',
        rrule: 'FREQ=DAILY;INTERVAL=3',
        startsAt: '2023-01-01T12:00:00.000Z',
      });
      expect(result.nextOccurrenceAt.toISOString()).toBe(
        '2023-01-04T12:00:00.000Z',
      );
    });

    it('computes custom weekly with interval (FREQ=WEEKLY;INTERVAL=2)', () => {
      const result = computeNextOccurrence({
        frequency: 'custom',
        rrule: 'FREQ=WEEKLY;INTERVAL=2',
        startsAt: '2023-01-01T12:00:00.000Z',
      });
      expect(result.nextOccurrenceAt.toISOString()).toBe(
        '2023-01-15T12:00:00.000Z',
      );
    });

    it('computes custom weekly with BYDAY (FREQ=WEEKLY;BYDAY=MO,WE,FR)', () => {
      // 2023-01-02 is Monday
      const resMonday = computeNextOccurrence({
        frequency: 'custom',
        rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
        startsAt: '2023-01-02T10:00:00.000Z',
      });
      expect(resMonday.nextOccurrenceAt.toISOString()).toBe(
        '2023-01-04T10:00:00.000Z',
      ); // Wednesday

      // Step from Wednesday -> Friday
      const resWed = computeNextOccurrence({
        frequency: 'custom',
        rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
        currentOccurrence: resMonday.nextOccurrenceAt,
      });
      expect(resWed.nextOccurrenceAt.toISOString()).toBe(
        '2023-01-06T10:00:00.000Z',
      ); // Friday

      // Step from Friday -> Next Monday
      const resFri = computeNextOccurrence({
        frequency: 'custom',
        rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
        currentOccurrence: resWed.nextOccurrenceAt,
      });
      expect(resFri.nextOccurrenceAt.toISOString()).toBe(
        '2023-01-09T10:00:00.000Z',
      ); // Next Monday
    });

    it('computes custom monthly with BYMONTHDAY (FREQ=MONTHLY;BYMONTHDAY=15;INTERVAL=2)', () => {
      const result = computeNextOccurrence({
        frequency: 'custom',
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=15;INTERVAL=2',
        startsAt: '2023-01-01T00:00:00.000Z',
      });
      expect(result.nextOccurrenceAt.toISOString()).toBe(
        '2023-03-15T00:00:00.000Z',
      );
    });

    it('computes custom monthly with negative BYMONTHDAY (FREQ=MONTHLY;BYMONTHDAY=-1)', () => {
      const result = computeNextOccurrence({
        frequency: 'custom',
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
        startsAt: '2023-01-15T00:00:00.000Z',
      });
      expect(result.nextOccurrenceAt.toISOString()).toBe(
        '2023-02-28T00:00:00.000Z',
      );
    });
  });

  describe('RULING 57: RRULE allowlist, strict parsing, and unsupported parts rejection', () => {
    it('rejects COUNT constraint as unsupported (RULING 57)', () => {
      expect(() => parseRRule('FREQ=DAILY;COUNT=1')).toThrow(
        OccurrenceCalculationError,
      );
      expect(() => parseRRule('FREQ=DAILY;COUNT=1')).toThrow(/COUNT/i);
    });

    it('rejects UNTIL constraint as unsupported (RULING 57)', () => {
      expect(() => parseRRule('FREQ=DAILY;UNTIL=20261231T000000Z')).toThrow(
        OccurrenceCalculationError,
      );
      expect(() => parseRRule('FREQ=DAILY;UNTIL=20261231T000000Z')).toThrow(
        /UNTIL/i,
      );
    });

    it('rejects unsupported BY* parts per frequency (RULING 57)', () => {
      // BYDAY is only allowed for WEEKLY
      expect(() => parseRRule('FREQ=DAILY;BYDAY=MO')).toThrow(
        OccurrenceCalculationError,
      );
      expect(() => parseRRule('FREQ=MONTHLY;BYDAY=MO')).toThrow(
        OccurrenceCalculationError,
      );
      expect(() => parseRRule('FREQ=YEARLY;BYDAY=MO')).toThrow(
        OccurrenceCalculationError,
      );

      // BYMONTHDAY is only allowed for MONTHLY and YEARLY
      expect(() => parseRRule('FREQ=DAILY;BYMONTHDAY=15')).toThrow(
        OccurrenceCalculationError,
      );
      expect(() => parseRRule('FREQ=WEEKLY;BYMONTHDAY=15')).toThrow(
        OccurrenceCalculationError,
      );

      // BYMONTH is only allowed for YEARLY
      expect(() => parseRRule('FREQ=DAILY;BYMONTH=6')).toThrow(
        OccurrenceCalculationError,
      );
      expect(() => parseRRule('FREQ=WEEKLY;BYMONTH=6')).toThrow(
        OccurrenceCalculationError,
      );
      expect(() => parseRRule('FREQ=MONTHLY;BYMONTH=6')).toThrow(
        OccurrenceCalculationError,
      );
    });

    it('rejects non-allowlisted RFC 5545 parts (BYSETPOS, WKST, BYHOUR, etc.)', () => {
      expect(() => parseRRule('FREQ=DAILY;BYSETPOS=1')).toThrow(
        OccurrenceCalculationError,
      );
      expect(() => parseRRule('FREQ=WEEKLY;WKST=MO')).toThrow(
        OccurrenceCalculationError,
      );
      expect(() => parseRRule('FREQ=DAILY;BYHOUR=12')).toThrow(
        OccurrenceCalculationError,
      );
      expect(() => parseRRule('FREQ=DAILY;BYMINUTE=30')).toThrow(
        OccurrenceCalculationError,
      );
      expect(() => parseRRule('FREQ=DAILY;BYSECOND=0')).toThrow(
        OccurrenceCalculationError,
      );
      expect(() => parseRRule('FREQ=YEARLY;BYYEARDAY=100')).toThrow(
        OccurrenceCalculationError,
      );
      expect(() => parseRRule('FREQ=YEARLY;BYWEEKNO=20')).toThrow(
        OccurrenceCalculationError,
      );
    });

    describe('Strict integer and token parsing (RULING 57)', () => {
      it('rejects INTERVAL with trailing characters, empty value, 0, negative, or leading plus', () => {
        expect(() => parseRRule('FREQ=DAILY;INTERVAL=2junk')).toThrow(
          OccurrenceCalculationError,
        );
        expect(() => parseRRule('FREQ=DAILY;INTERVAL=')).toThrow(
          OccurrenceCalculationError,
        );
        expect(() => parseRRule('FREQ=DAILY;INTERVAL=0')).toThrow(
          OccurrenceCalculationError,
        );
        expect(() => parseRRule('FREQ=DAILY;INTERVAL=-1')).toThrow(
          OccurrenceCalculationError,
        );
        expect(() => parseRRule('FREQ=DAILY;INTERVAL=+2')).toThrow(
          OccurrenceCalculationError,
        );
        expect(() => parseRRule('FREQ=DAILY;INTERVAL=abc')).toThrow(
          OccurrenceCalculationError,
        );
      });

      it('rejects BYMONTHDAY with trailing characters, empty, 0, out of range, or plus sign', () => {
        expect(() => parseRRule('FREQ=MONTHLY;BYMONTHDAY=15junk')).toThrow(
          OccurrenceCalculationError,
        );
        expect(() => parseRRule('FREQ=MONTHLY;BYMONTHDAY=')).toThrow(
          OccurrenceCalculationError,
        );
        expect(() => parseRRule('FREQ=MONTHLY;BYMONTHDAY=0')).toThrow(
          OccurrenceCalculationError,
        );
        expect(() => parseRRule('FREQ=MONTHLY;BYMONTHDAY=32')).toThrow(
          OccurrenceCalculationError,
        );
        expect(() => parseRRule('FREQ=MONTHLY;BYMONTHDAY=-32')).toThrow(
          OccurrenceCalculationError,
        );
        expect(() => parseRRule('FREQ=MONTHLY;BYMONTHDAY=+5')).toThrow(
          OccurrenceCalculationError,
        );
      });

      it('rejects BYMONTH with trailing characters, empty, 0, >12, or leading plus', () => {
        expect(() => parseRRule('FREQ=YEARLY;BYMONTH=1junk')).toThrow(
          OccurrenceCalculationError,
        );
        expect(() => parseRRule('FREQ=YEARLY;BYMONTH=')).toThrow(
          OccurrenceCalculationError,
        );
        expect(() => parseRRule('FREQ=YEARLY;BYMONTH=0')).toThrow(
          OccurrenceCalculationError,
        );
        expect(() => parseRRule('FREQ=YEARLY;BYMONTH=13')).toThrow(
          OccurrenceCalculationError,
        );
        expect(() => parseRRule('FREQ=YEARLY;BYMONTH=+3')).toThrow(
          OccurrenceCalculationError,
        );
      });

      it('rejects BYDAY with numeric prefixes or invalid codes', () => {
        expect(() => parseRRule('FREQ=WEEKLY;BYDAY=+1MO')).toThrow(
          OccurrenceCalculationError,
        );
        expect(() => parseRRule('FREQ=WEEKLY;BYDAY=1MO')).toThrow(
          OccurrenceCalculationError,
        );
        expect(() => parseRRule('FREQ=WEEKLY;BYDAY=-1FR')).toThrow(
          OccurrenceCalculationError,
        );
        expect(() => parseRRule('FREQ=WEEKLY;BYDAY=MO,INVALID')).toThrow(
          OccurrenceCalculationError,
        );
        expect(() => parseRRule('FREQ=WEEKLY;BYDAY=MO,,TU')).toThrow(
          OccurrenceCalculationError,
        );
      });
    });

    describe('Positive tests for all allowlisted combinations', () => {
      it('parses allowlisted DAILY rules', () => {
        expect(parseRRule('FREQ=DAILY')).toEqual({
          freq: 'DAILY',
          interval: 1,
        });
        expect(parseRRule('FREQ=DAILY;INTERVAL=3')).toEqual({
          freq: 'DAILY',
          interval: 3,
        });
      });

      it('parses allowlisted WEEKLY rules', () => {
        expect(parseRRule('FREQ=WEEKLY')).toEqual({
          freq: 'WEEKLY',
          interval: 1,
        });
        expect(parseRRule('FREQ=WEEKLY;INTERVAL=2')).toEqual({
          freq: 'WEEKLY',
          interval: 2,
        });
        expect(parseRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR')).toEqual({
          freq: 'WEEKLY',
          interval: 1,
          byDay: ['MO', 'WE', 'FR'],
        });
        expect(parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH')).toEqual({
          freq: 'WEEKLY',
          interval: 2,
          byDay: ['TU', 'TH'],
        });
      });

      it('parses allowlisted MONTHLY rules', () => {
        expect(parseRRule('FREQ=MONTHLY')).toEqual({
          freq: 'MONTHLY',
          interval: 1,
        });
        expect(parseRRule('FREQ=MONTHLY;INTERVAL=2')).toEqual({
          freq: 'MONTHLY',
          interval: 2,
        });
        expect(parseRRule('FREQ=MONTHLY;BYMONTHDAY=15')).toEqual({
          freq: 'MONTHLY',
          interval: 1,
          byMonthDay: 15,
        });
        expect(parseRRule('FREQ=MONTHLY;BYMONTHDAY=-1')).toEqual({
          freq: 'MONTHLY',
          interval: 1,
          byMonthDay: -1,
        });
        expect(parseRRule('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=-5')).toEqual({
          freq: 'MONTHLY',
          interval: 3,
          byMonthDay: -5,
        });
      });

      it('parses allowlisted YEARLY rules', () => {
        expect(parseRRule('FREQ=YEARLY')).toEqual({
          freq: 'YEARLY',
          interval: 1,
        });
        expect(parseRRule('FREQ=YEARLY;INTERVAL=2')).toEqual({
          freq: 'YEARLY',
          interval: 2,
        });
        expect(parseRRule('FREQ=YEARLY;BYMONTH=6')).toEqual({
          freq: 'YEARLY',
          interval: 1,
          byMonth: 6,
        });
        expect(parseRRule('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=28')).toEqual({
          freq: 'YEARLY',
          interval: 1,
          byMonth: 2,
          byMonthDay: 28,
        });
        expect(parseRRule('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1')).toEqual({
          freq: 'YEARLY',
          interval: 1,
          byMonth: 2,
          byMonthDay: -1,
        });
        expect(
          parseRRule('FREQ=YEARLY;INTERVAL=2;BYMONTH=4;BYMONTHDAY=15'),
        ).toEqual({
          freq: 'YEARLY',
          interval: 2,
          byMonth: 4,
          byMonthDay: 15,
        });
      });
    });
  });

  describe('RULING 58: nextOccurrenceAt must be strictly in the future', () => {
    it('advances past startsAt to the first occurrence strictly after now for daily', () => {
      const result = computeNextOccurrence({
        frequency: 'daily',
        startsAt: '2020-01-01T12:00:00.000Z',
        after: '2026-08-29T12:00:00.000Z',
      });
      expect(result.nextOccurrenceAt.toISOString()).toBe(
        '2026-08-30T12:00:00.000Z',
      );
    });

    it('advances past startsAt to the first occurrence strictly after now for weekly', () => {
      // 2020-01-01 is Wednesday.
      // 2026-08-29 is Saturday. Next Wednesday is 2026-09-02.
      const result = computeNextOccurrence({
        frequency: 'weekly',
        startsAt: '2020-01-01T12:00:00.000Z',
        after: '2026-08-29T12:00:00.000Z',
      });
      expect(result.nextOccurrenceAt.toISOString()).toBe(
        '2026-09-02T12:00:00.000Z',
      );
    });

    it('advances past startsAt to the first occurrence strictly after now for biweekly', () => {
      const result = computeNextOccurrence({
        frequency: 'biweekly',
        startsAt: '2020-01-01T12:00:00.000Z',
        after: '2026-08-29T12:00:00.000Z',
      });
      // 2020-01-01 + N * 14 days
      expect(result.nextOccurrenceAt.getTime()).toBeGreaterThan(
        new Date('2026-08-29T12:00:00.000Z').getTime(),
      );
      // Difference from 2020-01-01 in days must be divisible by 14
      const diffDays = Math.round(
        (result.nextOccurrenceAt.getTime() -
          new Date('2020-01-01T12:00:00.000Z').getTime()) /
          86_400_000,
      );
      expect(diffDays % 14).toBe(0);
    });

    it('advances past startsAt to the first occurrence strictly after now for monthly (preserving anchor)', () => {
      const result = computeNextOccurrence({
        frequency: 'monthly',
        startsAt: '2020-01-31T14:30:00.000Z',
        after: '2026-08-29T12:00:00.000Z',
      });
      expect(result.nextOccurrenceAt.toISOString()).toBe(
        '2026-08-31T14:30:00.000Z',
      );
      expect(result.anchorDayOfMonth).toBe(31);
    });

    it('advances past startsAt to the first occurrence strictly after now for yearly (preserving anchor)', () => {
      const result = computeNextOccurrence({
        frequency: 'yearly',
        startsAt: '2020-02-29T12:00:00.000Z',
        after: '2026-08-29T12:00:00.000Z',
      });
      // Next Feb after Aug 2026 is Feb 2027 (non-leap -> Feb 28)
      expect(result.nextOccurrenceAt.toISOString()).toBe(
        '2027-02-28T12:00:00.000Z',
      );
      expect(result.anchorDayOfMonth).toBe(29);
      expect(result.anchorMonth).toBe(1);
    });

    it('advances past startsAt to the first occurrence strictly after now for custom RRULE', () => {
      const result = computeNextOccurrence({
        frequency: 'custom',
        rrule: 'FREQ=DAILY;INTERVAL=5',
        startsAt: '2020-01-01T10:00:00.000Z',
        after: '2026-08-29T12:00:00.000Z',
      });
      expect(result.nextOccurrenceAt.getTime()).toBeGreaterThan(
        new Date('2026-08-29T12:00:00.000Z').getTime(),
      );
      const diffDays = Math.round(
        (result.nextOccurrenceAt.getTime() -
          new Date('2020-01-01T10:00:00.000Z').getTime()) /
          86_400_000,
      );
      expect(diffDays % 5).toBe(0);
    });
  });
});
