// Migration under test: 202609060007_ai_credentials.sql
import { describe, expect, it } from 'vitest';
import { CredentialCrypto } from '../../src/platform/credential-crypto.js';

describe('AI credential crypto and contract seam', () => {
  it('uses authenticated encryption with a fresh IV', () => {
    const crypto = new CredentialCrypto(Buffer.alloc(32, 1).toString('base64'));
    const first = crypto.encrypt('秘密'.repeat(1000));
    const second = crypto.encrypt('秘密'.repeat(1000));
    expect(first).not.toBe(second);
    expect(crypto.decrypt(first)).toBe('秘密'.repeat(1000));
    const flip = (value: string): string => {
      const bytes = Buffer.from(value, 'base64');
      bytes[0] ^= 1;
      return bytes.toString('base64');
    };
    const [iv, tag, ciphertext] = first.split('.');
    for (const tampered of [
      `${iv}.${tag}.${flip(ciphertext)}`,
      `${flip(iv)}.${tag}.${ciphertext}`,
      `${iv}.${flip(tag)}.${ciphertext}`,
    ])
      expect(() => crypto.decrypt(tampered)).toThrow();
    expect(
      () => new CredentialCrypto(Buffer.alloc(31, 1).toString('base64')),
    ).toThrow();
  });
});
