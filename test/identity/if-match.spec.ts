import { describe, expect, it } from 'vitest';

import { parseIfMatch } from '../../src/identity/if-match.js';

describe('parseIfMatch', () => {
  it('returns absent when header is undefined', () => {
    expect(parseIfMatch(undefined)).toEqual({ kind: 'absent' });
  });

  it('returns any when header is "*"', () => {
    expect(parseIfMatch('*')).toEqual({ kind: 'any' });
    expect(parseIfMatch(' * ')).toEqual({ kind: 'any' });
  });

  it('returns version when header is a valid quoted integer', () => {
    expect(parseIfMatch('"7"')).toEqual({ kind: 'version', version: 7 });
  });

  it('trims whitespace around quoted integer', () => {
    expect(parseIfMatch(' "7" ')).toEqual({ kind: 'version', version: 7 });
  });

  it('accepts max 32-bit signed integer (2147483647)', () => {
    expect(parseIfMatch('"2147483647"')).toEqual({
      kind: 'version',
      version: 2_147_483_647,
    });
  });

  it('returns malformed for leading zeros ("007")', () => {
    expect(parseIfMatch('"007"')).toEqual({ kind: 'malformed' });
  });

  it('accepts version 0 ("0")', () => {
    expect(parseIfMatch('"0"')).toEqual({ kind: 'version', version: 0 });
  });

  it('returns malformed for integers exceeding 32-bit signed integer max', () => {
    expect(parseIfMatch('"2147483648"')).toEqual({ kind: 'malformed' });
    expect(parseIfMatch('"100000000000000000000"')).toEqual({
      kind: 'malformed',
    });
  });

  it('returns malformed for non-string values', () => {
    expect(parseIfMatch(null)).toEqual({ kind: 'malformed' });
    expect(parseIfMatch(7)).toEqual({ kind: 'malformed' });
    expect(parseIfMatch(true)).toEqual({ kind: 'malformed' });
    expect(parseIfMatch(['"7"'])).toEqual({ kind: 'malformed' });
    expect(parseIfMatch({})).toEqual({ kind: 'malformed' });
  });

  it('returns malformed when quotes are missing (unquoted 7)', () => {
    expect(parseIfMatch('7')).toEqual({ kind: 'malformed' });
  });

  it('returns malformed for weak entity tags (W/"7")', () => {
    expect(parseIfMatch('W/"7"')).toEqual({ kind: 'malformed' });
  });

  it('returns malformed for empty string or blank string', () => {
    expect(parseIfMatch('')).toEqual({ kind: 'malformed' });
    expect(parseIfMatch('   ')).toEqual({ kind: 'malformed' });
  });
});
