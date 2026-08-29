// Migrations under test: 202608290002_catalog_tables.sql
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CATALOG_LIST_OUTCOMES,
  type Payee,
  type PayeeListOk,
  type Tag,
  type TagListOk,
} from '../../src/catalogs/catalogs.port.js';
import {
  createTagListQuery,
  createPayeeListQuery,
  CatalogQueryValidationError,
} from '../../src/catalogs/catalog-query.js';
import { decodeCursor } from '../../src/platform/cursor.js';
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

describe('CatalogsService listTags and listPayees database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: CatalogsService;

  const subjectOwner = subject(871);
  const subjectViewer = subject(872);
  const subjectNonMember = subject(873);
  const subjectForeignOwner = subject(874);

  const workspace1Id = id(891);
  const foreignWorkspaceId = id(892);
  const absentWorkspaceId = id(899);

  // Microsecond seeds for workspace 1 with mixed timestamps and UUID tie-breaking
  // Expected order by (created_at asc, id asc):
  // 1. tag8001: 2026-08-20T10:00:00.000000Z -> tied created_at with tag8002, id 8001 < 8002
  // 2. tag8002: 2026-08-20T10:00:00.000000Z -> tied created_at with tag8001, id 8002 > 8001
  // 3. tag8003: 2026-08-25T14:00:00.000000Z
  // 4. tag8004: 2026-08-28T12:00:00.000000Z
  // 5. tag8005: 2026-08-28T18:00:00.000000Z (archived: true)
  const tag8001 = id(8001);
  const tag8002 = id(8002);
  const tag8003 = id(8003);
  const tag8004 = id(8004);
  const tag8005 = id(8005);
  const foreignTagId = id(8099);

  const expectedTagOrder = [tag8001, tag8002, tag8003, tag8004, tag8005];

  const payee8001 = id(8101);
  const payee8002 = id(8102);
  const payee8003 = id(8103);
  const payee8004 = id(8104);
  const payee8005 = id(8105);
  const foreignPayeeId = id(8199);

  const expectedPayeeOrder = [
    payee8001,
    payee8002,
    payee8003,
    payee8004,
    payee8005,
  ];

  async function listAllTags(
    subjectId: string,
    wsId: string,
    options: {
      readonly cursorParam?: string;
      readonly limitParam?: string;
    } = {},
  ): Promise<
    | {
        readonly kind: typeof CATALOG_LIST_OUTCOMES.OK;
        readonly tags: readonly Tag[];
        readonly ids: readonly string[];
        readonly hasNextPage: boolean;
        readonly nextCursor: string | null;
      }
    | { readonly kind: typeof CATALOG_LIST_OUTCOMES.FORBIDDEN }
  > {
    const query = createTagListQuery({
      workspaceId: wsId,
      cursorParam: options.cursorParam,
      limitParam: options.limitParam,
    });

    const outcome = await service.listTags(subjectId, query);
    if (outcome.kind === CATALOG_LIST_OUTCOMES.FORBIDDEN) return outcome;
    const ok = outcome as TagListOk;
    return {
      kind: ok.kind,
      tags: ok.page.items,
      ids: ok.page.items.map((t) => t.id),
      hasNextPage: ok.page.pageInfo.hasNextPage,
      nextCursor: ok.page.pageInfo.nextCursor,
    };
  }

  async function listAllPayees(
    subjectId: string,
    wsId: string,
    options: {
      readonly cursorParam?: string;
      readonly limitParam?: string;
    } = {},
  ): Promise<
    | {
        readonly kind: typeof CATALOG_LIST_OUTCOMES.OK;
        readonly payees: readonly Payee[];
        readonly ids: readonly string[];
        readonly hasNextPage: boolean;
        readonly nextCursor: string | null;
      }
    | { readonly kind: typeof CATALOG_LIST_OUTCOMES.FORBIDDEN }
  > {
    const query = createPayeeListQuery({
      workspaceId: wsId,
      cursorParam: options.cursorParam,
      limitParam: options.limitParam,
    });

    const outcome = await service.listPayees(subjectId, query);
    if (outcome.kind === CATALOG_LIST_OUTCOMES.FORBIDDEN) return outcome;
    const ok = outcome as PayeeListOk;
    return {
      kind: ok.kind,
      payees: ok.page.items,
      ids: ok.page.items.map((p) => p.id),
      hasNextPage: ok.page.pageInfo.hasNextPage,
      nextCursor: ok.page.pageInfo.nextCursor,
    };
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    service = new CatalogsService(
      transaction,
      new PostgresCatalogsAdapter(),
      new PostgresIdempotencyAdapter(),
    );

    // 1. Users
    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8)`,
      [
        subjectOwner,
        'cat-list-owner@example.test',
        subjectViewer,
        'cat-list-viewer@example.test',
        subjectNonMember,
        'cat-list-nonmember@example.test',
        subjectForeignOwner,
        'cat-list-foreign@example.test',
      ],
    );

    // 2. Profiles
    for (const [userId, email, name] of [
      [subjectOwner, 'cat-list-owner@example.test', 'Cat List Owner'],
      [subjectViewer, 'cat-list-viewer@example.test', 'Cat List Viewer'],
      [
        subjectNonMember,
        'cat-list-nonmember@example.test',
        'Cat List Non Member',
      ],
      [
        subjectForeignOwner,
        'cat-list-foreign@example.test',
        'Cat List Foreign Owner',
      ],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    // 3. Workspaces
    for (const [wsId, name, ownerId] of [
      [workspace1Id, 'Cat List Workspace One', subjectOwner],
      [foreignWorkspaceId, 'Cat List Foreign Workspace', subjectForeignOwner],
    ] as const) {
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
         values ($1, $2, 'shared', 'USD', null, $3)`,
        [wsId, name, ownerId],
      );
    }

    // 4. Memberships
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active'),
              ($1, $3, 'viewer', 'active'),
              ($4, $5, 'owner', 'active')`,
      [
        workspace1Id,
        subjectOwner,
        subjectViewer,
        foreignWorkspaceId,
        subjectForeignOwner,
      ],
    );

    // 5. Seed tags in workspace 1
    const tagSeeds = [
      {
        id: tag8001,
        name: 'Seed Tag 8001',
        createdAt: '2026-08-20T10:00:00.000000Z',
        archived: false,
      },
      {
        id: tag8002,
        name: 'Seed Tag 8002',
        createdAt: '2026-08-20T10:00:00.000000Z', // identical timestamp to tag8001
        archived: false,
      },
      {
        id: tag8003,
        name: 'Seed Tag 8003',
        createdAt: '2026-08-25T14:00:00.000000Z',
        archived: false,
      },
      {
        id: tag8004,
        name: 'Seed Tag 8004',
        createdAt: '2026-08-28T12:00:00.000000Z',
        archived: false,
      },
      {
        id: tag8005,
        name: 'Seed Tag 8005',
        createdAt: '2026-08-28T18:00:00.000000Z',
        archived: true, // Deliberately archived
      },
    ];

    for (const t of tagSeeds) {
      await admin.query(
        `insert into public.tags (id, workspace_id, name, archived, created_at, created_by)
         values ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6::uuid)`,
        [t.id, workspace1Id, t.name, t.archived, t.createdAt, subjectOwner],
      );
    }

    // 6. Seed foreign tag in foreign workspace
    await admin.query(
      `insert into public.tags (id, workspace_id, name, archived, created_at, created_by)
       values ($1::uuid, $2::uuid, 'Foreign Tag', false, '2026-08-28T12:00:00.000000Z'::timestamptz, $3::uuid)`,
      [foreignTagId, foreignWorkspaceId, subjectForeignOwner],
    );

    // 7. Seed payees in workspace 1
    const payeeSeeds = [
      {
        id: payee8001,
        name: 'Seed Payee 8001',
        createdAt: '2026-08-20T10:00:00.000000Z',
        archived: false,
      },
      {
        id: payee8002,
        name: 'Seed Payee 8002',
        createdAt: '2026-08-20T10:00:00.000000Z', // identical timestamp to payee8001
        archived: false,
      },
      {
        id: payee8003,
        name: 'Seed Payee 8003',
        createdAt: '2026-08-25T14:00:00.000000Z',
        archived: false,
      },
      {
        id: payee8004,
        name: 'Seed Payee 8004',
        createdAt: '2026-08-28T12:00:00.000000Z',
        archived: false,
      },
      {
        id: payee8005,
        name: 'Seed Payee 8005',
        createdAt: '2026-08-28T18:00:00.000000Z',
        archived: true, // Deliberately archived
      },
    ];

    for (const p of payeeSeeds) {
      await admin.query(
        `insert into public.payees (id, workspace_id, name, archived, created_at, created_by)
         values ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6::uuid)`,
        [p.id, workspace1Id, p.name, p.archived, p.createdAt, subjectOwner],
      );
    }

    // 8. Seed foreign payee in foreign workspace
    await admin.query(
      `insert into public.payees (id, workspace_id, name, archived, created_at, created_by)
       values ($1::uuid, $2::uuid, 'Foreign Payee', false, '2026-08-28T12:00:00.000000Z'::timestamptz, $3::uuid)`,
      [foreignPayeeId, foreignWorkspaceId, subjectForeignOwner],
    );
  });

  afterAll(async () => {
    await admin.query(
      `delete from public.tags where workspace_id in ($1, $2)`,
      [workspace1Id, foreignWorkspaceId],
    );
    await admin.query(
      `delete from public.payees where workspace_id in ($1, $2)`,
      [workspace1Id, foreignWorkspaceId],
    );
    await admin.query(`delete from public.workspaces where id in ($1, $2)`, [
      workspace1Id,
      foreignWorkspaceId,
    ]);
    await admin.query(`delete from auth.users where id in ($1, $2, $3, $4)`, [
      subjectOwner,
      subjectViewer,
      subjectNonMember,
      subjectForeignOwner,
    ]);
    await pool.end();
    await admin.end();
  });

  describe('Tags listing and pagination', () => {
    it('200 happy path: returns all workspace tags in (created_at asc, id asc) order', async () => {
      const outcome = await listAllTags(subjectOwner, workspace1Id);
      expect(outcome.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (outcome.kind !== CATALOG_LIST_OUTCOMES.OK) return;

      expect(outcome.ids).toEqual(expectedTagOrder);

      // Prove tie-break on id asc: tag8001 and tag8002 have identical created_at,
      // but tag8001 (ending in 8001) < tag8002 (ending in 8002), so tag8001 MUST precede tag8002.
      const t1Index = outcome.ids.indexOf(tag8001);
      const t2Index = outcome.ids.indexOf(tag8002);
      expect(t1Index).toBeLessThan(t2Index);
    });

    it('cursor pagination walks the whole tag set exactly once with no duplicates and no omissions', async () => {
      // 5 seeded tags in workspace 1, page size = 2
      const walkedIds: string[] = [];
      let currentCursor: string | undefined = undefined;

      while (true) {
        const page = await listAllTags(subjectOwner, workspace1Id, {
          limitParam: '2',
          cursorParam: currentCursor,
        });

        expect(page.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
        if (page.kind !== CATALOG_LIST_OUTCOMES.OK) break;

        walkedIds.push(...page.ids);

        if (!page.hasNextPage || page.nextCursor === null) {
          break;
        }
        currentCursor = page.nextCursor;
      }

      // Assert collected IDs equal expected default order with NO duplicates and NO omissions
      expect(walkedIds).toEqual(expectedTagOrder);
      expect(new Set(walkedIds).size).toBe(expectedTagOrder.length);
    });

    it('rows sharing the same created_at are paged correctly across page boundaries', async () => {
      // Page 1 with limit 1
      const page1 = await listAllTags(subjectOwner, workspace1Id, {
        limitParam: '1',
      });
      expect(page1.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (page1.kind !== CATALOG_LIST_OUTCOMES.OK) return;

      expect(page1.ids).toEqual([tag8001]);
      expect(page1.hasNextPage).toBe(true);
      expect(page1.nextCursor).not.toBeNull();

      // Page 2 with limit 1 using page 1's nextCursor
      const page2 = await listAllTags(subjectOwner, workspace1Id, {
        limitParam: '1',
        cursorParam: page1.nextCursor!,
      });
      expect(page2.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (page2.kind !== CATALOG_LIST_OUTCOMES.OK) return;

      // Despite tag8001 and tag8002 having the exact same created_at timestamp,
      // page 2 correctly returns tag8002 via composite (created_at, id) seek
      expect(page2.ids).toEqual([tag8002]);
    });

    it('a cursor minted in workspace A, replayed against workspace B, is rejected', async () => {
      const page1 = await listAllTags(subjectOwner, workspace1Id, {
        limitParam: '2',
      });
      expect(page1.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (page1.kind !== CATALOG_LIST_OUTCOMES.OK) return;

      const cursorWs1 = page1.nextCursor!;
      expect(cursorWs1).toBeDefined();

      // createTagListQuery enforces expectedWorkspaceId and rejects foreign-workspace cursor with CatalogQueryValidationError
      expect(() =>
        createTagListQuery({
          workspaceId: foreignWorkspaceId,
          cursorParam: cursorWs1,
        }),
      ).toThrow(CatalogQueryValidationError);

      // Shared decodeCursor also rejects cursor with mismatched expectedWorkspaceId
      const decodedForeign = decodeCursor(cursorWs1, foreignWorkspaceId);
      expect(decodedForeign).toBeUndefined();
    });

    it('an archived tag is still listed (query intentionally has no archived filter)', async () => {
      const outcome = await listAllTags(subjectOwner, workspace1Id);
      expect(outcome.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (outcome.kind !== CATALOG_LIST_OUTCOMES.OK) return;

      const tag5 = outcome.tags.find((t) => t.id === tag8005);
      expect(tag5).toBeDefined();
      expect(tag5?.archived).toBe(true);
    });

    it('an anchor row deleted between pages does not break the seek', async () => {
      // 1. Fetch page 1 with limit 2 -> [tag8001, tag8002]
      const page1 = await listAllTags(subjectOwner, workspace1Id, {
        limitParam: '2',
      });
      expect(page1.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (page1.kind !== CATALOG_LIST_OUTCOMES.OK) return;
      expect(page1.ids).toEqual([tag8001, tag8002]);
      const cursor1 = page1.nextCursor!;

      // 2. Insert temporary tag that acts as anchor
      const tempTagId = id(8088);
      await admin.query(
        `insert into public.tags (id, workspace_id, name, archived, created_at, created_by)
         values ($1::uuid, $2::uuid, 'Temp Anchor Tag', false, '2026-08-22T10:00:00.000000Z'::timestamptz, $3::uuid)`,
        [tempTagId, workspace1Id, subjectOwner],
      );

      // Fetch page from cursor1 -> will include tempTagId as first item
      const pageWithTemp = await listAllTags(subjectOwner, workspace1Id, {
        limitParam: '1',
        cursorParam: cursor1,
      });
      expect(pageWithTemp.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (pageWithTemp.kind !== CATALOG_LIST_OUTCOMES.OK) return;
      expect(pageWithTemp.ids).toEqual([tempTagId]);
      const tempCursor = pageWithTemp.nextCursor!;

      // 3. Delete the anchor tag
      await admin.query(`delete from public.tags where id = $1::uuid`, [
        tempTagId,
      ]);

      // 4. Fetch next page using tempCursor (anchor row no longer exists in DB)
      const pageAfterDelete = await listAllTags(subjectOwner, workspace1Id, {
        limitParam: '2',
        cursorParam: tempCursor,
      });
      expect(pageAfterDelete.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (pageAfterDelete.kind !== CATALOG_LIST_OUTCOMES.OK) return;

      // Keyset comparison (created_at, id) > ($2, $3) does not require the anchor row to exist;
      // it seamlessly continues to tag8003, tag8004
      expect(pageAfterDelete.ids).toEqual([tag8003, tag8004]);
    });
  });

  describe('Payees listing and pagination', () => {
    it('200 happy path: returns all workspace payees in (created_at asc, id asc) order', async () => {
      const outcome = await listAllPayees(subjectOwner, workspace1Id);
      expect(outcome.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (outcome.kind !== CATALOG_LIST_OUTCOMES.OK) return;

      expect(outcome.ids).toEqual(expectedPayeeOrder);

      // Prove tie-break on id asc: payee8001 and payee8002 have identical created_at,
      // but payee8001 (ending in 8101) < payee8002 (ending in 8102), so payee8001 MUST precede payee8002.
      const p1Index = outcome.ids.indexOf(payee8001);
      const p2Index = outcome.ids.indexOf(payee8002);
      expect(p1Index).toBeLessThan(p2Index);
    });

    it('cursor pagination walks the whole payee set exactly once with no duplicates and no omissions', async () => {
      const walkedIds: string[] = [];
      let currentCursor: string | undefined = undefined;

      while (true) {
        const page = await listAllPayees(subjectOwner, workspace1Id, {
          limitParam: '2',
          cursorParam: currentCursor,
        });

        expect(page.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
        if (page.kind !== CATALOG_LIST_OUTCOMES.OK) break;

        walkedIds.push(...page.ids);

        if (!page.hasNextPage || page.nextCursor === null) {
          break;
        }
        currentCursor = page.nextCursor;
      }

      expect(walkedIds).toEqual(expectedPayeeOrder);
      expect(new Set(walkedIds).size).toBe(expectedPayeeOrder.length);
    });

    it('rows sharing the same created_at are paged correctly across page boundaries for payees', async () => {
      const page1 = await listAllPayees(subjectOwner, workspace1Id, {
        limitParam: '1',
      });
      expect(page1.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (page1.kind !== CATALOG_LIST_OUTCOMES.OK) return;

      expect(page1.ids).toEqual([payee8001]);
      expect(page1.hasNextPage).toBe(true);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await listAllPayees(subjectOwner, workspace1Id, {
        limitParam: '1',
        cursorParam: page1.nextCursor!,
      });
      expect(page2.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (page2.kind !== CATALOG_LIST_OUTCOMES.OK) return;

      expect(page2.ids).toEqual([payee8002]);
    });

    it('a payee cursor minted in workspace A, replayed against workspace B, is rejected', async () => {
      const page1 = await listAllPayees(subjectOwner, workspace1Id, {
        limitParam: '2',
      });
      expect(page1.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (page1.kind !== CATALOG_LIST_OUTCOMES.OK) return;

      const cursorWs1 = page1.nextCursor!;
      expect(cursorWs1).toBeDefined();

      expect(() =>
        createPayeeListQuery({
          workspaceId: foreignWorkspaceId,
          cursorParam: cursorWs1,
        }),
      ).toThrow(CatalogQueryValidationError);

      const decodedForeign = decodeCursor(cursorWs1, foreignWorkspaceId);
      expect(decodedForeign).toBeUndefined();
    });

    it('an archived payee is still listed (query intentionally has no archived filter)', async () => {
      const outcome = await listAllPayees(subjectOwner, workspace1Id);
      expect(outcome.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (outcome.kind !== CATALOG_LIST_OUTCOMES.OK) return;

      const payee5 = outcome.payees.find((p) => p.id === payee8005);
      expect(payee5).toBeDefined();
      expect(payee5?.archived).toBe(true);
    });

    it('an anchor payee row deleted between pages does not break the seek', async () => {
      const page1 = await listAllPayees(subjectOwner, workspace1Id, {
        limitParam: '2',
      });
      expect(page1.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (page1.kind !== CATALOG_LIST_OUTCOMES.OK) return;
      expect(page1.ids).toEqual([payee8001, payee8002]);
      const cursor1 = page1.nextCursor!;

      const tempPayeeId = id(8188);
      await admin.query(
        `insert into public.payees (id, workspace_id, name, archived, created_at, created_by)
         values ($1::uuid, $2::uuid, 'Temp Anchor Payee', false, '2026-08-22T10:00:00.000000Z'::timestamptz, $3::uuid)`,
        [tempPayeeId, workspace1Id, subjectOwner],
      );

      const pageWithTemp = await listAllPayees(subjectOwner, workspace1Id, {
        limitParam: '1',
        cursorParam: cursor1,
      });
      expect(pageWithTemp.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (pageWithTemp.kind !== CATALOG_LIST_OUTCOMES.OK) return;
      expect(pageWithTemp.ids).toEqual([tempPayeeId]);
      const tempCursor = pageWithTemp.nextCursor!;

      await admin.query(`delete from public.payees where id = $1::uuid`, [
        tempPayeeId,
      ]);

      const pageAfterDelete = await listAllPayees(subjectOwner, workspace1Id, {
        limitParam: '2',
        cursorParam: tempCursor,
      });
      expect(pageAfterDelete.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (pageAfterDelete.kind !== CATALOG_LIST_OUTCOMES.OK) return;

      expect(pageAfterDelete.ids).toEqual([payee8003, payee8004]);
    });
  });

  describe('Isolation and Authorization', () => {
    it('admits a viewer because select policy admits all workspace roles', async () => {
      const tagOutcome = await listAllTags(subjectViewer, workspace1Id);
      expect(tagOutcome.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (tagOutcome.kind === CATALOG_LIST_OUTCOMES.OK) {
        expect(tagOutcome.ids).toEqual(expectedTagOrder);
      }

      const payeeOutcome = await listAllPayees(subjectViewer, workspace1Id);
      expect(payeeOutcome.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (payeeOutcome.kind === CATALOG_LIST_OUTCOMES.OK) {
        expect(payeeOutcome.ids).toEqual(expectedPayeeOrder);
      }
    });

    it('refuses a non-member with FORBIDDEN', async () => {
      const tagOutcome = await listAllTags(subjectNonMember, workspace1Id);
      expect(tagOutcome.kind).toBe(CATALOG_LIST_OUTCOMES.FORBIDDEN);

      const payeeOutcome = await listAllPayees(subjectNonMember, workspace1Id);
      expect(payeeOutcome.kind).toBe(CATALOG_LIST_OUTCOMES.FORBIDDEN);
    });

    it('isolation vacuity guard: caller with no active role in foreign workspace gets 403 (target workspace genuinely contains rows)', async () => {
      const foreignTagCount = await admin.query<{ count: string }>(
        'select count(*) as count from public.tags where workspace_id = $1::uuid',
        [foreignWorkspaceId],
      );
      expect(Number(foreignTagCount.rows[0]?.count)).toBeGreaterThan(0);

      const tagOutcome = await listAllTags(subjectOwner, foreignWorkspaceId);
      expect(tagOutcome.kind).toBe(CATALOG_LIST_OUTCOMES.FORBIDDEN);

      const foreignPayeeCount = await admin.query<{ count: string }>(
        'select count(*) as count from public.payees where workspace_id = $1::uuid',
        [foreignWorkspaceId],
      );
      expect(Number(foreignPayeeCount.rows[0]?.count)).toBeGreaterThan(0);

      const payeeOutcome = await listAllPayees(
        subjectOwner,
        foreignWorkspaceId,
      );
      expect(payeeOutcome.kind).toBe(CATALOG_LIST_OUTCOMES.FORBIDDEN);
    });

    it('refuses an absent workspace with 403 to prevent leaking existence', async () => {
      const tagOutcome = await listAllTags(subjectOwner, absentWorkspaceId);
      expect(tagOutcome.kind).toBe(CATALOG_LIST_OUTCOMES.FORBIDDEN);

      const payeeOutcome = await listAllPayees(subjectOwner, absentWorkspaceId);
      expect(payeeOutcome.kind).toBe(CATALOG_LIST_OUTCOMES.FORBIDDEN);
    });

    it('workspace isolation: foreign workspace tags and payees never leak into workspace 1 queries (RLS)', async () => {
      const tagOutcome = await listAllTags(subjectOwner, workspace1Id);
      expect(tagOutcome.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (tagOutcome.kind === CATALOG_LIST_OUTCOMES.OK) {
        expect(tagOutcome.ids).not.toContain(foreignTagId);
      }

      const payeeOutcome = await listAllPayees(subjectOwner, workspace1Id);
      expect(payeeOutcome.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
      if (payeeOutcome.kind === CATALOG_LIST_OUTCOMES.OK) {
        expect(payeeOutcome.ids).not.toContain(foreignPayeeId);
      }
    });
  });
});
