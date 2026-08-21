import type { TransactionClient } from './pg-transaction.js';
import type { UserProfile } from './profile.port.js';

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
}

interface UserProfileRow extends UserProfile, Record<string, unknown> {}
