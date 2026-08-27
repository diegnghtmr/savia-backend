import { describe, expect, it } from 'vitest';

import {
  negateAmountMinor,
  toIso,
} from '../../src/accounts/postgres-accounts.adapter.js';

describe('negateAmountMinor', () => {
  it('negates positive amountMinor without number conversion', () => {
    expect(negateAmountMinor('10000')).toBe('-10000');
    expect(negateAmountMinor('9007199254740993')).toBe('-9007199254740993');
  });

  it('negates negative amountMinor without number conversion', () => {
    expect(negateAmountMinor('-10000')).toBe('10000');
    expect(negateAmountMinor('-9007199254740993')).toBe('9007199254740993');
  });

  it('handles zero without producing negative zero', () => {
    expect(negateAmountMinor('0')).toBe('0');
    expect(negateAmountMinor('-0')).toBe('0');
  });
});

describe('toIso', () => {
  it('formats a Date to an ISO string', () => {
    const date = new Date('2026-07-01T12:34:56.789Z');
    expect(toIso(date)).toBe('2026-07-01T12:34:56.789Z');
  });

  it('fails loudly when passed a string instead of a Date', () => {
    expect(() => toIso('2026-07-01 12:34:56+00')).toThrow(TypeError);
  });

  it('fails loudly when passed null or undefined', () => {
    expect(() => toIso(null as unknown as Date)).toThrow(TypeError);
    expect(() => toIso(undefined as unknown as Date)).toThrow(TypeError);
  });

  it('refuses to negate int64-min rather than minting an out-of-range counter-leg', () => {
    // The validator rejects this upstream, but the guard belongs here too: this
    // function is what mints the external leg, and PostgreSQL would answer 22003
    // mid-write, turning a validated request into a 500.
    expect(() => negateAmountMinor('-9223372036854775808')).toThrow(RangeError);
    // One step inside the negatable range still works.
    expect(negateAmountMinor('-9223372036854775807')).toBe(
      '9223372036854775807',
    );
  });
});
