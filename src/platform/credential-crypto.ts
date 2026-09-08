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
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
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
      const [ivText, tagText, ciphertextText] = payload.split('.');
      if (!ivText || !tagText || !ciphertextText) throw new Error('malformed');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(ivText, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tagText, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextText, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      throw new Error('Credential ciphertext authentication failed.', {
        cause: error,
      });
    }
  }
}
