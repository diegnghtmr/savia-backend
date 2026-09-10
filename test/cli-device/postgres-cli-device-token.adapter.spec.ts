import { describe, expect, it, vi } from 'vitest';
import { PostgresCliDeviceAdapter } from '../../src/cli-device/postgres-cli-device.adapter.js';

describe('PostgresCliDeviceAdapter token capability', () => {
  it('hash lookup adapter maps only the database subject result', async () => {
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [{ subject_id: 'subject' }] });
    const result = await new PostgresCliDeviceAdapter().verifyToken(
      { query } as never,
      'hash',
    );
    expect(result).toEqual({ subjectId: 'subject' });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('verify_cli_device_token'),
      ['hash'],
    );
  });
  it('redeem adapter returns no row as an invalid authorization', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const result = await new PostgresCliDeviceAdapter().redeem(
      { query } as never,
      'hash',
      'client',
      new Date(0),
    );
    expect(result).toBeUndefined();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('redeem_cli_device_authorization'),
      ['hash', 'client', new Date(0)],
    );
  });
});
