import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTransaction } from '../../src/identity/pg-transaction.js';
import { PostgresWorkspaceAdapter } from '../../src/identity/postgres-workspace.adapter.js';
import { PostgresConfig } from '../../src/identity/postgres-config.js';
import { PostgresPool } from '../../src/identity/postgres-pool.js';
import { WorkspaceService } from '../../src/identity/workspace.service.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('WorkspaceService and PostgresWorkspaceAdapter database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  const adapter = new PostgresWorkspaceAdapter();
  let service: WorkspaceService;

  const subjectOwner = subject(700);
  const subjectEditor = subject(701);
  const subjectSuspended = subject(702);
  const subjectNonMember = subject(703);

  const sharedWorkspaceId = '00000000-0000-0000-0000-000000000750';

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    service = new WorkspaceService(transaction, adapter);

    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8)`,
      [
        subjectOwner,
        'owner@example.test',
        subjectEditor,
        'editor@example.test',
        subjectSuspended,
        'suspended@example.test',
        subjectNonMember,
        'nonmember@example.test',
      ],
    );

    for (const [id, email, name] of [
      [subjectOwner, 'owner@example.test', 'Owner User'],
      [subjectEditor, 'editor@example.test', 'Editor User'],
      [subjectSuspended, 'suspended@example.test', 'Suspended User'],
      [subjectNonMember, 'nonmember@example.test', 'Non Member User'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
       values ($1, 'Acme Shared Workspace', 'shared', 'USD', null)`,
      [sharedWorkspaceId],
    );

    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active'),
              ($1, $3, 'editor', 'active'),
              ($1, $4, 'viewer', 'suspended')`,
      [sharedWorkspaceId, subjectOwner, subjectEditor, subjectSuspended],
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it('an active member reads the workspace and gets the seven fields with the right role', async () => {
    const outcome = await service.read(subjectOwner, sharedWorkspaceId);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;

    expect(outcome.workspace).toEqual({
      id: sharedWorkspaceId,
      name: 'Acme Shared Workspace',
      kind: 'shared',
      baseCurrency: 'USD',
      role: 'owner',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
      version: 1,
    });
    expect(Object.keys(outcome.workspace).sort()).toEqual(
      [
        'id',
        'name',
        'kind',
        'baseCurrency',
        'role',
        'createdAt',
        'version',
      ].sort(),
    );
  });

  it("role is the caller's own role, not another member's", async () => {
    const ownerOutcome = await service.read(subjectOwner, sharedWorkspaceId);
    expect(ownerOutcome.kind).toBe('ok');
    if (ownerOutcome.kind === 'ok') {
      expect(ownerOutcome.workspace.role).toBe('owner');
    }

    const editorOutcome = await service.read(subjectEditor, sharedWorkspaceId);
    expect(editorOutcome.kind).toBe('ok');
    if (editorOutcome.kind === 'ok') {
      expect(editorOutcome.workspace.role).toBe('editor');
    }
  });

  it('a suspended member gets 403 (forbidden) from the service (202607150006_workspace_active_membership.sql)', async () => {
    const outcome = await service.read(subjectSuspended, sharedWorkspaceId);
    expect(outcome.kind).toBe('forbidden');
  });

  it('hardened RLS policy returns zero rows for a suspended member selecting from public.workspaces (202607150006_workspace_active_membership.sql)', async () => {
    const result = await transaction.runRead(subjectSuspended, (client) =>
      client.query<{ id: string }>(
        'select id from public.workspaces where id = $1',
        [sharedWorkspaceId],
      ),
    );
    expect(result.rows).toHaveLength(0);
  });

  it('a non-member gets 404 (not-found) from the service', async () => {
    const outcome = await service.read(subjectNonMember, sharedWorkspaceId);
    expect(outcome.kind).toBe('not-found');
  });

  it('a non-member selecting from public.workspaces returns zero rows under RLS', async () => {
    const result = await transaction.runRead(subjectNonMember, (client) =>
      client.query<{ id: string }>(
        'select id from public.workspaces where id = $1',
        [sharedWorkspaceId],
      ),
    );
    expect(result.rows).toHaveLength(0);
  });
});
