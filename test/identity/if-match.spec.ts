import { describe, expect, it } from 'vitest';

import { parseIfMatch } from '../../src/platform/if-match.js';

describe('parseIfMatch', () => {
  it('returns absent when header is undefined', () => {
    expect(parseIfMatch(undefined)).toEqual({ kind: 'absent' });
  });

  it('returns any when header is "*"', () => {
    expect(parseIfMatch('*')).toEqual({ kind: 'any' });
    expect(parseIfMatch(' * ')).toEqual({ kind: 'any' });
    expect(parseIfMatch(['*'])).toEqual({ kind: 'any' });
  });

  it('returns versions when header is a valid quoted integer', () => {
    expect(parseIfMatch('"7"')).toEqual({ kind: 'versions', versions: [7] });
  });

  it('trims whitespace around quoted integer', () => {
    expect(parseIfMatch(' "7" ')).toEqual({ kind: 'versions', versions: [7] });
  });

  it('parses comma-separated list of strong entity tags', () => {
    expect(parseIfMatch('"1", "999"')).toEqual({
      kind: 'versions',
      versions: [1, 999],
    });
    expect(parseIfMatch('"1", "2", "3"')).toEqual({
      kind: 'versions',
      versions: [1, 2, 3],
    });
  });

  it('parses duplicated header array by joining elements as one list', () => {
    expect(parseIfMatch(['"1"', '"999"'])).toEqual({
      kind: 'versions',
      versions: [1, 999],
    });
  });

  it('accepts max 32-bit signed integer (2147483647)', () => {
    expect(parseIfMatch('"2147483647"')).toEqual({
      kind: 'versions',
      versions: [2_147_483_647],
    });
  });

  it('returns malformed for leading zeros ("007")', () => {
    expect(parseIfMatch('"007"')).toEqual({ kind: 'malformed' });
    expect(parseIfMatch('"1", "007"')).toEqual({ kind: 'malformed' });
  });

  it('accepts version 0 ("0")', () => {
    expect(parseIfMatch('"0"')).toEqual({ kind: 'versions', versions: [0] });
  });

  it('returns malformed for integers exceeding 32-bit signed integer max', () => {
    expect(parseIfMatch('"2147483648"')).toEqual({ kind: 'malformed' });
    expect(parseIfMatch('"100000000000000000000"')).toEqual({
      kind: 'malformed',
    });
    expect(parseIfMatch('"1", "2147483648"')).toEqual({ kind: 'malformed' });
  });

  it('returns malformed for non-string values', () => {
    expect(parseIfMatch(null)).toEqual({ kind: 'malformed' });
    expect(parseIfMatch(7)).toEqual({ kind: 'malformed' });
    expect(parseIfMatch(true)).toEqual({ kind: 'malformed' });
    expect(parseIfMatch({})).toEqual({ kind: 'malformed' });
    expect(parseIfMatch(['"1"', 7])).toEqual({ kind: 'malformed' });
    expect(parseIfMatch(['"1"', null])).toEqual({ kind: 'malformed' });
  });

  it('returns malformed for empty list or blank string', () => {
    expect(parseIfMatch('')).toEqual({ kind: 'malformed' });
    expect(parseIfMatch('   ')).toEqual({ kind: 'malformed' });
    expect(parseIfMatch([])).toEqual({ kind: 'malformed' });
    expect(parseIfMatch(['   '])).toEqual({ kind: 'malformed' });
  });

  it('returns malformed for list with empty element', () => {
    expect(parseIfMatch('"1",')).toEqual({ kind: 'malformed' });
    expect(parseIfMatch(',"1"')).toEqual({ kind: 'malformed' });
    expect(parseIfMatch('"1", , "2"')).toEqual({ kind: 'malformed' });
    expect(parseIfMatch(',')).toEqual({ kind: 'malformed' });
  });

  it('returns malformed for list with any malformed element', () => {
    expect(parseIfMatch('"1", "invalid"')).toEqual({ kind: 'malformed' });
    expect(parseIfMatch('"1", 2')).toEqual({ kind: 'malformed' });
    expect(parseIfMatch('"1", *')).toEqual({ kind: 'malformed' });
    expect(parseIfMatch('*, "1"')).toEqual({ kind: 'malformed' });
  });

  it('returns malformed when quotes are missing (unquoted 7)', () => {
    expect(parseIfMatch('7')).toEqual({ kind: 'malformed' });
  });

  it('returns malformed for weak entity tags (W/"7")', () => {
    expect(parseIfMatch('W/"7"')).toEqual({ kind: 'malformed' });
    expect(parseIfMatch('"1", W/"7"')).toEqual({ kind: 'malformed' });
  });
});
