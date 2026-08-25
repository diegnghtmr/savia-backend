import type { TransactionClient } from '../platform/pg-transaction.js';
import type { ProfileUpdateCommand } from './profile-update-command.js';
import type { UserProfile } from './profile.port.js';

export interface UserProfileWithVersion extends UserProfile {
  readonly version: number;
}

export class PostgresProfileAdapter {
  public async read(
    client: TransactionClient,
    subject: string,
  ): Promise<UserProfile | undefined> {
    const result = await client.query<UserProfileRow>(
      'select id::text, email, display_name as "displayName", locale, timezone, default_currency as "defaultCurrency", privacy_mode_enabled as "privacyModeEnabled" from public.profiles where id = $1',
      [subject],
    );
    return result.rows[0];
  }

  public async update(
    client: TransactionClient,
    subject: string,
    command: ProfileUpdateCommand,
    expectedVersion?: number | readonly number[],
  ): Promise<UserProfileWithVersion | undefined> {
    const versions =
      typeof expectedVersion === 'number'
        ? [expectedVersion]
        : (expectedVersion ?? null);
    const values = [
      subject,
      command.displayName ?? null,
      command.locale ?? null,
      command.timezone ?? null,
      command.defaultCurrency ?? null,
      command.privacyModeEnabled ?? null,
      versions,
    ];
    const result = await client.query<UserProfileWithVersionRow>(
      `update public.profiles
   set display_name         = coalesce($2, display_name),
       locale               = coalesce($3, locale),
       timezone             = coalesce($4, timezone),
       default_currency     = coalesce($5, default_currency),
       privacy_mode_enabled = coalesce($6::boolean, privacy_mode_enabled),
       version              = version + 1
 where id = $1
   and ($7::integer[] is null or version = any($7::integer[]))
returning id::text, email, display_name as "displayName", locale, timezone,
          default_currency as "defaultCurrency",
          privacy_mode_enabled as "privacyModeEnabled", version`,
      values,
    );
    return result.rows[0];
  }

  public async readVersion(
    client: TransactionClient,
    subject: string,
  ): Promise<number | undefined> {
    const result = await client.query<VersionRow>(
      'select version from public.profiles where id = $1',
      [subject],
    );
    return result.rows[0]?.version;
  }
}

interface UserProfileRow extends UserProfile, Record<string, unknown> {}
interface UserProfileWithVersionRow
  extends UserProfileWithVersion,
    Record<string, unknown> {}
interface VersionRow extends Record<string, unknown> {
  readonly version: number;
}
