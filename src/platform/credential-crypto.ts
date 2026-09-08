import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class CredentialCrypto {
  private readonly key: Buffer;

  public constructor(encodedKey: string | undefined) {
    if (!encodedKey?.trim())
      throw new Error('SAVIA_CREDENTIAL_KEY must be configured.');
    let decoded: Buffer;
    try {
      decoded = Buffer.from(encodedKey, 'base64');
    } catch {
      throw new Error('SAVIA_CREDENTIAL_KEY must be base64 encoded.');
    }
    if (decoded.length !== 32 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey))
      throw new Error(
        'SAVIA_CREDENTIAL_KEY must be a base64-encoded 32-byte key.',
      );
    this.key = decoded;
  }

  public encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, {
      authTagLength: 16,
    });
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), ciphertext]
      .map((part) => part.toString('base64'))
      .join('.');
  }

  public decrypt(payload: string): string {
    try {
      const parts = payload.split('.');
      if (parts.length !== 3 || parts.some((part) => part.length === 0))
        throw new Error('malformed');
      const [ivText, tagText, ciphertextText] = parts;
      const iv = decodeCanonicalBase64(ivText);
      const tag = decodeCanonicalBase64(tagText);
      const ciphertext = decodeCanonicalBase64(ciphertextText);
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0)
        throw new Error('malformed');
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv, {
        authTagLength: 16,
      });
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      throw new Error('Credential ciphertext authentication failed.', {
        cause: error,
      });
    }
  }
}

function decodeCanonicalBase64(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error('malformed');
  return decoded;
}
