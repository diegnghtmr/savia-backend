import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
  type PushDeviceRequest,
} from './notification-settings.js';

interface PreferencesRow extends Record<string, unknown> {
  in_app_enabled: boolean;
  push_enabled: boolean;
  email_enabled: boolean;
  digest_enabled: boolean;
  quiet_start: string | null;
  quiet_end: string | null;
  zone: string;
  version: number;
}

export class PostgresNotificationSettingsAdapter {
  public async lockPreferences(
    client: TransactionClient,
    subject: string,
  ): Promise<void> {
    // Serialize the first write against the virtual default as well as replays.
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended('notification-preferences:' || $1::uuid::text, 0))",
      [subject],
    );
  }

  public async readPreferences(client: TransactionClient, subject: string) {
    const {
      rows: [row],
    } = await client.query<PreferencesRow>(
      `select f.in_app_enabled, f.push_enabled, f.email_enabled, f.digest_enabled,
              left(f.quiet_start::text, 5) as quiet_start, left(f.quiet_end::text, 5) as quiet_end,
              coalesce(f.quiet_timezone, p.timezone, 'UTC') as zone, f.version
         from public.notification_delivery_preferences f
         left join public.profiles p on p.id = f.subject_id
        where f.subject_id = $1`,
      [subject],
    );
    if (row === undefined)
      return { preferences: DEFAULT_NOTIFICATION_PREFERENCES, version: 0 };
    const preferences: NotificationPreferences = {
      channels: {
        in_app: row.in_app_enabled,
        push: row.push_enabled,
        email: row.email_enabled,
      },
      quietHours:
        row.quiet_start === null || row.quiet_end === null
          ? null
          : {
              start: row.quiet_start,
              end: row.quiet_end,
              timezone: row.zone,
            },
      digestEnabled: row.digest_enabled,
    };
    return { preferences, version: row.version };
  }

  public async isKnownTimezone(
    client: TransactionClient,
    zone: string,
  ): Promise<boolean> {
    const result = await client.query<{ valid: boolean }>(
      `select exists (select 1 from pg_catalog.pg_timezone_names where name = $1) as valid`,
      [zone],
    );
    return result.rows[0].valid;
  }

  public async writePreferences(
    client: TransactionClient,
    subject: string,
    value: NotificationPreferences,
  ): Promise<number> {
    const { channels, quietHours, digestEnabled } = value;
    const result = await client.query<{ version: number }>(
      `insert into public.notification_delivery_preferences
         (subject_id, in_app_enabled, push_enabled, email_enabled, digest_enabled, quiet_start, quiet_end, quiet_timezone)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (subject_id) do update set
         in_app_enabled = excluded.in_app_enabled, push_enabled = excluded.push_enabled,
         email_enabled = excluded.email_enabled, digest_enabled = excluded.digest_enabled,
         quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, quiet_timezone = excluded.quiet_timezone,
         version = notification_delivery_preferences.version + 1
       returning version`,
      [
        subject,
        channels.in_app,
        channels.push,
        channels.email,
        digestEnabled,
        quietHours?.start ?? null,
        quietHours?.end ?? null,
        quietHours?.timezone ?? null,
      ],
    );
    return result.rows[0].version;
  }

  public async registerDevice(
    client: TransactionClient,
    subject: string,
    request: PushDeviceRequest,
  ) {
    const values = [
      subject,
      request.expoPushToken,
      request.platform,
      request.appVersion,
    ];
    // The unique index arbitrates across subjects; a conflict cannot reveal any
    // owner or registration details. The update is scoped by both owner and RLS.
    const inserted = await client.query<{ id: string }>(
      `insert into public.push_devices (subject_id, expo_token, platform, app_version)
       values ($1, $2, $3, $4) on conflict (expo_token) do nothing returning id`,
      values,
    );
    if (inserted.rows[0])
      return { deviceId: inserted.rows[0].id, created: true };
    const updated = await client.query<{ id: string }>(
      `update public.push_devices set platform = $3, app_version = $4,
         active = true, registration_version = gen_random_uuid()
       where subject_id = $1 and expo_token = $2 returning id`,
      values,
    );
    if (updated.rows[0])
      return { deviceId: updated.rows[0].id, created: false };
    return undefined;
  }

  public async removeDevice(
    client: TransactionClient,
    subject: string,
    id: string,
  ): Promise<boolean> {
    const result = await client.query(
      'delete from public.push_devices where subject_id = $1 and id = $2',
      [subject, id],
    );
    return result.rowCount === 1;
  }
}
