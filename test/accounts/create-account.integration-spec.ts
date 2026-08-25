import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCOUNT_CREATE_OUTCOMES,
  type CreateAccountCommand,
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

describe('AccountsService createAccount database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: AccountsService;

  const subjectOwner = subject(801);
  const subjectAdmin = subject(802);
  const subjectEditor = subject(803);
  const subjectViewer = subject(804);
  const subjectNonMember = subject(805);
  const subjectWorkspace2Owner = subject(806);

  const workspace1Id = id(851);
  const workspace2Id = id(852);
  const absentWorkspaceId = id(899);

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
        'acc-owner@example.test',
        subjectAdmin,
        'acc-admin@example.test',
        subjectEditor,
        'acc-editor@example.test',
        subjectViewer,
        'acc-viewer@example.test',
        subjectNonMember,
        'acc-nonmember@example.test',
        subjectWorkspace2Owner,
        'acc-ws2-owner@example.test',
      ],
    );

    for (const [userId, email, name] of [
      [subjectOwner, 'acc-owner@example.test', 'Account Owner'],
      [subjectAdmin, 'acc-admin@example.test', 'Account Admin'],
      [subjectEditor, 'acc-editor@example.test', 'Account Editor'],
      [subjectViewer, 'acc-viewer@example.test', 'Account Viewer'],
      [subjectNonMember, 'acc-nonmember@example.test', 'Account Non Member'],
      [
        subjectWorkspace2Owner,
        'acc-ws2-owner@example.test',
        'Account WS2 Owner',
      ],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    for (const [wsId, name] of [
      [workspace1Id, 'Accounts Workspace One'],
      [workspace2Id, 'Accounts Workspace Two'],
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
              ($6, $7, 'owner', 'active')`,
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
  });

  afterAll(async () => {
    await admin.end();
    await pool.end();
  });

  const baseCommand: CreateAccountCommand = {
    name: 'Main Checking',
    type: 'checking',
    currency: 'USD',
    institution: 'Bank of Example',
    maskedNumber: '***9876',
    description: 'Operating cash flow',
    includeInNetWorth: true,
  };

  it('allows workspace owner to create an account under RLS', async () => {
    const idempotencyKey = id(101);
    const outcome = await service.create(
      subjectOwner,
      workspace1Id,
      baseCommand,
      idempotencyKey,
    );

    expect(outcome.kind).toBe(ACCOUNT_CREATE_OUTCOMES.CREATED);
    if (outcome.kind !== ACCOUNT_CREATE_OUTCOMES.CREATED) return;

    expect(outcome.account.name).toBe('Main Checking');
    expect(outcome.account.type).toBe('checking');
    expect(outcome.account.currency).toBe('USD');
    expect(outcome.account.status).toBe('active');
    expect(outcome.account.institution).toBe('Bank of Example');
    expect(outcome.account.maskedNumber).toBe('***9876');
    expect(outcome.account.description).toBe('Operating cash flow');
    expect(outcome.account.includeInNetWorth).toBe(true);
    expect(outcome.account.version).toBe(1);

    // Verify row in database and created_by attribution
    const dbRow = await admin.query(
      'select workspace_id, created_by, version, status from public.accounts where id = $1::uuid',
      [outcome.account.id],
    );
    expect(dbRow.rows).toHaveLength(1);
    expect(dbRow.rows[0].workspace_id).toBe(workspace1Id);
    expect(dbRow.rows[0].created_by).toBe(subjectOwner);
    expect(dbRow.rows[0].version).toBe(1);
    expect(dbRow.rows[0].status).toBe('active');
  });

  it('allows administrator to create an account under RLS', async () => {
    const idempotencyKey = id(102);
    const command: CreateAccountCommand = {
      name: 'Admin Savings',
      type: 'savings',
      currency: 'USD',
      institution: null,
      maskedNumber: null,
      description: null,
      includeInNetWorth: true,
    };
    const outcome = await service.create(
      subjectAdmin,
      workspace1Id,
      command,
      idempotencyKey,
    );

    expect(outcome.kind).toBe(ACCOUNT_CREATE_OUTCOMES.CREATED);
    if (outcome.kind !== ACCOUNT_CREATE_OUTCOMES.CREATED) return;
    expect(outcome.account.name).toBe('Admin Savings');
  });

  it('allows editor to create an account under RLS', async () => {
    const idempotencyKey = id(103);
    const command: CreateAccountCommand = {
      name: 'Editor Petty Cash',
      type: 'cash',
      currency: 'USD',
      institution: null,
      maskedNumber: null,
      description: null,
      includeInNetWorth: true,
    };
    const outcome = await service.create(
      subjectEditor,
      workspace1Id,
      command,
      idempotencyKey,
    );

    expect(outcome.kind).toBe(ACCOUNT_CREATE_OUTCOMES.CREATED);
    if (outcome.kind !== ACCOUNT_CREATE_OUTCOMES.CREATED) return;
    expect(outcome.account.name).toBe('Editor Petty Cash');
  });

  it('refuses creation for viewer with 403 forbidden and creates no row', async () => {
    const idempotencyKey = id(104);
    const beforeCount = await admin.query(
      'select count(*)::int as count from public.accounts where workspace_id = $1::uuid',
      [workspace1Id],
    );

    const outcome = await service.create(
      subjectViewer,
      workspace1Id,
      baseCommand,
      idempotencyKey,
    );

    expect(outcome.kind).toBe(ACCOUNT_CREATE_OUTCOMES.FORBIDDEN);

    const afterCount = await admin.query(
      'select count(*)::int as count from public.accounts where workspace_id = $1::uuid',
      [workspace1Id],
    );
    expect(afterCount.rows[0].count).toBe(beforeCount.rows[0].count);
  });

  it('refuses creation for non-member with 403 forbidden and creates no row', async () => {
    const idempotencyKey = id(105);
    const beforeCount = await admin.query(
      'select count(*)::int as count from public.accounts where workspace_id = $1::uuid',
      [workspace1Id],
    );

    const outcome = await service.create(
      subjectNonMember,
      workspace1Id,
      baseCommand,
      idempotencyKey,
    );

    expect(outcome.kind).toBe(ACCOUNT_CREATE_OUTCOMES.FORBIDDEN);

    const afterCount = await admin.query(
      'select count(*)::int as count from public.accounts where workspace_id = $1::uuid',
      [workspace1Id],
    );
    expect(afterCount.rows[0].count).toBe(beforeCount.rows[0].count);
  });

  it('refuses creation for absent workspace with 403 forbidden', async () => {
    const idempotencyKey = id(106);
    const outcome = await service.create(
      subjectOwner,
      absentWorkspaceId,
      baseCommand,
      idempotencyKey,
    );

    expect(outcome.kind).toBe(ACCOUNT_CREATE_OUTCOMES.FORBIDDEN);
  });

  it('idempotently replays identical request producing exactly one row and identical response', async () => {
    const idempotencyKey = id(107);
    const command: CreateAccountCommand = {
      name: 'Replay Target Account',
      type: 'digital_wallet',
      currency: 'USD',
      institution: null,
      maskedNumber: null,
      description: null,
      includeInNetWorth: true,
    };

    const first = await service.create(
      subjectOwner,
      workspace1Id,
      command,
      idempotencyKey,
    );
    expect(first.kind).toBe(ACCOUNT_CREATE_OUTCOMES.CREATED);
    if (first.kind !== ACCOUNT_CREATE_OUTCOMES.CREATED) return;

    const second = await service.create(
      subjectOwner,
      workspace1Id,
      command,
      idempotencyKey,
    );
    expect(second.kind).toBe(ACCOUNT_CREATE_OUTCOMES.REPLAYED);
    if (second.kind !== ACCOUNT_CREATE_OUTCOMES.REPLAYED) return;

    expect(second.status).toBe(201);
    expect(second.etag).toBe(`"${first.account.version}"`);
    expect(second.body).toEqual(first.account);

    const count = await admin.query(
      'select count(*)::int as count from public.accounts where workspace_id = $1::uuid and name = $2',
      [workspace1Id, 'Replay Target Account'],
    );
    expect(count.rows[0].count).toBe(1);
  });

  it('answers 409 conflict when idempotency key is reused with different command in same workspace', async () => {
    const idempotencyKey = id(108);
    const commandA: CreateAccountCommand = {
      name: 'Conflict Account A',
      type: 'checking',
      currency: 'USD',
      institution: null,
      maskedNumber: null,
      description: null,
      includeInNetWorth: true,
    };
    const commandB: CreateAccountCommand = {
      name: 'Conflict Account B',
      type: 'savings',
      currency: 'EUR',
      institution: null,
      maskedNumber: null,
      description: null,
      includeInNetWorth: false,
    };

    const first = await service.create(
      subjectOwner,
      workspace1Id,
      commandA,
      idempotencyKey,
    );
    expect(first.kind).toBe(ACCOUNT_CREATE_OUTCOMES.CREATED);

    const second = await service.create(
      subjectOwner,
      workspace1Id,
      commandB,
      idempotencyKey,
    );
    expect(second.kind).toBe(ACCOUNT_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT);
  });

  it('proves workspace-scoping of idempotency key (same key, two workspaces, two accounts)', async () => {
    const sharedKey = id(109);
    const command: CreateAccountCommand = {
      name: 'Scoped Account',
      type: 'checking',
      currency: 'USD',
      institution: null,
      maskedNumber: null,
      description: null,
      includeInNetWorth: true,
    };

    // Create in workspace 1
    const res1 = await service.create(
      subjectOwner,
      workspace1Id,
      command,
      sharedKey,
    );
    expect(res1.kind).toBe(ACCOUNT_CREATE_OUTCOMES.CREATED);

    // Create in workspace 2 with identical key and command
    const res2 = await service.create(
      subjectWorkspace2Owner,
      workspace2Id,
      command,
      sharedKey,
    );
    expect(res2.kind).toBe(ACCOUNT_CREATE_OUTCOMES.CREATED);

    // Both exist in database as distinct accounts in their respective workspaces
    if (
      res1.kind === ACCOUNT_CREATE_OUTCOMES.CREATED &&
      res2.kind === ACCOUNT_CREATE_OUTCOMES.CREATED
    ) {
      expect(res1.account.id).not.toBe(res2.account.id);

      const rows = await admin.query(
        'select id, workspace_id from public.accounts where id in ($1::uuid, $2::uuid)',
        [res1.account.id, res2.account.id],
      );
      expect(rows.rows).toHaveLength(2);
    }
  });
});
