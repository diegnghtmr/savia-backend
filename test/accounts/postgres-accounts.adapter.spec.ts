import { describe, expect, it } from 'vitest';

import { toIso } from '../../src/accounts/postgres-accounts.adapter.js';

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
});
