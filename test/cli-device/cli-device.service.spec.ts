import { describe, expect, it } from 'vitest';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import { CliDeviceService } from '../../src/cli-device/cli-device.service.js';
import { CliDeviceConfig } from '../../src/cli-device/cli-device.config.js';
import type {
  CliDeviceStore,
  CliDeviceTransaction,
} from '../../src/cli-device/cli-device.port.js';

class Tx implements CliDeviceTransaction {
  public returned = 0;
  public thrown = 0;
  public async run<T>(
    _subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.runAnonymous(callback);
  }
  public async runAnonymous<T>(
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await callback({
        query: async () => ({ rows: [] }),
      } as unknown as TransactionClient);
      this.returned++;
      return result;
    } catch (error) {
      this.thrown++;
      throw error;
    }
  }
}
class Store implements CliDeviceStore {
  public allowed = true;
  public errors: Error[] = [];
  public record: Record<string, unknown> | undefined;
  public createCalls = 0;
  public rateLimitCalls = 0;
  public redemption:
    | { subjectId: string; scopes: readonly string[]; expiresAt: Date }
    | undefined;
  public tokenRecord: Record<string, unknown> | undefined;
  public approval = true;
  public approvalRateLimit = true;
  public async redeem(): Promise<typeof this.redemption> {
    return this.redemption;
  }
  public async createToken(
    _client: TransactionClient,
    record: Record<string, unknown>,
  ): Promise<void> {
    this.tokenRecord = record;
  }
  public async verifyToken(): Promise<undefined> {
    return undefined;
  }
  public async consumeApprovalRateLimit(): Promise<boolean> {
    return this.approvalRateLimit;
  }
  public async approve(): Promise<boolean> {
    return this.approval;
  }
  public async consumeRateLimit(): Promise<boolean> {
    this.rateLimitCalls++;
    return this.allowed;
  }
  public async create(
    _client: TransactionClient,
    record: Record<string, unknown>,
  ): Promise<void> {
    this.createCalls++;
    const error = this.errors.shift();
    if (error) throw error;
    this.record = record;
  }
}

function postgresUniqueViolation(constraint: string): Error {
  return Object.assign(new Error('duplicate key'), {
    code: '23505',
    constraint,
  });
}

