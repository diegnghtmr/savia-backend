import { Injectable } from '@nestjs/common';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import {
  PgTransaction,
  type TransactionClient,
} from '../platform/pg-transaction.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import {
  DASHBOARD_CARD_IDS,
  type DashboardPreferencesCommand,
} from './dashboard-preferences-command.js';

const ROUTE = 'PUT /v1/me/dashboard-preferences';
interface Preferences
  extends DashboardPreferencesCommand,
    Record<string, unknown> {
  readonly version: number;
}
const columns =
  'cards, period, presentation_currency as "presentationCurrency", version';

type Outcome =
  | { readonly kind: 'ok'; readonly etag: string; readonly body: unknown }
  | { readonly kind: 'forbidden' | 'stale' | 'conflict' };
class ReplayConflict extends Error {}

function result(body: Preferences): Outcome {
  return { kind: 'ok', etag: `"${body.version}"`, body };
}

async function workspaceCurrency(
  client: TransactionClient,
  workspaceId: string,
): Promise<string | undefined> {
  const { rows } = await client.query<{ currency: string }>(
    'select base_currency as currency from public.workspaces where id = $1::uuid',
    [workspaceId],
  );
  return rows[0]?.currency;
}

async function readPreferences(
  client: TransactionClient,
  subject: string,
  workspaceId: string,
): Promise<Preferences | undefined> {
  const { rows } = await client.query<Preferences>(
    `select ${columns} from public.dashboard_preferences where profile_id = $1::uuid and workspace_id = $2::uuid`,
    [subject, workspaceId],
  );
  return rows[0];
}

@Injectable()
export class DashboardPreferencesService {
  public constructor(
    private readonly transaction: PgTransaction,
    private readonly idempotency: PostgresIdempotencyAdapter,
  ) {}

  public get(subject: string, workspaceId: string): Promise<Outcome> {
    return this.transaction.runRead(subject, async (client) => {
      const currency = await workspaceCurrency(client, workspaceId);
      if (!currency) return { kind: 'forbidden' };
      return result(
        (await readPreferences(client, subject, workspaceId)) ?? {
          cards: DASHBOARD_CARD_IDS.map((id) => ({ id, visible: true })),
          period: { preset: 'this_month' },
          presentationCurrency: currency,
          version: 1,
        },
      );
    });
  }

  public async put(
    subject: string,
    workspaceId: string,
    command: DashboardPreferencesCommand,
    match: number,
    key: string,
  ): Promise<Outcome> {
    const fingerprint = computeRequestFingerprint({
      ...command,
      ifMatch: match,
    });
    try {
      return await this.transaction.run(
        subject,
        async (client): Promise<Outcome> => {
          if (!(await workspaceCurrency(client, workspaceId)))
            return { kind: 'forbidden' };
          const existing = await this.idempotency.read(
            client,
            subject,
            ROUTE,
            key,
            workspaceId,
          );
          if (existing)
            return existing.requestFingerprint === fingerprint &&
              existing.responseEtag !== null
              ? {
                  kind: 'ok',
                  etag: existing.responseEtag,
                  body: existing.responseBody,
                }
              : { kind: 'conflict' };
          const before = await readPreferences(client, subject, workspaceId);
          if ((before?.version ?? 1) !== match) return { kind: 'stale' };
          // PgTransaction serializes writes by subject. RLS enforces ownership
          // and active membership again at the write boundary.
          const { rows } = await client.query<Preferences>(
            `insert into public.dashboard_preferences(profile_id, workspace_id, cards, period, presentation_currency, version)
           values ($1::uuid, $2::uuid, $3::jsonb, $4::jsonb, $5, 2)
           on conflict (profile_id, workspace_id) do update set
             cards = excluded.cards, period = excluded.period, presentation_currency = excluded.presentation_currency,
             version = dashboard_preferences.version + 1
           where dashboard_preferences.version = $6
           returning ${columns}`,
            [
              subject,
              workspaceId,
              JSON.stringify(command.cards),
              JSON.stringify(command.period),
              command.presentationCurrency,
              match,
            ],
          );
          const body = rows[0];
          if (!body) return { kind: 'stale' };
          const etag = `"${body.version}"`;
          if (
            !(await this.idempotency.write(
              client,
              subject,
              ROUTE,
              key,
              fingerprint,
              200,
              etag,
              body,
              workspaceId,
            ))
          )
            throw new ReplayConflict();
          return { kind: 'ok', body, etag };
        },
      );
    } catch (error) {
      if (error instanceof ReplayConflict) return { kind: 'conflict' };
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '42501'
      )
        return { kind: 'forbidden' };
      throw error;
    }
  }
}
