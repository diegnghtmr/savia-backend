import { describe, expect, it, vi } from 'vitest';
import { PostgresCliDeviceAdapter } from '../../src/cli-device/postgres-cli-device.adapter.js';

describe('PostgresCliDeviceAdapter', () => {
  it('uses the database limiter function and never stores the clear device code', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ allowed: true }] });
    const adapter = new PostgresCliDeviceAdapter();
    await expect(
      adapter.consumeRateLimit(
        { query } as never,
        'cli',
        '127.0.0.1',
        new Date(0),
      ),
    ).resolves.toBe(true);
    await adapter.create({ query } as never, {
      deviceCodeHash: 'hash',
      userCode: 'ABCD2345',
      clientId: 'cli',
      scopes: [],
      expiresAt: new Date(1000),
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('consume_cli_device_rate_limit'),
      expect.anything(),
    );
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('device_code_hash'),
      ['hash', 'ABCD2345', 'cli', [], new Date(1000)],
    );
  });
});
