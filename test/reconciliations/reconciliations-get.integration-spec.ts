// Migrations under test: 202608310002_reconciliations.sql
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  RECONCILIATION_GET_OUTCOMES,
  type ReconciliationGetFound,
} from '../../src/reconciliations/reconciliation.port.js';
import { ReconciliationService } from '../../src/reconciliations/reconciliation.service.js';
import { PostgresReconciliationAdapter } from '../../src/reconciliations/postgres-reconciliation.adapter.js';
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

describe('ReconciliationService getReconciliation database boundary and isolation', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let adapter: PostgresReconciliationAdapter;
  let service: ReconciliationService;

  const subjectDualMember = subject(6001); // Owner of ws1 and ws2
  const subjectViewer = subject(6002); // Viewer in ws1
  const subjectNonMember = subject(6003); // Non-member

  const workspace1Id = id(6051);
  const workspace2Id = id(6052);
  const absentWorkspaceId = id(6099);

  const ws1AccountId = id(6071);
  const ws2AccountId = id(6072);

  const recW1OpenId = id(6101);
  const recW1CompletedId = id(6102);
  const recW2OpenId = id(6103);
  const absentRecId = id(6199);

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    adapter = new PostgresReconciliationAdapter();
    service = new ReconciliationService(
      transaction,
      adapter,
      new PostgresIdempotencyAdapter(),
    );

    // 1. Users
    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6)`,
      [
        subjectDualMember,
        'rec-get-dual@example.test',
        subjectViewer,
        'rec-get-viewer@example.test',
        subjectNonMember,
        'rec-get-nonmember@example.test',
      ],
    );

    // 2. Profiles
    for (const [userId, email, name] of [
      [subjectDualMember, 'rec-get-dual@example.test', 'Rec Dual Member'],
      [subjectViewer, 'rec-get-viewer@example.test', 'Rec Viewer'],
      [subjectNonMember, 'rec-get-nonmember@example.test', 'Rec Non Member'],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    // 3. Workspaces
    for (const [wsId, name] of [
      [workspace1Id, 'Rec Get Workspace One'],
      [workspace2Id, 'Rec Get Workspace Two'],
    ] as const) {
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
         values ($1, $2, 'shared', 'USD', null)`,
        [wsId, name],
      );
    }

    // 4. Memberships
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active'),
              ($3, $2, 'owner', 'active'),
              ($1, $4, 'viewer', 'active')`,
      [workspace1Id, subjectDualMember, workspace2Id, subjectViewer],
    );

    // 5. Accounts
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, created_by)
       values ($1, $2, 'WS1 Account', 'checking', 'USD', 'active', $3),
              ($4, $5, 'WS2 Account', 'checking', 'USD', 'active', $3)`,
      [
        ws1AccountId,
        workspace1Id,
        subjectDualMember,
        ws2AccountId,
        workspace2Id,
      ],
    );

    // 6. Reconciliations in Workspace 1
    // 6a. Open reconciliation with notes (notes persisted, not in Reconciliation response)
    await admin.query(
      `insert into public.reconciliations (
         id, workspace_id, account_id, statement_date, statement_balance_minor,
         statement_currency, system_balance_minor, difference_minor, status, notes,
         created_by, created_at, completed_at
       ) values (
         $1, $2, $3, '2026-08-30', 25000, 'USD', 20000, 5000, 'open', 'Review pending',
         $4, '2026-08-31T12:00:00Z', null
       )`,
      [recW1OpenId, workspace1Id, ws1AccountId, subjectDualMember],
    );

    // 6b. Completed reconciliation in Workspace 1
    // First, account 2 in WS1 so we don't violate partial unique index
    const ws1Account2Id = id(6073);
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, created_by)
       values ($1, $2, 'WS1 Account 2', 'savings', 'USD', 'active', $3)`,
      [ws1Account2Id, workspace1Id, subjectDualMember],
    );

    await admin.query(
      `insert into public.reconciliations (
         id, workspace_id, account_id, statement_date, statement_balance_minor,
         statement_currency, system_balance_minor, difference_minor, status, notes,
         created_by, created_at, completed_at
       ) values (
         $1, $2, $3, '2026-08-25', 10000, 'USD', 10000, 0, 'completed', null,
         $4, '2026-08-26T12:00:00Z', '2026-08-26T12:05:00Z'
       )`,
      [recW1CompletedId, workspace1Id, ws1Account2Id, subjectDualMember],
    );

    // 7. Reconciliation in Workspace 2
    await admin.query(
      `insert into public.reconciliations (
         id, workspace_id, account_id, statement_date, statement_balance_minor,
         statement_currency, system_balance_minor, difference_minor, status, notes,
         created_by, created_at, completed_at
       ) values (
         $1, $2, $3, '2026-08-30', 50000, 'USD', 48000, 2000, 'open', null,
         $4, '2026-08-31T12:00:00Z', null
       )`,
      [recW2OpenId, workspace2Id, ws2AccountId, subjectDualMember],
    );
  });

  afterAll(async () => {
    if (admin) {
      await admin.query(
        `delete from public.reconciliations where workspace_id in ($1, $2)`,
        [workspace1Id, workspace2Id],
      );
      await admin.query(
        `delete from public.accounts where workspace_id in ($1, $2)`,
        [workspace1Id, workspace2Id],
      );
      await admin.query(`delete from public.workspaces where id in ($1, $2)`, [
        workspace1Id,
        workspace2Id,
      ]);
      await admin.query(`delete from auth.users where id in ($1, $2, $3)`, [
        subjectDualMember,
        subjectViewer,
        subjectNonMember,
      ]);
      await admin.end();
    }
    if (pool) {
      await pool.end();
    }
  });

  it('reads open reconciliation with exact response schema (200 shape)', async () => {
    const outcome = await service.getReconciliation(
      subjectDualMember,
      workspace1Id,
      recW1OpenId,
    );

    expect(outcome.kind).toBe(RECONCILIATION_GET_OUTCOMES.FOUND);
    const rec = (outcome as ReconciliationGetFound).reconciliation;

    expect(rec).toEqual({
      id: recW1OpenId,
      accountId: ws1AccountId,
      statementDate: '2026-08-30',
      statementBalance: {
        amountMinor: '25000',
        currency: 'USD',
      },
      systemBalance: {
        amountMinor: '20000',
        currency: 'USD',
      },
      difference: {
        amountMinor: '5000',
        currency: 'USD',
      },
      status: 'open',
      completedAt: null,
    });
    // Ensure notes is NOT present in response object
    expect('notes' in rec).toBe(false);
  });

  it('reads completed reconciliation with completedAt timestamp (200 shape)', async () => {
    const outcome = await service.getReconciliation(
      subjectDualMember,
      workspace1Id,
      recW1CompletedId,
    );

    expect(outcome.kind).toBe(RECONCILIATION_GET_OUTCOMES.FOUND);
    const rec = (outcome as ReconciliationGetFound).reconciliation;

    expect(rec.status).toBe('completed');
    expect(rec.completedAt).toBe('2026-08-26T12:05:00.000Z');
  });

  it('admits viewer role for reading reconciliation (select policy admits all active members)', async () => {
    const outcome = await service.getReconciliation(
      subjectViewer,
      workspace1Id,
      recW1OpenId,
    );

    expect(outcome.kind).toBe(RECONCILIATION_GET_OUTCOMES.FOUND);
    const rec = (outcome as ReconciliationGetFound).reconciliation;
    expect(rec.id).toBe(recW1OpenId);
  });

  it('refuses access with FORBIDDEN (403) when caller is not a member of workspace', async () => {
    const outcome = await service.getReconciliation(
      subjectNonMember,
      workspace1Id,
      recW1OpenId,
    );
    expect(outcome.kind).toBe(RECONCILIATION_GET_OUTCOMES.FORBIDDEN);
  });

  it('refuses access with FORBIDDEN (403) when workspace does not exist', async () => {
    const outcome = await service.getReconciliation(
      subjectDualMember,
      absentWorkspaceId,
      recW1OpenId,
    );
    expect(outcome.kind).toBe(RECONCILIATION_GET_OUTCOMES.FORBIDDEN);
  });

  it('returns NOT_FOUND (404) when reconciliation does not exist in workspace', async () => {
    const outcome = await service.getReconciliation(
      subjectDualMember,
      workspace1Id,
      absentRecId,
    );
    expect(outcome.kind).toBe(RECONCILIATION_GET_OUTCOMES.NOT_FOUND);
  });

  it('returns NOT_FOUND (404, never 403) when reconciliation belongs to another workspace', async () => {
    // Dual member is owner of both ws1 and ws2; requests recW2OpenId under workspace1Id header
    const outcomeDual = await service.getReconciliation(
      subjectDualMember,
      workspace1Id,
      recW2OpenId,
    );
    expect(outcomeDual.kind).toBe(RECONCILIATION_GET_OUTCOMES.NOT_FOUND);

    // Viewer is only member of ws1; requests recW2OpenId under workspace1Id header
    const outcomeViewer = await service.getReconciliation(
      subjectViewer,
      workspace1Id,
      recW2OpenId,
    );
    expect(outcomeViewer.kind).toBe(RECONCILIATION_GET_OUTCOMES.NOT_FOUND);
  });

  it('adapter-level cross-tenant proof: findReconciliationById with mismatched workspaceId returns undefined', async () => {
    await transaction.runRead(subjectDualMember, async (client) => {
      const mismatch = await adapter.findReconciliationById(
        client,
        workspace1Id,
        recW2OpenId,
      );
      expect(mismatch).toBeUndefined();

      const match = await adapter.findReconciliationById(
        client,
        workspace2Id,
        recW2OpenId,
      );
      expect(match).toBeDefined();
      expect(match?.id).toBe(recW2OpenId);
    });
  });
});
