import { describe, expect, it } from 'vitest';

import {
  ACTIVE_CURRENCIES,
  add,
  currencyValue,
  enumValue,
  nameValue,
  optionalBooleanValue,
  optionalStringValue,
  sortViolations,
  stringValue,
} from '../../src/platform/field-validation.js';
import type { FieldViolation } from '../../src/platform/problem-details.js';

describe('platform field-validation primitives', () => {
  describe('add', () => {
    it('pushes a frozen FieldViolation to the array', () => {
      const violations: FieldViolation[] = [];
      add(violations, 'testField', 'test-code', 'test message');

      expect(violations).toHaveLength(1);
      expect(violations[0]).toEqual({
        field: 'testField',
        code: 'test-code',
        message: 'test message',
      });
      expect(Object.isFrozen(violations[0])).toBe(true);
    });
  });

  describe('stringValue', () => {
    it('returns trimmed string for valid non-empty string input', () => {
      const violations: FieldViolation[] = [];
      expect(stringValue('  hello world  ', 'greeting', violations)).toBe(
        'hello world',
      );
      expect(violations).toHaveLength(0);
    });

    it.each([undefined, null, 123, true, false, {}, []])(
      'adds required violation for non-string value %s and returns empty string',
      (badValue) => {
        const violations: FieldViolation[] = [];
        expect(stringValue(badValue, 'field', violations)).toBe('');
        expect(violations).toEqual([
          {
            field: 'field',
            code: 'required',
            message: 'must be a non-empty string',
          },
        ]);
      },
    );

    it.each(['', '   ', '\t\n'])(
      'adds required violation for whitespace-only string %j and returns empty string',
      (emptyValue) => {
        const violations: FieldViolation[] = [];
        expect(stringValue(emptyValue, 'field', violations)).toBe('');
        expect(violations).toEqual([
          {
            field: 'field',
            code: 'required',
            message: 'must be a non-empty string',
          },
        ]);
      },
    );

    it('adds invalid-characters violation when string contains null characters (U+0000)', () => {
      const violations: FieldViolation[] = [];
      expect(stringValue('hello\0world', 'field', violations)).toBe('');
      expect(violations).toEqual([
        {
          field: 'field',
          code: 'invalid-characters',
          message: 'must not contain null characters',
        },
      ]);
    });
  });

  describe('nameValue', () => {
    it('accepts valid string within default 120 code-point limit', () => {
      const violations: FieldViolation[] = [];
      expect(nameValue('  Ada Lovelace  ', 'name', violations)).toBe(
        'Ada Lovelace',
      );
      expect(violations).toHaveLength(0);
    });

    it('enforces length by Unicode code points, not UTF-16 code units', () => {
      // U+1F600 emoji is 2 UTF-16 code units, 1 code point
      const exact120CodePoints = '\u{1F600}' + 'a'.repeat(119);
      expect([...exact120CodePoints].length).toBe(120);
      expect(exact120CodePoints.length).toBe(121);

      const violations120: FieldViolation[] = [];
      expect(nameValue(exact120CodePoints, 'name', violations120)).toBe(
        exact120CodePoints,
      );
      expect(violations120).toHaveLength(0);

      // 121 code points must be rejected
      const exact121CodePoints = '\u{1F600}' + 'a'.repeat(120);
      expect([...exact121CodePoints].length).toBe(121);

      const violations121: FieldViolation[] = [];
      nameValue(exact121CodePoints, 'name', violations121);
      expect(violations121).toEqual([
        {
          field: 'name',
          code: 'max-length',
          message: 'must be at most 120 characters',
        },
      ]);
    });

    it('supports custom maxLength parameter', () => {
      const violations: FieldViolation[] = [];
      nameValue('abcdef', 'shortName', violations, 5);
      expect(violations).toEqual([
        {
          field: 'shortName',
          code: 'max-length',
          message: 'must be at most 5 characters',
        },
      ]);
    });
  });

  describe('currencyValue', () => {
    it('normalizes lowercase currency to uppercase and accepts active currency', () => {
      const violations: FieldViolation[] = [];
      expect(currencyValue('usd', 'currency', violations)).toBe('USD');
      expect(violations).toHaveLength(0);
    });

    it('rejects invalid or inactive currency code with invalid-currency violation', () => {
      const violations: FieldViolation[] = [];
      expect(currencyValue('XYZ', 'currency', violations)).toBe('XYZ');
      expect(violations).toEqual([
        {
          field: 'currency',
          code: 'invalid-currency',
          message: 'must be an active ISO 4217 currency',
        },
      ]);
    });
  });

  describe('enumValue', () => {
    const ALLOWED = ['cash', 'savings', 'checking'] as const;

    it('returns matched value for allowed candidate', () => {
      const violations: FieldViolation[] = [];
      expect(enumValue('savings', 'type', ALLOWED, violations)).toBe('savings');
      expect(violations).toHaveLength(0);
    });

    it('adds unsupported violation with default message when candidate is not in allowed list', () => {
      const violations: FieldViolation[] = [];
      enumValue('crypto', 'type', ALLOWED, violations);
      expect(violations).toEqual([
        {
          field: 'type',
          code: 'unsupported',
          message: 'is unsupported',
        },
      ]);
    });

    it('adds unsupported violation with custom message when provided', () => {
      const violations: FieldViolation[] = [];
      enumValue(
        'crypto',
        'type',
        ALLOWED,
        violations,
        'type must be cash, savings, or checking',
      );
      expect(violations).toEqual([
        {
          field: 'type',
          code: 'unsupported',
          message: 'type must be cash, savings, or checking',
        },
      ]);
    });
  });

  describe('ACTIVE_CURRENCIES', () => {
    it('is a Set containing standard ISO currencies', () => {
      expect(ACTIVE_CURRENCIES).toBeInstanceOf(Set);
      expect(ACTIVE_CURRENCIES.has('USD')).toBe(true);
      expect(ACTIVE_CURRENCIES.has('COP')).toBe(true);
      expect(ACTIVE_CURRENCIES.has('EUR')).toBe(true);
      expect(ACTIVE_CURRENCIES.has('XYZ')).toBe(false);
    });
  });

  describe('optionalStringValue', () => {
    it('returns null when value is undefined without adding violations', () => {
      const violations: FieldViolation[] = [];
      expect(
        optionalStringValue(undefined, 'institution', violations),
      ).toBeNull();
      expect(violations).toHaveLength(0);
    });

    it('returns string untrimmed when value is a valid string', () => {
      const violations: FieldViolation[] = [];
      expect(
        optionalStringValue('  Bancolombia  ', 'institution', violations, 120),
      ).toBe('  Bancolombia  ');
      expect(violations).toHaveLength(0);
    });

    it.each([null, 123, true, false, {}, []])(
      'adds invalid-type violation when defined value %s is not a string',
      (badValue) => {
        const violations: FieldViolation[] = [];
        expect(
          optionalStringValue(badValue, 'institution', violations, 120),
        ).toBeNull();
        expect(violations).toEqual([
          {
            field: 'institution',
            code: 'invalid-type',
            message: 'must be a string',
          },
        ]);
      },
    );

    it('adds invalid-characters violation when value contains null characters', () => {
      const violations: FieldViolation[] = [];
      expect(
        optionalStringValue('Bank\0Corp', 'institution', violations, 120),
      ).toBeNull();
      expect(violations).toEqual([
        {
          field: 'institution',
          code: 'invalid-characters',
          message: 'must not contain null characters',
        },
      ]);
    });

    it('adds max-length violation when code-point length exceeds maxLength', () => {
      const violations: FieldViolation[] = [];
      const overLong = '\u{1F600}' + 'a'.repeat(10);
      expect([...overLong].length).toBe(11);
      expect(
        optionalStringValue(overLong, 'institution', violations, 10),
      ).toBeNull();
      expect(violations).toEqual([
        {
          field: 'institution',
          code: 'max-length',
          message: 'must be at most 10 characters',
        },
      ]);
    });
  });

  describe('optionalBooleanValue', () => {
    it('returns default value when value is undefined', () => {
      const violations: FieldViolation[] = [];
      expect(
        optionalBooleanValue(undefined, 'includeInNetWorth', violations, true),
      ).toBe(true);
      expect(
        optionalBooleanValue(undefined, 'privacyMode', violations, false),
      ).toBe(false);
      expect(violations).toHaveLength(0);
    });

    it('returns provided boolean value when defined', () => {
      const violations: FieldViolation[] = [];
      expect(
        optionalBooleanValue(false, 'includeInNetWorth', violations, true),
      ).toBe(false);
      expect(optionalBooleanValue(true, 'privacyMode', violations, false)).toBe(
        true,
      );
      expect(violations).toHaveLength(0);
    });

    it.each(['true', 'false', 1, 0, null, {}, []])(
      'adds invalid-type violation and returns default value for non-boolean %s',
      (badValue) => {
        const violations: FieldViolation[] = [];
        expect(
          optionalBooleanValue(badValue, 'includeInNetWorth', violations, true),
        ).toBe(true);
        expect(violations).toEqual([
          {
            field: 'includeInNetWorth',
            code: 'invalid-type',
            message: 'must be a boolean',
          },
        ]);
      },
    );
  });

  describe('sortViolations', () => {
    it('sorts violations deterministically by field then message', () => {
      const violations: FieldViolation[] = [
        { field: 'z', code: 'required', message: 'must be string' },
        { field: 'a', code: 'unsupported', message: 'b message' },
        { field: 'a', code: 'unsupported', message: 'a message' },
      ];

      const sorted = sortViolations(violations);
      expect(sorted).toEqual([
        { field: 'a', code: 'unsupported', message: 'a message' },
        { field: 'a', code: 'unsupported', message: 'b message' },
        { field: 'z', code: 'required', message: 'must be string' },
      ]);
    });
  });
});
