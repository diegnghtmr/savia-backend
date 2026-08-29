// Migrations under test: 202608290002_catalog_tables.sql
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CATALOG_CREATE_OUTCOMES,
  type CategoryCreateCreated,
  type CreateCategoryCommand,
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
      `delete from public.categories where workspace_id in ($1, $2)`,
      [workspace1Id, workspace2Id],
    );
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

  describe('Categories creation', () => {
    it('201 happy path: owner creates a root category (parentId null), row is persisted in public.categories with created_by, archived = false, kind, icon, colorToken', async () => {
      const key = '00000000-0000-4000-8000-000000005001';
      const command: CreateCategoryCommand = {
        name: 'Housing',
        kind: 'expense',
        parentId: null,
        icon: 'house',
        colorToken: 'blue-500',
      };

      const outcome = await service.createCategory(
        subjectOwner,
        workspace1Id,
        command,
        key,
      );
      expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
      const created = (outcome as CategoryCreateCreated).category;
      expect(created.id).toBeDefined();
      expect(created.name).toBe('Housing');
      expect(created.kind).toBe('expense');
      expect(created.parentId).toBeNull();
      expect(created.icon).toBe('house');
      expect(created.colorToken).toBe('blue-500');
      expect(created.archived).toBe(false);

      const rows = await admin.query<{
        id: string;
        workspace_id: string;
        parent_id: string | null;
        name: string;
        kind: string;
        icon: string | null;
        color_token: string | null;
        created_by: string;
        archived: boolean;
      }>(`select * from public.categories where id = $1::uuid`, [created.id]);
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0];
      expect(row.workspace_id).toBe(workspace1Id);
      expect(row.parent_id).toBeNull();
      expect(row.name).toBe('Housing');
      expect(row.kind).toBe('expense');
      expect(row.icon).toBe('house');
      expect(row.color_token).toBe('blue-500');
      expect(row.created_by).toBe(subjectOwner);
      expect(row.archived).toBe(false);
    });

    it('201 happy path: editor creates a child category under a legitimate parent; reads back with right parent_id, kind, icon, color_token', async () => {
      // 1. Create root parent
      const rootKey = '00000000-0000-4000-8000-000000005002';
      const rootOutcome = await service.createCategory(
        subjectOwner,
        workspace1Id,
        {
          name: 'Transportation',
          kind: 'expense',
          parentId: null,
          icon: 'car',
          colorToken: 'amber-500',
        },
        rootKey,
      );
      expect(rootOutcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
      const rootCategory = (rootOutcome as CategoryCreateCreated).category;

      // 2. Create child under root parent
      const childKey = '00000000-0000-4000-8000-000000005003';
      const childCommand: CreateCategoryCommand = {
        name: 'Fuel',
        kind: 'expense',
        parentId: rootCategory.id,
        icon: 'gas-pump',
        colorToken: 'orange-500',
      };

      const childOutcome = await service.createCategory(
        subjectEditor,
        workspace1Id,
        childCommand,
        childKey,
      );
      expect(childOutcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
      const childCategory = (childOutcome as CategoryCreateCreated).category;
      expect(childCategory.name).toBe('Fuel');
      expect(childCategory.parentId).toBe(rootCategory.id);
      expect(childCategory.kind).toBe('expense');
      expect(childCategory.icon).toBe('gas-pump');
      expect(childCategory.colorToken).toBe('orange-500');
      expect(childCategory.archived).toBe(false);

      const rows = await admin.query<{
        id: string;
        workspace_id: string;
        parent_id: string;
        name: string;
        kind: string;
        icon: string;
        color_token: string;
        created_by: string;
      }>(`select * from public.categories where id = $1::uuid`, [
        childCategory.id,
      ]);
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0];
      expect(row.parent_id).toBe(rootCategory.id);
      expect(row.name).toBe('Fuel');
      expect(row.kind).toBe('expense');
      expect(row.icon).toBe('gas-pump');
      expect(row.color_token).toBe('orange-500');
      expect(row.created_by).toBe(subjectEditor);
    });

    it('409 conflict: genuine duplicate ROOT category name raises real 23505 on categories_workspace_top_level_name_idx and adapter maps to conflict outcome', async () => {
      const key1 = '00000000-0000-4000-8000-000000005004';
      const key2 = '00000000-0000-4000-8000-000000005005';
      const command: CreateCategoryCommand = {
        name: 'Investments',
        kind: 'income',
        parentId: null,
        icon: 'chart',
        colorToken: 'green-500',
      };

      const first = await service.createCategory(
        subjectOwner,
        workspace1Id,
        command,
        key1,
      );
      expect(first.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);

      const second = await service.createCategory(
        subjectOwner,
        workspace1Id,
        command,
        key2,
      );
      expect(second.kind).toBe(CATALOG_CREATE_OUTCOMES.CONFLICT);

      const countRes = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.categories where workspace_id = $1 and name = 'Investments' and parent_id is null`,
        [workspace1Id],
      );
      expect(countRes.rows[0].count).toBe('1');
    });

    it('409 conflict: genuine duplicate CHILD category name under the same parent raises real 23505 on categories_workspace_parent_name_key and adapter maps to conflict outcome', async () => {
      // 1. Create root parent
      const rootKey = '00000000-0000-4000-8000-000000005006';
      const rootOutcome = await service.createCategory(
        subjectOwner,
        workspace1Id,
        {
          name: 'Food & Dining Root',
          kind: 'expense',
          parentId: null,
          icon: null,
          colorToken: null,
        },
        rootKey,
      );
      expect(rootOutcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
      const rootCategory = (rootOutcome as CategoryCreateCreated).category;

      // 2. First child
      const childKey1 = '00000000-0000-4000-8000-000000005007';
      const childCommand: CreateCategoryCommand = {
        name: 'Restaurants',
        kind: 'expense',
        parentId: rootCategory.id,
        icon: 'utensils',
        colorToken: 'red-500',
      };
      const first = await service.createCategory(
        subjectOwner,
        workspace1Id,
        childCommand,
        childKey1,
      );
      expect(first.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);

      // 3. Second child under SAME parent with SAME name -> 409
      const childKey2 = '00000000-0000-4000-8000-000000005008';
      const second = await service.createCategory(
        subjectOwner,
        workspace1Id,
        childCommand,
        childKey2,
      );
      expect(second.kind).toBe(CATALOG_CREATE_OUTCOMES.CONFLICT);

      const countRes = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.categories where workspace_id = $1 and name = 'Restaurants' and parent_id = $2`,
        [workspace1Id, rootCategory.id],
      );
      expect(countRes.rows[0].count).toBe('1');
    });

    it('sibling uniqueness: the same child name under a DIFFERENT parent SUCCEEDS', async () => {
      // 1. Create parent A
      const parentAOutcome = await service.createCategory(
        subjectOwner,
        workspace1Id,
        {
          name: 'Personal Expenses',
          kind: 'expense',
          parentId: null,
          icon: null,
          colorToken: null,
        },
        '00000000-0000-4000-8000-000000005009',
      );
      expect(parentAOutcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
      const parentA = (parentAOutcome as CategoryCreateCreated).category;

      // 2. Create parent B
      const parentBOutcome = await service.createCategory(
        subjectOwner,
        workspace1Id,
        {
          name: 'Business Expenses',
          kind: 'expense',
          parentId: null,
          icon: null,
          colorToken: null,
        },
        '00000000-0000-4000-8000-000000005010',
      );
      expect(parentBOutcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
      const parentB = (parentBOutcome as CategoryCreateCreated).category;

      // 3. Child 'Software' under parent A
      const childAOutcome = await service.createCategory(
        subjectOwner,
        workspace1Id,
        {
          name: 'Software',
          kind: 'expense',
          parentId: parentA.id,
          icon: 'laptop',
          colorToken: null,
        },
        '00000000-0000-4000-8000-000000005011',
      );
      expect(childAOutcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);

      // 4. Child 'Software' under parent B -> MUST SUCCEED (sibling uniqueness)
      const childBOutcome = await service.createCategory(
        subjectOwner,
        workspace1Id,
        {
          name: 'Software',
          kind: 'expense',
          parentId: parentB.id,
          icon: 'server',
          colorToken: null,
        },
        '00000000-0000-4000-8000-000000005012',
      );
      expect(childBOutcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);

      const countRes = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.categories where workspace_id = $1 and name = 'Software'`,
        [workspace1Id],
      );
      expect(countRes.rows[0].count).toBe('2');
    });

    it('per-workspace uniqueness: same category name in a DIFFERENT workspace succeeds', async () => {
      const key = '00000000-0000-4000-8000-000000005013';
      const command: CreateCategoryCommand = {
        name: 'Housing',
        kind: 'expense',
        parentId: null,
        icon: 'house',
        colorToken: 'blue-500',
      };

      const outcome = await service.createCategory(
        subjectWs2Owner,
        workspace2Id,
        command,
        key,
      );
      expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
      const created = (outcome as CategoryCreateCreated).category;
      expect(created.name).toBe('Housing');

      const countRes = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.categories where name = 'Housing'`,
      );
      expect(countRes.rows[0].count).toBe('2');
    });

    it('422 unprocessable: parentId from ANOTHER workspace raises real 23503 (categories_parent_workspace_fkey) and maps to parent_not_found outcome (0 rows created)', async () => {
      // 1. Create category in workspace 2
      const ws2CatOutcome = await service.createCategory(
        subjectWs2Owner,
        workspace2Id,
        {
          name: 'Ws2 Root Category',
          kind: 'expense',
          parentId: null,
          icon: null,
          colorToken: null,
        },
        '00000000-0000-4000-8000-000000005014',
      );
      expect(ws2CatOutcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
      const ws2Category = (ws2CatOutcome as CategoryCreateCreated).category;

      // 2. Attempt to create child in workspace 1 referencing ws2Category.id
      const countBefore = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.categories where workspace_id = $1`,
        [workspace1Id],
      );

      const crossOutcome = await service.createCategory(
        subjectOwner,
        workspace1Id,
        {
          name: 'Poison Child Attempt',
          kind: 'expense',
          parentId: ws2Category.id,
          icon: null,
          colorToken: null,
        },
        '00000000-0000-4000-8000-000000005015',
      );
      expect(crossOutcome.kind).toBe(CATALOG_CREATE_OUTCOMES.PARENT_NOT_FOUND);

      const countAfter = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.categories where workspace_id = $1`,
        [workspace1Id],
      );
      expect(countAfter.rows[0].count).toBe(countBefore.rows[0].count);
    });

    it('422 unprocessable: non-existent parentId raises real 23503 (categories_parent_workspace_fkey) and maps to parent_not_found outcome (0 rows created)', async () => {
      const nonExistentParentId = '00000000-0000-0000-0000-000000009999';
      const outcome = await service.createCategory(
        subjectOwner,
        workspace1Id,
        {
          name: 'Non Existent Parent Child Attempt',
          kind: 'expense',
          parentId: nonExistentParentId,
          icon: null,
          colorToken: null,
        },
        '00000000-0000-4000-8000-000000005016',
      );
      expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.PARENT_NOT_FOUND);

      const countRes = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.categories where name = 'Non Existent Parent Child Attempt'`,
      );
      expect(countRes.rows[0].count).toBe('0');
    });

    it('idempotent replay returns stored category and does not duplicate category rows (assert counts before and after)', async () => {
      const key = '00000000-0000-4000-8000-000000005017';
      const command: CreateCategoryCommand = {
        name: 'Healthcare',
        kind: 'expense',
        parentId: null,
        icon: 'heart-pulse',
        colorToken: 'rose-500',
      };

      const countBefore = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.categories where workspace_id = $1 and name = 'Healthcare'`,
        [workspace1Id],
      );
      expect(countBefore.rows[0].count).toBe('0');

      const first = await service.createCategory(
        subjectOwner,
        workspace1Id,
        command,
        key,
      );
      expect(first.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
      const firstCat = (first as CategoryCreateCreated).category;

      const second = await service.createCategory(
        subjectOwner,
        workspace1Id,
        command,
        key,
      );
      expect(second.kind).toBe(CATALOG_CREATE_OUTCOMES.REPLAYED);
      const replayed = second as CatalogCreateReplayed;
      expect(replayed.status).toBe(201);
      expect((replayed.body as { id: string }).id).toBe(firstCat.id);

      const countAfter = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.categories where workspace_id = $1 and name = 'Healthcare'`,
        [workspace1Id],
      );
      expect(countAfter.rows[0].count).toBe('1');
    });

    it('idempotent conflict: reusing idempotency key with different payload returns IDEMPOTENCY_CONFLICT and creates nothing', async () => {
      const key = '00000000-0000-4000-8000-000000005018';
      const command1: CreateCategoryCommand = {
        name: 'Education',
        kind: 'expense',
        parentId: null,
        icon: null,
        colorToken: null,
      };

      const first = await service.createCategory(
        subjectOwner,
        workspace1Id,
        command1,
        key,
      );
      expect(first.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);

      const command2: CreateCategoryCommand = {
        name: 'Higher Education',
        kind: 'expense',
        parentId: null,
        icon: null,
        colorToken: null,
      };

      const second = await service.createCategory(
        subjectOwner,
        workspace1Id,
        command2,
        key,
      );
      expect(second.kind).toBe(CATALOG_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT);

      const countRes = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.categories where workspace_id = $1 and name = 'Higher Education'`,
        [workspace1Id],
      );
      expect(countRes.rows[0].count).toBe('0');
    });

    it('403 forbidden: viewer role is refused by service and blocks persistence (0 rows written)', async () => {
      const key = '00000000-0000-4000-8000-000000005019';
      const command: CreateCategoryCommand = {
        name: 'Viewer Category Attempt',
        kind: 'expense',
        parentId: null,
        icon: null,
        colorToken: null,
      };

      const outcome = await service.createCategory(
        subjectViewer,
        workspace1Id,
        command,
        key,
      );
      expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.FORBIDDEN);

      const rows = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.categories where workspace_id = $1 and name = 'Viewer Category Attempt'`,
        [workspace1Id],
      );
      expect(rows.rows[0].count).toBe('0');
    });

    it('403 forbidden: non-member is refused', async () => {
      const key = '00000000-0000-4000-8000-000000005020';
      const command: CreateCategoryCommand = {
        name: 'Non Member Category Attempt',
        kind: 'expense',
        parentId: null,
        icon: null,
        colorToken: null,
      };

      const outcome = await service.createCategory(
        subjectNonMember,
        workspace1Id,
        command,
        key,
      );
      expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.FORBIDDEN);
    });

    it('403 forbidden: member of another workspace cannot create in this workspace', async () => {
      const key = '00000000-0000-4000-8000-000000005021';
      const command: CreateCategoryCommand = {
        name: 'Cross Workspace Category Attempt',
        kind: 'expense',
        parentId: null,
        icon: null,
        colorToken: null,
      };

      const outcome = await service.createCategory(
        subjectWs2Owner,
        workspace1Id,
        command,
        key,
      );
      expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.FORBIDDEN);
    });
  });
});
