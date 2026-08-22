import { describe, expect, it } from 'vitest';

import { validateIdempotencyKey } from '../../src/identity/idempotency-key.js';

describe('validateIdempotencyKey', () => {
  it('accepts a valid UUID string', () => {
    const key = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
    const result = validateIdempotencyKey(key);
    expect(result).toEqual({ kind: 'ok', key });
  });

  it('accepts and trims leading/trailing whitespace on a valid key', () => {
    const key = '  9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d  ';
    const result = validateIdempotencyKey(key);
    expect(result).toEqual({
      kind: 'ok',
      key: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
    });
  });

  it('accepts a valid UUID in uppercase (case-insensitive)', () => {
    const key = '9B1DEB4D-3B7D-4BAD-9BDD-2B0D7B3DCB6D';
    const result = validateIdempotencyKey(key);
    expect(result).toEqual({ kind: 'ok', key });
  });

  it('rejects not-a-uuid string', () => {
    const result = validateIdempotencyKey('not-a-uuid');
    expect(result).toEqual({
      kind: 'invalid',
      reason: 'Idempotency-Key must be a valid UUID.',
    });
  });

  it('rejects a 255-character non-UUID string', () => {
    const key = 'k'.repeat(255);
    const result = validateIdempotencyKey(key);
    expect(result).toEqual({
      kind: 'invalid',
      reason: 'Idempotency-Key must be a valid UUID.',
    });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['number', 12345],
    ['boolean', true],
    ['object', {}],
    ['array from duplicate headers', ['uuid-1', 'uuid-2']],
  ])('rejects non-string input: %s', (_, value) => {
    const result = validateIdempotencyKey(value);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.reason).toBeTypeOf('string');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['empty string', ''],
    ['spaces only', '   '],
    ['tabs and newlines only', '\t\n\r '],
  ])('rejects empty or whitespace-only strings: %s', (_, value) => {
    const result = validateIdempotencyKey(value);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.reason).toBeTypeOf('string');
    }
  });

  it('rejects strings longer than 255 characters', () => {
    const key = 'k'.repeat(256);
    const result = validateIdempotencyKey(key);
    expect(result).toEqual({
      kind: 'invalid',
      reason: expect.stringMatching(/255/),
    });
  });

  it('rejects strings that exceed 255 characters before or after trim', () => {
    const key = ' ' + 'k'.repeat(256) + ' ';
    const result = validateIdempotencyKey(key);
    expect(result.kind).toBe('invalid');
  });

  it.each([
    ['embedded NUL byte', 'key-\0-invalid'],
    ['leading NUL byte', '\0key'],
    ['trailing NUL byte', 'key\0'],
    ['unicode NUL escape', 'key\u0000suffix'],
  ])(
    'rejects strings containing NUL byte (SQLSTATE 22021 prevention): %s',
    (_, value) => {
      const result = validateIdempotencyKey(value);
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.reason).toMatch(/NUL/i);
      }
    },
  );

  it('never throws on arbitrary input', () => {
    expect(() => validateIdempotencyKey(null)).not.toThrow();
    expect(() => validateIdempotencyKey(undefined)).not.toThrow();
    expect(() => validateIdempotencyKey(Symbol('key'))).not.toThrow();
    expect(() => validateIdempotencyKey(() => {})).not.toThrow();
  });
});
