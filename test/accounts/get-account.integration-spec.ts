import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ACCOUNT_READ_OUTCOMES } from '../../src/accounts/accounts.port.js';
import { AccountsService } from '../../src/accounts/accounts.service.js';
import { PostgresAccountsAdapter } from '../../src/accounts/postgres-accounts.adapter.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const id = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('AccountsService getAccount database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: AccountsService;

  const subjectDualMember = subject(900); // Member of workspace 1 and workspace 2
  const subjectViewer = subject(901); // Viewer in workspace 1
  const subjectNonMember = subject(902); // Non-member of workspace 1

  const workspace1Id = id(951);
  const workspace2Id = id(952);
  const absentWorkspaceId = id(999);

  const accountW1AId = id(1001);
  const accountW1BId = id(1002);
  const accountW1CId = id(1003);
  const accountW2Id = id(2001);
  const absentAccountId = id(9999);

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    service = new AccountsService(transaction, new PostgresAccountsAdapter());

    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6)`,
      [
        subjectDualMember,
        'accounts-dual@example.test',
        subjectViewer,
        'accounts-viewer@example.test',
        subjectNonMember,
        'accounts-nonmember@example.test',
      ],
    );

    for (const [userId, email, name] of [
      [subjectDualMember, 'accounts-dual@example.test', 'Accounts Dual Member'],
      [subjectViewer, 'accounts-viewer@example.test', 'Accounts Viewer'],
      [
        subjectNonMember,
        'accounts-nonmember@example.test',
        'Accounts Non Member',
      ],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    for (const [wsId, name] of [
      [workspace1Id, 'Workspace One'],
      [workspace2Id, 'Workspace Two'],
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
              ($3, $2, 'owner', 'active'),
              ($1, $4, 'viewer', 'active')`,
      [workspace1Id, subjectDualMember, workspace2Id, subjectViewer],
    );

    // Workspace 1 accounts
    await admin.query(
      `insert into public.accounts
         (id, workspace_id, name, type, currency, status, institution, masked_number,
          description, color_token, icon, include_in_net_worth, created_by, created_at, updated_at, version, closed_at)
       values ($1, $2, 'Primary Checking', 'checking', 'USD', 'active', 'Acme Bank', '**** 1234',
               'Main operational account', '#112233', 'bank', true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1, null),
              ($4, $2, 'Reserve Cash', 'cash', 'USD', 'archived', null, null,
               null, null, null, false, $3, '2026-07-02T00:00:00.000Z'::timestamptz, '2026-07-02T00:00:00.000Z'::timestamptz, 2, null),
              ($5, $2, 'Retired Wallet', 'digital_wallet', 'USD', 'closed', null, null,
               null, null, null, false, $3, '2026-07-04T00:00:00.000Z'::timestamptz, '2026-07-04T00:00:00.000Z'::timestamptz, 3, '2026-07-04T12:00:00.000Z'::timestamptz)`,
      [
        accountW1AId,
        workspace1Id,
        subjectDualMember,
        accountW1BId,
        accountW1CId,
      ],
    );

    // Workspace 2 account
    await admin.query(
      `insert into public.accounts
         (id, workspace_id, name, type, currency, status, institution, masked_number,
          description, color_token, icon, include_in_net_worth, created_by, created_at, updated_at, version)
       values ($1, $2, 'Workspace 2 Savings', 'savings', 'USD', 'active', 'Beta Bank', '**** 5678',
               'W2 savings account', '#445566', 'vault', true, $3, '2026-07-03T00:00:00.000Z'::timestamptz, '2026-07-03T00:00:00.000Z'::timestamptz, 1)`,
      [accountW2Id, workspace2Id, subjectDualMember],
    );
  });

  afterAll(async () => {
    await admin.end();
    await transaction.close();
  });

  it('refuses access with forbidden (403) when the caller has no active role in the workspace (Table row 1)', async () => {
    const outcome = await service.read(
      subjectNonMember,
      workspace1Id,
      accountW1AId,
    );
    expect(outcome.kind).toBe(ACCOUNT_READ_OUTCOMES.FORBIDDEN);
  });

  it('refuses access with forbidden (403) when the workspace does not exist (Table row 1)', async () => {
    const outcome = await service.read(
      subjectDualMember,
      absentWorkspaceId,
      accountW1AId,
    );
    expect(outcome.kind).toBe(ACCOUNT_READ_OUTCOMES.FORBIDDEN);
  });

  it('returns not_found (404) when the caller is authorized but the account does not exist (Table row 2)', async () => {
    const outcome = await service.read(
      subjectDualMember,
      workspace1Id,
      absentAccountId,
    );
    expect(outcome.kind).toBe(ACCOUNT_READ_OUTCOMES.NOT_FOUND);
  });

  it('returns not_found (404, never 403) when the account exists but belongs to a different workspace (Table row 3)', async () => {
    // Non-member of workspace 2 (viewer is only member of workspace 1) looking for workspace 2's account in workspace 1
    const outcome = await service.read(
      subjectViewer,
      workspace1Id,
      accountW2Id,
    );
    expect(outcome.kind).toBe(ACCOUNT_READ_OUTCOMES.NOT_FOUND);
  });

  it('proves scoping is by requested workspace and not actor visibility: dual member requesting workspace 1 cannot read workspace 2 account (returns 404)', async () => {
    // subjectDualMember is an active owner in BOTH workspace 1 and workspace 2.
    // When querying with workspace1Id, accountW2Id MUST return not_found (404),
    // proving the account lookup is scoped strictly by workspace_id in the SQL predicate.
    const outcome = await service.read(
      subjectDualMember,
      workspace1Id,
      accountW2Id,
    );
    expect(outcome.kind).toBe(ACCOUNT_READ_OUTCOMES.NOT_FOUND);
  });

  it('reads account successfully returning full domain model and version', async () => {
    const outcome = await service.read(
      subjectDualMember,
      workspace1Id,
      accountW1AId,
    );
    expect(outcome).toEqual({
      kind: ACCOUNT_READ_OUTCOMES.OK,
      account: {
        id: accountW1AId,
        name: 'Primary Checking',
        type: 'checking',
        currency: 'USD',
        status: 'active',
        institution: 'Acme Bank',
        maskedNumber: '**** 1234',
        description: 'Main operational account',
        colorToken: '#112233',
        icon: 'bank',
        includeInNetWorth: true,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
        version: 1,
      },
    });
  });

  it('admits a viewer because the select policy admits all four roles', async () => {
    const outcome = await service.read(
      subjectViewer,
      workspace1Id,
      accountW1AId,
    );
    expect(outcome.kind).toBe(ACCOUNT_READ_OUTCOMES.OK);
    if (outcome.kind === ACCOUNT_READ_OUTCOMES.OK) {
      expect(outcome.account.id).toBe(accountW1AId);
    }
  });

  it('maps nullable fields correctly when null in database', async () => {
    const outcome = await service.read(
      subjectDualMember,
      workspace1Id,
      accountW1BId,
    );
    expect(outcome).toEqual({
      kind: ACCOUNT_READ_OUTCOMES.OK,
      account: {
        id: accountW1BId,
        name: 'Reserve Cash',
        type: 'cash',
        currency: 'USD',
        status: 'archived',
        institution: null,
        maskedNumber: null,
        description: null,
        colorToken: null,
        icon: null,
        includeInNetWorth: false,
        createdAt: '2026-07-02T00:00:00.000Z',
        updatedAt: '2026-07-02T00:00:00.000Z',
        version: 2,
      },
    });
  });

  it('reads a CLOSED account with a 200-shaped ok outcome: closure is a lifecycle state, not a visibility boundary', async () => {
    // The authority declares only 200/401/403/404 on getAccount and no status
    // parameter, so there is no contract mechanism to hide a lifecycle state,
    // and listAccounts serves closed rows from the same resource. The risk this
    // pins is real rather than theoretical: the UPDATE policy in 202608240002
    // filters closed rows (`using ... status <> 'closed'`), so the schema
    // already couples closure to row visibility on the write path. Nothing
    // stopped that coupling from leaking into the read path unnoticed.
    const outcome = await service.read(
      subjectDualMember,
      workspace1Id,
      accountW1CId,
    );
    expect(outcome).toEqual({
      kind: ACCOUNT_READ_OUTCOMES.OK,
      account: {
        id: accountW1CId,
        name: 'Retired Wallet',
        type: 'digital_wallet',
        currency: 'USD',
        status: 'closed',
        institution: null,
        maskedNumber: null,
        description: null,
        colorToken: null,
        icon: null,
        includeInNetWorth: false,
        createdAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-04T00:00:00.000Z',
        version: 3,
      },
    });
  });
});
