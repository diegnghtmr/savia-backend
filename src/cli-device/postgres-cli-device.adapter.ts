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
  public async consumeApprovalRateLimit(
    client: TransactionClient,
    now: Date,
  ): Promise<boolean> {
    const result = await client.query<{ allowed: boolean }>(
      'select public.consume_cli_device_approval_rate_limit($1) as allowed',
      [now],
    );
    return result.rows[0]?.allowed ?? false;
  }
  public async approve(
    client: TransactionClient,
    userCode: string,
  ): Promise<boolean> {
    const result = await client.query<{ approved: boolean }>(
      'select public.approve_cli_device_authorization($1) as approved',
      [userCode],
    );
    return result.rows[0]?.approved ?? false;
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
  public async redeem(
    client: TransactionClient,
    deviceCodeHash: string,
    clientId: string,
    now: Date,
  ) {
    const result = await client.query<{
      subject_id: string;
      scopes: string[];
      expires_at: Date;
    }>(
      `select subject_id, scopes, expires_at
       from public.redeem_cli_device_authorization($1, $2, $3)`,
      [deviceCodeHash, clientId, now],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : {
          subjectId: row.subject_id,
          scopes: row.scopes,
          expiresAt: row.expires_at,
        };
  }
  public async createToken(
    client: TransactionClient,
    record: {
      readonly tokenHash: string;
      readonly subjectId: string;
      readonly scopes: readonly string[];
      readonly expiresAt: Date;
      readonly deviceCodeHash: string;
    },
  ): Promise<void> {
    await client.query(
      `select public.insert_cli_device_token($1, $2, $3, $4, $5)`,
      [
        record.tokenHash,
        record.subjectId,
        record.deviceCodeHash,
        record.scopes,
        record.expiresAt,
      ],
    );
  }
  public async verifyToken(client: TransactionClient, tokenHash: string) {
    const result = await client.query<{ subject_id: string }>(
      'select subject_id from public.verify_cli_device_token($1)',
      [tokenHash],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : { subjectId: row.subject_id };
  }
}
