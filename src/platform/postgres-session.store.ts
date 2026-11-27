import { Injectable } from '@nestjs/common';
import type { Cursor } from './cursor.js';
import { PgTransaction } from './pg-transaction.js';

export class SessionStatusUnavailableError extends Error {
  public constructor() {
    super('Session status could not be verified.');
  }
}

interface SessionRow extends Record<string, unknown> {
  readonly id: string;
  readonly createdAt: Date;
  readonly lastActiveAt: Date;
  readonly userAgent: string | null;
  readonly cursorAt: string;
}

@Injectable()
export class PostgresSessionStore {
  public constructor(private readonly transaction: PgTransaction) {}

  public async isActive(subject: string, sessionId: string): Promise<boolean> {
    try {
      return await this.transaction.runRead(subject, async (client) => {
        const result = await client.query<{ active: boolean }>(
          'select public.savia_session_is_active($1::uuid) as active',
          [sessionId],
        );
        return result.rows[0]?.active === true;
      });
    } catch {
      throw new SessionStatusUnavailableError();
    }
  }

  public list(
    subject: string,
    sessionId: string,
    cursor: Cursor | undefined,
    limit: number,
  ): Promise<SessionRow[]> {
    return this.transaction.runRead(subject, async (client) => {
      const result = await client.query<SessionRow>(
        `select id::text, created_at as "createdAt", last_active_at as "lastActiveAt", user_agent as "userAgent",
                to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
           from public.savia_list_sessions($1::uuid, $2::timestamptz, $3::uuid, $4::integer)
          order by created_at, id`,
        [sessionId, cursor?.createdAt ?? null, cursor?.id ?? null, limit],
      );
      return result.rows;
    });
  }

  public revokeOthers(subject: string, sessionId: string): Promise<boolean> {
    return this.transaction.run(subject, async (client) => {
      const result = await client.query<{ active: boolean }>(
        'select public.savia_revoke_other_sessions($1::uuid) as active',
        [sessionId],
      );
      return result.rows[0]?.active === true;
    });
  }
}
