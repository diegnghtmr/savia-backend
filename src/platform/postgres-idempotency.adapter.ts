import type { TransactionClient } from './pg-transaction.js';
import type {
  IdempotencyRecord,
  IdempotencyStore,
} from './idempotency.port.js';

export class PostgresIdempotencyAdapter implements IdempotencyStore {
  public async read(
    client: TransactionClient,
    subject: string,
    route: string,
    idempotencyKey: string,
    workspaceId: string | null = null,
  ): Promise<IdempotencyRecord | undefined> {
    const result = await client.query<IdempotencyRow>(
      `select request_fingerprint as "requestFingerprint",
       response_status     as "responseStatus",
       response_etag       as "responseEtag",
       response_body       as "responseBody"
  from public.command_idempotency_records
 where subject_id = $1 and route = $2 and idempotency_key = $3
   and workspace_id is not distinct from $4::uuid
   and created_at > now() - interval '24 hours'`,
      [subject, route, idempotencyKey, workspaceId ?? null],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      requestFingerprint: row.requestFingerprint,
      responseStatus: row.responseStatus,
      responseEtag: row.responseEtag,
      responseBody: row.responseBody,
    };
  }

  public async write(
    client: TransactionClient,
    subject: string,
    route: string,
    idempotencyKey: string,
    fingerprint: string,
    status: number,
    etag: string | null,
    body: unknown,
    workspaceId: string | null = null,
  ): Promise<boolean> {
    const result = await client.query<{ id: string }>(
      `insert into public.command_idempotency_records
       (subject_id, route, idempotency_key, workspace_id, request_fingerprint,
        response_status, response_etag, response_body)
values ($1, $2, $3, $4::uuid, $5, $6, $7, $8::jsonb)
on conflict (subject_id, route, idempotency_key, workspace_id) do update
   set request_fingerprint = excluded.request_fingerprint,
       response_status     = excluded.response_status,
       response_etag       = excluded.response_etag,
       response_body       = excluded.response_body,
       created_at          = now()
 where public.command_idempotency_records.created_at <= now() - interval '24 hours'
returning id`,
      [
        subject,
        route,
        idempotencyKey,
        workspaceId ?? null,
        fingerprint,
        status,
        etag,
        body === undefined || body === null ? null : JSON.stringify(body),
      ],
    );

    // A zero-row returning from the write means a LIVE record won the race.
    // Treat it as "re-read and replay", NEVER as success.
    return result.rows.length > 0;
  }
}

interface IdempotencyRow extends Record<string, unknown> {
  readonly requestFingerprint: string;
  readonly responseStatus: number;
  readonly responseEtag: string | null;
  readonly responseBody: unknown;
}
