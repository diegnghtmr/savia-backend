import type { BootstrapCommand } from './bootstrap-command.js';
import type { BootstrapAggregate } from './bootstrap.port.js';
import type { BootstrapEvidence } from './bootstrap-classification.js';
import type { TransactionClient } from './pg-transaction.js';

export class PostgresBootstrapAdapter {
  // Scope the evidence to the subject's personal onboarding aggregate. Row level
  // security already restricts visibility to this subject, but it deliberately
  // also exposes every workspace the subject merely belongs to; counting those
  // as onboarding evidence would classify a legitimate replay as an unrepairable
  // incomplete aggregate as soon as shared workspaces exist. Explicit predicates
  // additionally keep scoping from resting on policy definitions alone.
  //
  // Memberships exclude only workspaces that are demonstrably non-personal, so a
  // legitimate shared membership never inflates the count while a dangling or
  // mislinked membership stays visible and is still reported as an incomplete
  // aggregate rather than being silently treated as a fresh onboarding.
  public async read(
    client: TransactionClient,
    subject: string,
  ): Promise<BootstrapEvidence> {
    const result = await client.query<BootstrapEvidenceRow>(
      `select
      coalesce((select jsonb_agg(to_jsonb(p)) from (select id::text, email,
        display_name as "displayName", locale, country_code as "countryCode",
        timezone, date_format as "dateFormat", week_starts_on as "weekStartsOn",
        number_format as "numberFormat", default_currency as "defaultCurrency",
        privacy_mode_enabled as "privacyModeEnabled" from public.profiles
        where id = $1) p), '[]') profiles,
      coalesce((select jsonb_agg(to_jsonb(w)) from (select id::text, name, kind,
        base_currency as "baseCurrency", personal_owner_profile_id::text as "personalOwnerProfileId"
        from public.workspaces
        where kind = 'personal' and personal_owner_profile_id = $1) w), '[]') workspaces,
      coalesce((select jsonb_agg(to_jsonb(m)) from (select workspace_id::text as "workspaceId",
        profile_id::text as "profileId", role, status from public.workspace_memberships
        where profile_id = $1 and workspace_id not in (select id from public.workspaces
          where kind <> 'personal')) m), '[]') memberships`,
      [subject],
    );
    const evidence = result.rows[0];
    if (!evidence) throw new Error('Bootstrap evidence query returned no row.');
    return evidence;
  }

  public async create(
    client: TransactionClient,
    command: BootstrapCommand,
  ): Promise<BootstrapAggregate> {
    const profile = await client.query<IdRow>(
      `insert into public.profiles
      (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on,
       number_format, default_currency, privacy_mode_enabled)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id::text`,
      [
        command.subject,
        command.email,
        command.displayName,
        command.locale,
        command.countryCode,
        command.timezone,
        command.dateFormat,
        command.weekStartsOn,
        command.numberFormat,
        command.defaultCurrency,
        command.privacyModeEnabled,
      ],
    );
    const profileId = profile.rows[0]?.id;
    if (!profileId)
      throw new Error('Bootstrap profile insert returned no identifier.');
    const workspace = await client.query<IdRow>(
      `insert into public.workspaces
      (name, kind, base_currency, personal_owner_profile_id)
      values ($1, 'personal', $2, $3) returning id::text`,
      [command.workspaceName, command.baseCurrency, command.subject],
    );
    const workspaceId = workspace.rows[0]?.id;
    if (!workspaceId)
      throw new Error('Bootstrap workspace insert returned no identifier.');
    await client.query(
      `insert into public.workspace_memberships
      (workspace_id, profile_id, role, status) values ($1, $2, 'owner', 'active')`,
      [workspaceId, command.subject],
    );
    return { profileId, workspaceId };
  }
}

interface BootstrapEvidenceRow
  extends BootstrapEvidence,
    Record<string, unknown> {}
interface IdRow extends Record<string, unknown> {
  readonly id: string;
}
