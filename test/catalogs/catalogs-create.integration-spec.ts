// Migrations under test: 202608290002_catalog_tables.sql
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CATALOG_CREATE_OUTCOMES,
  type CreateNamedResourceCommand,
  type PayeeCreateCreated,
  type TagCreateCreated,
  type CatalogCreateReplayed,
} from '../../src/catalogs/catalogs.port.js';
import { CatalogsService } from '../../src/catalogs/catalogs.service.js';
import { PostgresCatalogsAdapter } from '../../src/catalogs/postgres-catalogs.adapter.js';
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

describe('CatalogsService createTag and createPayee database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: CatalogsService;

  const subjectOwner = subject(861);
  const subjectAdmin = subject(862);
  const subjectEditor = subject(863);
  const subjectViewer = subject(864);
  const subjectNonMember = subject(865);
  const subjectWs2Owner = subject(866);

  const workspace1Id = id(881);
  const workspace2Id = id(882);

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    service = new CatalogsService(
      transaction,
      new PostgresCatalogsAdapter(),
      new PostgresIdempotencyAdapter(),
    );

    // 1. Users & Profiles
    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12)`,
      [
        subjectOwner,
        'cat-create-owner@example.test',
        subjectAdmin,
        'cat-create-admin@example.test',
        subjectEditor,
        'cat-create-editor@example.test',
        subjectViewer,
        'cat-create-viewer@example.test',
        subjectNonMember,
        'cat-create-nonmember@example.test',
        subjectWs2Owner,
        'cat-create-ws2owner@example.test',
      ],
    );

    for (const [userId, email, name] of [
      [subjectOwner, 'cat-create-owner@example.test', 'Catalog Create Owner'],
      [subjectAdmin, 'cat-create-admin@example.test', 'Catalog Create Admin'],
      [
        subjectEditor,
        'cat-create-editor@example.test',
        'Catalog Create Editor',
      ],
      [
        subjectViewer,
        'cat-create-viewer@example.test',
        'Catalog Create Viewer',
      ],
      [
        subjectNonMember,
        'cat-create-nonmember@example.test',
        'Catalog Create Non Member',
      ],
      [
        subjectWs2Owner,
        'cat-create-ws2owner@example.test',
        'Catalog Create Ws2 Owner',
      ],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    // 2. Workspaces
    for (const [wsId, name, ownerId] of [
      [workspace1Id, 'Catalogs Create Workspace One', subjectOwner],
      [workspace2Id, 'Catalogs Create Workspace Two', subjectWs2Owner],
    ] as const) {
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
         values ($1, $2, 'shared', 'USD', null, $3)`,
        [wsId, name, ownerId],
      );
    }

    // 3. Memberships
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
        subjectWs2Owner,
      ],
    );
  });

  afterAll(async () => {
    await admin.query(
      `delete from public.tags where workspace_id in ($1, $2)`,
      [workspace1Id, workspace2Id],
    );
    await admin.query(
      `delete from public.payees where workspace_id in ($1, $2)`,
      [workspace1Id, workspace2Id],
    );
    await admin.query(`delete from public.workspaces where id in ($1, $2)`, [
      workspace1Id,
      workspace2Id,
    ]);
    await admin.query(
      `delete from auth.users where id in ($1, $2, $3, $4, $5, $6)`,
      [
        subjectOwner,
        subjectAdmin,
        subjectEditor,
        subjectViewer,
        subjectNonMember,
        subjectWs2Owner,
      ],
    );
    await pool.end();
    await admin.end();
  });

  describe('Tags creation', () => {
    it('201 happy path: owner creates a tag, row is persisted in public.tags with created_by and archived = false', async () => {
      const key = '00000000-0000-4000-8000-000000003001';
      const command: CreateNamedResourceCommand = {
        name: 'Groceries',
      };

      const outcome = await service.createTag(
        subjectOwner,
        workspace1Id,
        command,
        key,
      );
      expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
      const created = (outcome as TagCreateCreated).tag;
      expect(created.id).toBeDefined();
      expect(created.name).toBe('Groceries');
      expect(created.archived).toBe(false);

      const rows = await admin.query<{
        id: string;
        workspace_id: string;
        name: string;
        created_by: string;
        archived: boolean;
      }>(`select * from public.tags where id = $1::uuid`, [created.id]);
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0];
      expect(row.workspace_id).toBe(workspace1Id);
      expect(row.name).toBe('Groceries');
      expect(row.created_by).toBe(subjectOwner);
      expect(row.archived).toBe(false);
    });

    it('201 happy path: editor creates a tag', async () => {
      const key = '00000000-0000-4000-8000-000000003002';
      const command: CreateNamedResourceCommand = {
        name: 'Utilities',
      };

      const outcome = await service.createTag(
        subjectEditor,
        workspace1Id,
        command,
        key,
      );
      expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
      const created = (outcome as TagCreateCreated).tag;
      expect(created.name).toBe('Utilities');
      expect(created.archived).toBe(false);
    });

    it('409 conflict: genuine duplicate tag name in same workspace produces real 23505 and adapter maps to conflict outcome', async () => {
      const key1 = '00000000-0000-4000-8000-000000003003';
      const key2 = '00000000-0000-4000-8000-000000003004';
      const command: CreateNamedResourceCommand = {
        name: 'Entertainment',
      };

      const first = await service.createTag(
        subjectOwner,
        workspace1Id,
        command,
        key1,
      );
      expect(first.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);

      const second = await service.createTag(
        subjectOwner,
        workspace1Id,
        command,
        key2,
      );
      expect(second.kind).toBe(CATALOG_CREATE_OUTCOMES.CONFLICT);

      const countRes = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.tags where workspace_id = $1 and name = 'Entertainment'`,
        [workspace1Id],
      );
      expect(countRes.rows[0].count).toBe('1');
    });

    it('per-workspace uniqueness: same tag name in a DIFFERENT workspace succeeds', async () => {
      const key = '00000000-0000-4000-8000-000000003005';
      const command: CreateNamedResourceCommand = {
        name: 'Groceries',
      };

      const outcome = await service.createTag(
        subjectWs2Owner,
        workspace2Id,
        command,
        key,
      );
      expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
      const created = (outcome as TagCreateCreated).tag;
      expect(created.name).toBe('Groceries');

      const countRes = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.tags where name = 'Groceries'`,
      );
      expect(countRes.rows[0].count).toBe('2');
    });

    it('idempotent replay returns stored tag and does not duplicate tags rows', async () => {
      const key = '00000000-0000-4000-8000-000000003006';
      const command: CreateNamedResourceCommand = {
        name: 'Healthcare',
      };

      const countBefore = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.tags where workspace_id = $1 and name = 'Healthcare'`,
        [workspace1Id],
      );
      expect(countBefore.rows[0].count).toBe('0');

      const first = await service.createTag(
        subjectOwner,
        workspace1Id,
        command,
        key,
      );
      expect(first.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
      const firstTag = (first as TagCreateCreated).tag;

      const second = await service.createTag(
        subjectOwner,
        workspace1Id,
        command,
        key,
      );
      expect(second.kind).toBe(CATALOG_CREATE_OUTCOMES.REPLAYED);
      const replayed = second as CatalogCreateReplayed;
      expect(replayed.status).toBe(201);
      expect((replayed.body as { id: string }).id).toBe(firstTag.id);

      const countAfter = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.tags where workspace_id = $1 and name = 'Healthcare'`,
        [workspace1Id],
      );
      expect(countAfter.rows[0].count).toBe('1');
    });

    it('idempotent conflict: reusing idempotency key with different payload returns IDEMPOTENCY_CONFLICT and creates nothing', async () => {
      const key = '00000000-0000-4000-8000-000000003007';
      const command1: CreateNamedResourceCommand = {
        name: 'Education',
      };

      const first = await service.createTag(
        subjectOwner,
        workspace1Id,
        command1,
        key,
      );
      expect(first.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);

      const command2: CreateNamedResourceCommand = {
        name: 'Higher Education',
      };

      const second = await service.createTag(
        subjectOwner,
        workspace1Id,
        command2,
        key,
      );
      expect(second.kind).toBe(CATALOG_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT);

      const countRes = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.tags where workspace_id = $1 and name = 'Higher Education'`,
        [workspace1Id],
      );
      expect(countRes.rows[0].count).toBe('0');
    });

    it('403 forbidden: viewer role is refused by service and blocks persistence (0 rows written)', async () => {
      const key = '00000000-0000-4000-8000-000000003008';
      const command: CreateNamedResourceCommand = {
        name: 'Viewer Tag Attempt',
      };

      const outcome = await service.createTag(
        subjectViewer,
        workspace1Id,
        command,
        key,
      );
      expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.FORBIDDEN);

      const rows = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.tags where workspace_id = $1 and name = 'Viewer Tag Attempt'`,
        [workspace1Id],
      );
      expect(rows.rows[0].count).toBe('0');
    });

    it('403 forbidden: non-member is refused', async () => {
      const key = '00000000-0000-4000-8000-000000003009';
      const command: CreateNamedResourceCommand = {
        name: 'Non Member Tag Attempt',
      };

      const outcome = await service.createTag(
        subjectNonMember,
        workspace1Id,
        command,
        key,
      );
      expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.FORBIDDEN);
    });

    it('403 forbidden: member of another workspace cannot create in this workspace', async () => {
      const key = '00000000-0000-4000-8000-000000003010';
      const command: CreateNamedResourceCommand = {
        name: 'Cross Workspace Tag Attempt',
      };

      const outcome = await service.createTag(
        subjectWs2Owner,
        workspace1Id,
        command,
        key,
      );
      expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.FORBIDDEN);
    });
  });

  describe('Payees creation', () => {
    it('201 happy path: owner creates a payee, row is persisted in public.payees with created_by and archived = false', async () => {
      const key = '00000000-0000-4000-8000-000000004001';
      const command: CreateNamedResourceCommand = {
        name: 'Acme Supermarket',
      };

      const outcome = await service.createPayee(
        subjectOwner,
        workspace1Id,
        command,
        key,
      );
      expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
      const created = (outcome as PayeeCreateCreated).payee;
      expect(created.id).toBeDefined();
      expect(created.name).toBe('Acme Supermarket');
      expect(created.archived).toBe(false);

      const rows = await admin.query<{
        id: string;
        workspace_id: string;
        name: string;
        created_by: string;
        archived: boolean;
      }>(`select * from public.payees where id = $1::uuid`, [created.id]);
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0];
      expect(row.workspace_id).toBe(workspace1Id);
      expect(row.name).toBe('Acme Supermarket');
      expect(row.created_by).toBe(subjectOwner);
      expect(row.archived).toBe(false);
    });

    it('201 happy path: administrator creates a payee', async () => {
      const key = '00000000-0000-4000-8000-000000004002';
      const command: CreateNamedResourceCommand = {
        name: 'City Electric Utility',
      };

      const outcome = await service.createPayee(
        subjectAdmin,
        workspace1Id,
        command,
        key,
      );
      expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
      const created = (outcome as PayeeCreateCreated).payee;
      expect(created.name).toBe('City Electric Utility');
      expect(created.archived).toBe(false);
    });

    it('409 conflict: genuine duplicate payee name in same workspace produces real 23505 and adapter maps to conflict outcome', async () => {
      const key1 = '00000000-0000-4000-8000-000000004003';
      const key2 = '00000000-0000-4000-8000-000000004004';
      const command: CreateNamedResourceCommand = {
        name: 'Water Services Inc',
      };

      const first = await service.createPayee(
        subjectOwner,
        workspace1Id,
        command,
        key1,
      );
      expect(first.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);

      const second = await service.createPayee(
        subjectOwner,
        workspace1Id,
        command,
        key2,
      );
      expect(second.kind).toBe(CATALOG_CREATE_OUTCOMES.CONFLICT);

      const countRes = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.payees where workspace_id = $1 and name = 'Water Services Inc'`,
        [workspace1Id],
      );
      expect(countRes.rows[0].count).toBe('1');
    });

    it('per-workspace uniqueness: same payee name in a DIFFERENT workspace succeeds', async () => {
      const key = '00000000-0000-4000-8000-000000004005';
      const command: CreateNamedResourceCommand = {
        name: 'Acme Supermarket',
      };

      const outcome = await service.createPayee(
        subjectWs2Owner,
        workspace2Id,
        command,
        key,
      );
      expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
      const created = (outcome as PayeeCreateCreated).payee;
      expect(created.name).toBe('Acme Supermarket');

      const countRes = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.payees where name = 'Acme Supermarket'`,
      );
      expect(countRes.rows[0].count).toBe('2');
    });

    it('idempotent replay returns stored payee and does not duplicate payees rows', async () => {
      const key = '00000000-0000-4000-8000-000000004006';
      const command: CreateNamedResourceCommand = {
        name: 'Internet Provider Co',
      };

      const countBefore = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.payees where workspace_id = $1 and name = 'Internet Provider Co'`,
        [workspace1Id],
      );
      expect(countBefore.rows[0].count).toBe('0');

      const first = await service.createPayee(
        subjectOwner,
        workspace1Id,
        command,
        key,
      );
      expect(first.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
      const firstPayee = (first as PayeeCreateCreated).payee;

      const second = await service.createPayee(
        subjectOwner,
        workspace1Id,
        command,
        key,
      );
      expect(second.kind).toBe(CATALOG_CREATE_OUTCOMES.REPLAYED);
      const replayed = second as CatalogCreateReplayed;
      expect(replayed.status).toBe(201);
      expect((replayed.body as { id: string }).id).toBe(firstPayee.id);

      const countAfter = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.payees where workspace_id = $1 and name = 'Internet Provider Co'`,
        [workspace1Id],
      );
      expect(countAfter.rows[0].count).toBe('1');
    });

    it('idempotent conflict: reusing idempotency key with different payload returns IDEMPOTENCY_CONFLICT and creates nothing', async () => {
      const key = '00000000-0000-4000-8000-000000004007';
      const command1: CreateNamedResourceCommand = {
        name: 'Coffee Shop A',
      };

      const first = await service.createPayee(
        subjectOwner,
        workspace1Id,
        command1,
        key,
      );
      expect(first.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);

      const command2: CreateNamedResourceCommand = {
        name: 'Coffee Shop B',
      };

      const second = await service.createPayee(
        subjectOwner,
        workspace1Id,
        command2,
        key,
      );
      expect(second.kind).toBe(CATALOG_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT);

      const countRes = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.payees where workspace_id = $1 and name = 'Coffee Shop B'`,
        [workspace1Id],
      );
      expect(countRes.rows[0].count).toBe('0');
    });

    it('403 forbidden: viewer role is refused by service and blocks persistence (0 rows written)', async () => {
      const key = '00000000-0000-4000-8000-000000004008';
      const command: CreateNamedResourceCommand = {
        name: 'Viewer Payee Attempt',
      };

      const outcome = await service.createPayee(
        subjectViewer,
        workspace1Id,
        command,
        key,
      );
      expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.FORBIDDEN);

      const rows = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.payees where workspace_id = $1 and name = 'Viewer Payee Attempt'`,
        [workspace1Id],
      );
      expect(rows.rows[0].count).toBe('0');
    });

    it('403 forbidden: non-member is refused', async () => {
      const key = '00000000-0000-4000-8000-000000004009';
      const command: CreateNamedResourceCommand = {
        name: 'Non Member Payee Attempt',
      };

      const outcome = await service.createPayee(
        subjectNonMember,
        workspace1Id,
        command,
        key,
      );
      expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.FORBIDDEN);
    });

    it('403 forbidden: member of another workspace cannot create in this workspace', async () => {
      const key = '00000000-0000-4000-8000-000000004010';
      const command: CreateNamedResourceCommand = {
        name: 'Cross Workspace Payee Attempt',
      };

      const outcome = await service.createPayee(
        subjectWs2Owner,
        workspace1Id,
        command,
        key,
      );
      expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.FORBIDDEN);
    });
  });
});
