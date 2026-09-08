import { describe, expect, it } from 'vitest';
import { CredentialCrypto } from '../../src/platform/credential-crypto.js';

const valid = Buffer.alloc(32, 9).toString('base64');
describe('CredentialCrypto', () => {
  it.each([
    undefined,
    '',
    'short',
    Buffer.alloc(31, 1).toString('base64'),
    'not-base64-%%%',
  ])('rejects invalid boot key %s', (key) => {
    expect(() => new CredentialCrypto(key)).toThrow();
  });
  it('authenticates random-IV encryption without exposing plaintext', () => {
    const crypto = new CredentialCrypto(valid);
    const secret = '秘密'.repeat(1000);
    const first = crypto.encrypt(secret);
    const second = crypto.encrypt(secret);
    expect(first).not.toBe(second);
    expect(crypto.decrypt(first)).toBe(secret);
    const [iv, tag, ciphertext] = first.split('.');
    const flip = (value: string): string => {
      const bytes = Buffer.from(value, 'base64');
      bytes[0] ^= 1;
      return bytes.toString('base64');
    };
    expect(() => crypto.decrypt(`${flip(iv)}.${tag}.${ciphertext}`)).toThrow();
    expect(() => crypto.decrypt(`${iv}.${flip(tag)}.${ciphertext}`)).toThrow();
    expect(() => crypto.decrypt(`${iv}.${tag}.${flip(ciphertext)}`)).toThrow();
    expect(() =>
      new CredentialCrypto(Buffer.alloc(32, 8).toString('base64')).decrypt(
        first,
      ),
    ).toThrow();
  });
});
