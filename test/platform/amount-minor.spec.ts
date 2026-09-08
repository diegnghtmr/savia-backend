import { describe, expect, it } from 'vitest';
import { negateAmountMinor } from '../../src/platform/amount-minor.js';

describe('negateAmountMinor', () => {
  it.each([
    ['10000', '-10000'],
    ['9007199254740993', '-9007199254740993'],
    ['-10000', '10000'],
    ['-9007199254740993', '9007199254740993'],
    ['0', '0'],
    ['-0', '0'],
    ['-9223372036854775807', '9223372036854775807'],
  ])('negates %s as %s', (input, expected) => {
    expect(negateAmountMinor(input)).toBe(expected);
  });

  it('refuses int8-min because the counter-leg would overflow', () => {
    expect(() => negateAmountMinor('-9223372036854775808')).toThrow(RangeError);
  });
});