describe('CliDeviceService', () => {
  it('creates a high entropy secret, hashed persistence record, and configured response', async () => {
    const tx = new Tx();
    const store = new Store();
    const service = new CliDeviceService(
      tx,
      store,
      CliDeviceConfig.fromEnvironment({
        CLI_DEVICE_VERIFICATION_URI: 'https://app.test/device',
      }),
      () => new Date('2026-01-01T00:00:00Z'),
    );
    const response = await service.authorize(
      { clientId: 'cli', scopes: [] },
      '127.0.0.1',
    );
    if ('kind' in response) throw new Error('unexpected rate limit');
    expect(response).toMatchObject({
      verificationUri: 'https://app.test/device',
      expiresIn: 600,
      interval: 5,
    });
    expect(response).toHaveProperty('deviceCode');
    expect(store.record?.deviceCodeHash !== response.deviceCode).toBe(true);
    expect((store.record?.expiresAt as Date).toISOString()).toBe(
      '2026-01-01T00:10:00.000Z',
    );
    expect(tx.returned).toBe(1);
  });
  it('returns rate limited without creating a credential and commits the outcome', async () => {
    const tx = new Tx();
    const store = new Store();
    store.allowed = false;
    const service = new CliDeviceService(
      tx,
      store,
      CliDeviceConfig.fromEnvironment({
        CLI_DEVICE_VERIFICATION_URI: 'https://app.test/device',
      }),
    );
    await expect(
      service.authorize({ clientId: 'cli', scopes: [] }, '127.0.0.1'),
    ).resolves.toMatchObject({ kind: 'rate_limited' });
    expect(store.record).toBeUndefined();
    expect(tx.returned).toBe(1);
    expect(tx.thrown).toBe(0);
  });
  it('throws storage failures so the real transaction rolls back', async () => {
    const tx = new Tx();
    const store = new Store();
    store.errors = [new Error('storage failure')];
    const service = new CliDeviceService(
      tx,
      store,
      CliDeviceConfig.fromEnvironment({
        CLI_DEVICE_VERIFICATION_URI: 'https://app.test/device',
      }),
    );
    await expect(
      service.authorize({ clientId: 'cli', scopes: [] }, '127.0.0.1'),
    ).rejects.toThrow('storage failure');
    expect(tx.thrown).toBe(1);
    expect(tx.returned).toBe(0);
  });
  it('retries a user-code collision inside one charged transaction', async () => {
    const tx = new Tx();
    const store = new Store();
    store.errors = [
      postgresUniqueViolation('cli_device_authorizations_user_code_key'),
    ];
    const generatedCodes = ['ABCDEFGH', 'JKLMNPQR'];
    const service = new CliDeviceService(
      tx,
      store,
      CliDeviceConfig.fromEnvironment({
        CLI_DEVICE_VERIFICATION_URI: 'https://app.test/device',
      }),
      () => new Date('2026-01-01T00:00:00Z'),
      () => generatedCodes.shift() ?? 'STUVWXYZ',
    );

    const response = await service.authorize(
      { clientId: 'cli', scopes: [] },
      '127.0.0.1',
    );

    expect('kind' in response).toBe(false);
    expect(store.createCalls).toBe(2);
    expect(store.rateLimitCalls).toBe(1);
    expect(store.record).toBeDefined();
    expect(tx.returned).toBe(1);
  });
  it('does not retry a unique violation from another constraint', async () => {
    const tx = new Tx();
    const store = new Store();
    store.errors = [postgresUniqueViolation('other_unique_constraint')];
    const service = new CliDeviceService(
      tx,
      store,
      CliDeviceConfig.fromEnvironment({
        CLI_DEVICE_VERIFICATION_URI: 'https://app.test/device',
      }),
    );

    await expect(
      service.authorize({ clientId: 'cli', scopes: [] }, '127.0.0.1'),
    ).rejects.toThrow('duplicate key');
    expect(store.createCalls).toBe(1);
    expect(store.rateLimitCalls).toBe(1);
    expect(tx.thrown).toBe(1);
  });
  it('returns one opaque token for an approved authorization', async () => {
    const tx = new Tx();
    const store = new Store();
    store.redemption = {
      subjectId: 'subject',
      scopes: ['transactions:read'],
      expiresAt: new Date('2026-01-01T00:10:00Z'),
    };
    const service = new CliDeviceService(
      tx,
      store,
      CliDeviceConfig.fromEnvironment({
        CLI_DEVICE_VERIFICATION_URI: 'https://app.test/device',
      }),
      () => new Date('2026-01-01T00:00:00Z'),
    );
    const result = await service.poll(
      { clientId: 'cli', deviceCode: 'device-secret' },
      '127.0.0.1',
    );
    if ('kind' in result) throw new Error('unexpected poll outcome');
    expect(result).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 2592000,
      scope: 'transactions:read',
    });
    expect(result.accessToken.startsWith('svt_')).toBe(true);
    expect(store.tokenRecord?.tokenHash).not.toBe(result.accessToken);
    expect(tx.returned).toBe(1);
  });
  it('returns indistinguishable invalid authorization outcomes', async () => {
    const tx = new Tx();
    const store = new Store();
    const service = new CliDeviceService(
      tx,
      store,
      CliDeviceConfig.fromEnvironment({
        CLI_DEVICE_VERIFICATION_URI: 'https://app.test/device',
      }),
    );
    await expect(
      service.poll({ clientId: 'cli', deviceCode: 'unknown' }, '127.0.0.1'),
    ).resolves.toEqual({ kind: 'invalid' });
    expect(tx.returned).toBe(1);
    expect(tx.thrown).toBe(0);
  });
  it('returns a committed invalid approval so the rate-limit charge persists', async () => {
    const tx = new Tx();
    const store = new Store();
    store.approval = false;
    const service = new CliDeviceService(
      tx,
      store,
      CliDeviceConfig.fromEnvironment({
        CLI_DEVICE_VERIFICATION_URI: 'https://app.test/device',
      }),
    );
    await expect(
      service.approve('00000000-0000-0000-0000-000000000001', {
        userCode: 'ABCD2345',
      }),
    ).resolves.toEqual({ kind: 'invalid' });
    expect(tx.returned).toBe(1);
    expect(tx.thrown).toBe(0);
  });
  it('issues tokens for exactly 30 days from issuance, not device-code expiry', async () => {
    const tx = new Tx();
    const store = new Store();
    store.redemption = {
      subjectId: 'subject',
      scopes: [],
      expiresAt: new Date('2026-01-01T00:10:00Z'),
    };
    const service = new CliDeviceService(
      tx,
      store,
      CliDeviceConfig.fromEnvironment({
        CLI_DEVICE_VERIFICATION_URI: 'https://app.test/device',
      }),
      () => new Date('2026-01-01T00:00:00Z'),
    );
    await service.poll({ clientId: 'cli', deviceCode: 'device-secret' }, 'ip');
    expect(store.tokenRecord?.expiresAt).toEqual(
      new Date('2026-01-31T00:00:00Z'),
    );
  });
});
