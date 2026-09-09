import type { TransactionClient } from '../platform/pg-transaction.js';
import type { CliDeviceStore } from './cli-device.port.js';

export class PostgresCliDeviceAdapter implements CliDeviceStore {
  public async consumeRateLimit(
    client: TransactionClient,
    clientId: string,
    ip: string,
    now: Date,
  ): Promise<boolean> {
    const result = await client.query<{ allowed: boolean }>(
      'select public.consume_cli_device_rate_limit($1, $2::inet, $3) as allowed',
      [clientId, ip, now],
    );
    return result.rows[0]?.allowed ?? false;
  }
  public async create(
    client: TransactionClient,
    record: {
      readonly deviceCodeHash: string;
      readonly userCode: string;
      readonly clientId: string;
      readonly scopes: readonly string[];
      readonly expiresAt: Date;
    },
  ): Promise<void> {
    await client.query(
      'insert into public.cli_device_authorizations (device_code_hash, user_code, client_id, scopes, expires_at) values ($1, $2, $3, $4, $5)',
      [
        record.deviceCodeHash,
        record.userCode,
        record.clientId,
        record.scopes,
        record.expiresAt,
      ],
    );
  }
}
