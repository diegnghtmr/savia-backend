import { createHash, randomBytes } from 'node:crypto';
import type { CliDeviceConfig } from './cli-device.config.js';
import type {
  CliDeviceAuthorization,
  CliDeviceAuthorizationCommand,
  CliDevicePort,
  CliDeviceStore,
  CliDeviceTransaction,
} from './cli-device.port.js';

const EXPIRES_IN = 600;
const INTERVAL = 5;
const USER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const USER_CODE_LENGTH = 8;

export class CliDeviceService implements CliDevicePort {
  public constructor(
    private readonly tx: CliDeviceTransaction,
    private readonly store: CliDeviceStore,
    private readonly config: CliDeviceConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  public async authorize(
    command: CliDeviceAuthorizationCommand,
    ip: string,
  ): Promise<
    | CliDeviceAuthorization
    | { readonly kind: 'rate_limited'; readonly retryAfter: number }
  > {
    const now = this.clock();
    return this.tx.runAnonymous(async (client) => {
      if (
        !(await this.store.consumeRateLimit(client, command.clientId, ip, now))
      )
        return {
          kind: 'rate_limited' as const,
          retryAfter: 60 - now.getUTCSeconds(),
        };
      const deviceCode = randomBytes(32).toString('base64url');
      let userCode = '';
      const random = randomBytes(USER_CODE_LENGTH);
      for (const byte of random)
        userCode += USER_ALPHABET[byte % USER_ALPHABET.length];
      await this.store.create(client, {
        deviceCodeHash: createHash('sha256').update(deviceCode).digest('hex'),
        userCode,
        clientId: command.clientId,
        scopes: command.scopes,
        expiresAt: new Date(now.getTime() + EXPIRES_IN * 1000),
      });
      return {
        deviceCode,
        userCode,
        verificationUri: this.config.verificationUri,
        expiresIn: EXPIRES_IN,
        interval: INTERVAL,
      };
    });
  }
}
