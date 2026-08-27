import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCOUNT_UPDATE_OUTCOMES,
  type UpdateAccountCommand,
} from '../../src/accounts/accounts.port.js';
import { AccountsService } from '../../src/accounts/accounts.service.js';
import { PostgresAccountsAdapter } from '../../src/accounts/postgres-accounts.adapter.js';
import { PostgresIdempotencyAdapter } from '../../src/platform/postgres-idempotency.adapter.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const id = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('AccountsService updateAccount database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: AccountsService;

  const subjectOwner = subject(701);
  const subjectAdmin = subject(702);
  const subjectEditor = subject(703);
  const subjectViewer = subject(704);
  const subjectNonMember = subject(705);
  const subjectWorkspace2Owner = subject(706);

  const workspace1Id = id(751);
  const workspace2Id = id(752);
  const absentWorkspaceId = id(799);

  const accountOwnerTarget = id(3001);
  const accountAdminTarget = id(3002);
  const accountEditorTarget = id(3003);
  const accountNullableTarget = id(3004);
  const accountConcurrencyTarget = id(3005);
  const accountClosedTarget = id(3006);
  const accountWorkspace2Target = id(4001);
  const absentAccountId = id(9999);

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    service = new AccountsService(
      transaction,
      new PostgresAccountsAdapter(),
      new PostgresIdempotencyAdapter(),
    );

    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12)`,
      [
        subjectOwner,
        'acc-upd-owner@example.test',
        subjectAdmin,
        'acc-upd-admin@example.test',
        subjectEditor,
        'acc-upd-editor@example.test',
        subjectViewer,
        'acc-upd-viewer@example.test',
        subjectNonMember,
        'acc-upd-nonmember@example.test',
        subjectWorkspace2Owner,
        'acc-upd-ws2-owner@example.test',
      ],
    );

    for (const [userId, email, name] of [
      [subjectOwner, 'acc-upd-owner@example.test', 'Account Upd Owner'],
      [subjectAdmin, 'acc-upd-admin@example.test', 'Account Upd Admin'],
      [subjectEditor, 'acc-upd-editor@example.test', 'Account Upd Editor'],
      [subjectViewer, 'acc-upd-viewer@example.test', 'Account Upd Viewer'],
      [
        subjectNonMember,
        'acc-upd-nonmember@example.test',
        'Account Upd Non Member',
      ],
      [
        subjectWorkspace2Owner,
        'acc-upd-ws2-owner@example.test',
        'Account Upd WS2 Owner',
      ],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    for (const [wsId, name] of [
      [workspace1Id, 'Accounts Upd Workspace One'],
      [workspace2Id, 'Accounts Upd Workspace Two'],
    ] as const) {
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
         values ($1, $2, 'shared', 'USD', null)`,
        [wsId, name],
      );
    }

    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active'),
              ($1, $3, 'administrator', 'active'),
              ($1, $4, 'editor', 'active'),
              ($1, $5, 'viewer', 'active'),
              ($6, $7, 'owner', 'active'),
              ($6, $2, 'owner', 'active')`,
      [
        workspace1Id,
        subjectOwner,
        subjectAdmin,
        subjectEditor,
        subjectViewer,
        workspace2Id,
        subjectWorkspace2Owner,
      ],
    );

    // Seed accounts in workspace 1
    await admin.query(
      `insert into public.accounts
         (id, workspace_id, name, type, currency, status, institution, masked_number,
          description, color_token, icon, include_in_net_worth, created_by, created_at, updated_at, version, closed_at)
       values
         ($1, $2, 'Owner Account', 'checking', 'USD', 'active', 'Acme Bank', '**** 1111',
          'Initial description', null, null, true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1, null),
         ($4, $2, 'Admin Account', 'savings', 'USD', 'active', 'Beta Bank', '**** 2222',
          'Admin initial desc', null, null, true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1, null),
         ($5, $2, 'Editor Account', 'cash', 'USD', 'active', null, null,
          null, null, null, true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1, null),
         ($6, $2, 'Nullable Account', 'credit_card', 'USD', 'active', 'Chase', '**** 3333',
          'To be cleared', null, null, true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1, null),
         ($7, $2, 'Concurrency Account', 'checking', 'USD', 'active', null, null,
          null, null, null, true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1, null),
         ($8, $2, 'Closed Account', 'digital_wallet', 'USD', 'closed', null, null,
          'Retired wallet', null, null, false, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1, '2026-07-01T12:00:00.000Z'::timestamptz)`,
      [
        accountOwnerTarget,
        workspace1Id,
        subjectOwner,
        accountAdminTarget,
        accountEditorTarget,
        accountNullableTarget,
        accountConcurrencyTarget,
        accountClosedTarget,
      ],
    );

    // Seed account in workspace 2
    await admin.query(
      `insert into public.accounts
         (id, workspace_id, name, type, currency, status, institution, masked_number,
          description, color_token, icon, include_in_net_worth, created_by, created_at, updated_at, version)
       values
         ($1, $2, 'Workspace 2 Account', 'checking', 'USD', 'active', null, null,
          null, null, null, true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1)`,
      [accountWorkspace2Target, workspace2Id, subjectWorkspace2Owner],
    );
  });

  afterAll(async () => {
    await admin.end();
    await transaction.close();
  });

  it('updates account metadata by owner, bumping version and updated_at', async () => {
    const command: UpdateAccountCommand = {
      name: 'Owner Account Renamed',
      status: 'archived',
      includeInNetWorth: false,
    };

    const outcome = await service.update(
      subjectOwner,
      workspace1Id,
      accountOwnerTarget,
      command,
      1,
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.OK);
    if (outcome.kind === ACCOUNT_UPDATE_OUTCOMES.OK) {
      expect(outcome.account).toMatchObject({
        id: accountOwnerTarget,
        name: 'Owner Account Renamed',
        status: 'archived',
        includeInNetWorth: false,
        institution: 'Acme Bank', // untouched field preserved
        maskedNumber: '**** 1111',
        description: 'Initial description',
        version: 2,
      });
      expect(new Date(outcome.account.updatedAt).getTime()).toBeGreaterThan(
        new Date(outcome.account.createdAt).getTime(),
      );
    }

    // Direct database proof
    const dbRow = await admin.query(
      `select version, name, status, include_in_net_worth from public.accounts where id = $1`,
      [accountOwnerTarget],
    );
    expect(dbRow.rows[0]).toMatchObject({
      version: 2,
      name: 'Owner Account Renamed',
      status: 'archived',
      include_in_net_worth: false,
    });
  });

  it('updates account metadata by administrator', async () => {
    const command: UpdateAccountCommand = {
      name: 'Admin Account Updated',
      description: 'Updated by administrator',
    };

    const outcome = await service.update(
      subjectAdmin,
      workspace1Id,
      accountAdminTarget,
      command,
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.OK);
    if (outcome.kind === ACCOUNT_UPDATE_OUTCOMES.OK) {
      expect(outcome.account.name).toBe('Admin Account Updated');
      expect(outcome.account.description).toBe('Updated by administrator');
      expect(outcome.account.version).toBe(2);
    }
  });

  it('updates account metadata by editor', async () => {
    const command: UpdateAccountCommand = {
      name: 'Editor Account Updated',
      institution: 'Editor Bank',
    };

    const outcome = await service.update(
      subjectEditor,
      workspace1Id,
      accountEditorTarget,
      command,
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.OK);
    if (outcome.kind === ACCOUNT_UPDATE_OUTCOMES.OK) {
      expect(outcome.account.name).toBe('Editor Account Updated');
      expect(outcome.account.institution).toBe('Editor Bank');
      expect(outcome.account.version).toBe(2);
    }
  });

  it('refuses access with forbidden (403) when actor is viewer and does not mutate row', async () => {
    const command: UpdateAccountCommand = {
      name: 'Viewer Should Fail',
    };

    const outcome = await service.update(
      subjectViewer,
      workspace1Id,
      accountOwnerTarget,
      command,
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.FORBIDDEN);

    // Verify row in database is unchanged
    const dbRow = await admin.query(
      `select name, version from public.accounts where id = $1`,
      [accountOwnerTarget],
    );
    expect(dbRow.rows[0]?.name).not.toBe('Viewer Should Fail');
  });

  it('refuses access with forbidden (403) when actor is non-member', async () => {
    const outcome = await service.update(
      subjectNonMember,
      workspace1Id,
      accountOwnerTarget,
      { name: 'Non Member Should Fail' },
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.FORBIDDEN);
  });

  it('refuses access with forbidden (403) when workspace does not exist', async () => {
    const outcome = await service.update(
      subjectOwner,
      absentWorkspaceId,
      accountOwnerTarget,
      { name: 'Absent WS' },
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.FORBIDDEN);
  });

  it('returns not_found (404) when account does not exist in workspace', async () => {
    const outcome = await service.update(
      subjectOwner,
      workspace1Id,
      absentAccountId,
      { name: 'Absent Account' },
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.NOT_FOUND);
  });

  it('returns not_found (404, never 403) when account belongs to a different workspace (scoping proof)', async () => {
    // subjectOwner is owner in BOTH workspace 1 and workspace 2.
    // Querying with workspace1Id for accountWorkspace2Target MUST return not_found (404).
    const outcome = await service.update(
      subjectOwner,
      workspace1Id,
      accountWorkspace2Target,
      { name: 'Cross Workspace Exploit' },
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.NOT_FOUND);

    // Verify workspace 2 row was not touched
    const dbRow = await admin.query(
      `select name from public.accounts where id = $1`,
      [accountWorkspace2Target],
    );
    expect(dbRow.rows[0]?.name).toBe('Workspace 2 Account');
  });

  it('returns closed (403) when targeting a closed account: closed accounts cannot be modified', async () => {
    // Closure is a lifecycle state; the SQL UPDATE RLS policy enforces status <> 'closed'.
    // Returning 403 communicates clearly to the client that the account exists and cannot be modified.
    const outcome = await service.update(
      subjectOwner,
      workspace1Id,
      accountClosedTarget,
      { name: 'Attempt To Reopen Or Edit Closed' },
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.CLOSED);

    // Verify row in database was unchanged
    const dbRow = await admin.query(
      `select name, version, status from public.accounts where id = $1`,
      [accountClosedTarget],
    );
    expect(dbRow.rows[0]?.name).toBe('Closed Account');
    expect(dbRow.rows[0]?.version).toBe(1);
    expect(dbRow.rows[0]?.status).toBe('closed');
  });

  it('clears nullable fields with explicit null and writes NULL to PostgreSQL', async () => {
    const command: UpdateAccountCommand = {
      institution: null,
      maskedNumber: null,
      description: null,
    };

    const outcome = await service.update(
      subjectOwner,
      workspace1Id,
      accountNullableTarget,
      command,
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.OK);
    if (outcome.kind === ACCOUNT_UPDATE_OUTCOMES.OK) {
      expect(outcome.account.institution).toBeNull();
      expect(outcome.account.maskedNumber).toBeNull();
      expect(outcome.account.description).toBeNull();
      expect(outcome.account.version).toBe(2);
    }

    // Direct database proof that columns are now NULL
    const dbRow = await admin.query(
      `select institution, masked_number, description, version from public.accounts where id = $1`,
      [accountNullableTarget],
    );
    expect(dbRow.rows[0]).toEqual({
      institution: null,
      masked_number: null,
      description: null,
      version: 2,
    });
  });

  it('returns version_conflict (412) on stale If-Match and makes NO row change in database', async () => {
    // First update moves version to 2
    const firstUpdate = await service.update(
      subjectOwner,
      workspace1Id,
      accountConcurrencyTarget,
      { name: 'Concurrency V2' },
      1,
    );
    expect(firstUpdate.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.OK);

    // Second update with stale version 1
    const staleUpdate = await service.update(
      subjectOwner,
      workspace1Id,
      accountConcurrencyTarget,
      { name: 'Stale Update V1' },
      1,
    );

    expect(staleUpdate.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.VERSION_CONFLICT);

    // Verify row in database is still at version 2 with 'Concurrency V2'
    const dbRow = await admin.query(
      `select name, version from public.accounts where id = $1`,
      [accountConcurrencyTarget],
    );
    expect(dbRow.rows[0]).toEqual({
      name: 'Concurrency V2',
      version: 2,
    });
  });
});
