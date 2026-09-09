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
  public error: Error | null = null;
  public record: Record<string, unknown> | undefined;
  public async consumeRateLimit(): Promise<boolean> {
    return this.allowed;
  }
  public async create(
    _client: TransactionClient,
    record: Record<string, unknown>,
  ): Promise<void> {
    if (this.error) throw this.error;
    this.record = record;
  }
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
    expect(store.record?.deviceCodeHash as string).not.toBe(
      response.deviceCode,
    );
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
    store.error = new Error('storage failure');
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
});
