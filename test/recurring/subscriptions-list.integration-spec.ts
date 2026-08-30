// Migrations under test: 202608290004_subscriptions.sql
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  decodeCursor,
  encodeCursor,
  type Cursor,
} from '../../src/platform/cursor.js';
import {
  SUBSCRIPTION_LIST_OUTCOMES,
  type SubscriptionListOk,
} from '../../src/recurring/recurring.port.js';
import {
  createSubscriptionListQuery,
  SubscriptionQueryValidationError,
} from '../../src/recurring/subscription-query.js';
import { RecurringService } from '../../src/recurring/recurring.service.js';
import { PostgresRecurringAdapter } from '../../src/recurring/postgres-recurring.adapter.js';
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

describe('RecurringService listSubscriptions database boundary and cursor traversal', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: RecurringService;

  const subjectOwner = subject(2061);
  const subjectViewer = subject(2062);
  const subjectNonMember = subject(2063);
  const subjectWs2Owner = subject(2064);

  const workspace1Id = id(2081);
  const workspace2Id = id(2082);

  const TOTAL_ITEMS = 12;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    service = new RecurringService(
      transaction,
      new PostgresRecurringAdapter(),
      new PostgresIdempotencyAdapter(),
    );

    // 1. Users & Profiles
    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8)`,
      [
        subjectOwner,
        'sub-list-owner@example.test',
        subjectViewer,
        'sub-list-viewer@example.test',
        subjectNonMember,
        'sub-list-nonmember@example.test',
        subjectWs2Owner,
        'sub-list-ws2owner@example.test',
      ],
    );

    for (const [userId, email, name] of [
      [subjectOwner, 'sub-list-owner@example.test', 'Sub List Owner'],
      [subjectViewer, 'sub-list-viewer@example.test', 'Sub List Viewer'],
      [
        subjectNonMember,
        'sub-list-nonmember@example.test',
        'Sub List NonMember',
      ],
      [subjectWs2Owner, 'sub-list-ws2owner@example.test', 'Sub List Ws2 Owner'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    // 2. Workspaces
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Sub List WS1', 'shared', 'USD', null, $2),
              ($3, 'Sub List WS2', 'shared', 'USD', null, $4)`,
      [workspace1Id, subjectOwner, workspace2Id, subjectWs2Owner],
    );

    // 3. Memberships
    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active'),
              ($4, $5, $6, 'viewer', 'active'),
              ($7, $8, $9, 'owner', 'active')`,
      [
        id(2071),
        workspace1Id,
        subjectOwner,
        id(2072),
        workspace1Id,
        subjectViewer,
        id(2073),
        workspace2Id,
        subjectWs2Owner,
      ],
    );

    // 4. Seed 12 items in workspace 1 with various statuses
    // 4 detected, 4 confirmed, 2 ignored, 2 cancelled
    const statuses = [
      'detected',
      'detected',
      'detected',
      'detected',
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
      'ignored',
      'ignored',
      'cancelled',
      'cancelled',
    ] as const;

    for (let i = 1; i <= TOTAL_ITEMS; i++) {
      const padded = String(i).padStart(2, '0');
      const itemStatus = statuses[i - 1]!;
      const hasPrev = i % 2 === 0;
      const prevAmount = hasPrev ? `${i * 100}` : null;
      const prevCurr = hasPrev ? 'USD' : null;

      await admin.query(
        `insert into public.subscriptions (
           id,
           workspace_id,
           payee_name,
           current_amount_minor,
           current_currency,
           previous_amount_minor,
           previous_currency,
           frequency,
           next_expected_at,
           status,
           created_by
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id(2100 + i),
          workspace1Id,
          `Payee ${padded}`,
          i * 150,
          'USD',
          prevAmount,
          prevCurr,
          'monthly',
          '2026-09-29T12:00:00Z',
          itemStatus,
          subjectOwner,
        ],
      );
    }

    // Force all 12 items in workspace 1 to share ONE explicit created_at timestamp
    // so that EVERY page boundary is a (created_at, id) tie and exercises the id tiebreaker
    await admin.query(
      `update public.subscriptions
          set created_at = '2026-08-29 12:00:00.000000+00'
        where workspace_id = $1`,
      [workspace1Id],
    );

    // Seed 1 item in workspace 2 for isolation testing
    await admin.query(
      `insert into public.subscriptions (
         id,
         workspace_id,
         payee_name,
         current_amount_minor,
         current_currency,
         previous_amount_minor,
         previous_currency,
         frequency,
         next_expected_at,
         status,
         created_by
       ) values ($1, $2, 'WS2 Payee', 999, 'USD', null, null, 'monthly', null, 'detected', $3)`,
      [id(2199), workspace2Id, subjectWs2Owner],
    );
  });

  afterAll(async () => {
    if (admin) {
      await admin
        .query(
          'delete from public.subscriptions where workspace_id = any($1::uuid[])',
          [[workspace1Id, workspace2Id]],
        )
        .catch(() => {});
      await admin
        .query('delete from public.workspaces where id = any($1::uuid[])', [
          [workspace1Id, workspace2Id],
        ])
        .catch(() => {});
      await admin
        .query('delete from public.profiles where id = any($1::uuid[])', [
          [subjectOwner, subjectViewer, subjectNonMember, subjectWs2Owner],
        ])
        .catch(() => {});
      await admin
        .query('delete from auth.users where id = any($1::uuid[])', [
          [subjectOwner, subjectViewer, subjectNonMember, subjectWs2Owner],
        ])
        .catch(() => {});
      await admin.end();
    }
    if (pool) {
      await pool.end();
    }
  });

  describe('Cross-workspace isolation & Authorization', () => {
    it('isolates subscriptions by workspace: workspace 1 never returns workspace 2 items', async () => {
      const outcome = await service.listSubscriptions(
        subjectOwner,
        createSubscriptionListQuery({
          workspaceId: workspace1Id,
          limitParam: '50',
        }),
      );

      expect(outcome.kind).toBe(SUBSCRIPTION_LIST_OUTCOMES.OK);
      const page = (outcome as SubscriptionListOk).page;
      expect(page.items).toHaveLength(TOTAL_ITEMS);
      expect(page.items.map((r) => r.id)).not.toContain(id(2199));
    });

    it('isolates subscriptions by workspace: workspace 2 only returns its own items', async () => {
      const outcome = await service.listSubscriptions(
        subjectWs2Owner,
        createSubscriptionListQuery({
          workspaceId: workspace2Id,
          limitParam: '50',
        }),
      );

      expect(outcome.kind).toBe(SUBSCRIPTION_LIST_OUTCOMES.OK);
      const page = (outcome as SubscriptionListOk).page;
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.id).toBe(id(2199));
      expect(page.items[0]!.payeeName).toBe('WS2 Payee');
    });

    it('answers FORBIDDEN when a non-member attempts to list subscriptions', async () => {
      const outcome = await service.listSubscriptions(
        subjectNonMember,
        createSubscriptionListQuery({
          workspaceId: workspace1Id,
        }),
      );

      expect(outcome.kind).toBe(SUBSCRIPTION_LIST_OUTCOMES.FORBIDDEN);
    });

    it('permits a viewer to list subscriptions', async () => {
      const outcome = await service.listSubscriptions(
        subjectViewer,
        createSubscriptionListQuery({
          workspaceId: workspace1Id,
        }),
      );

      expect(outcome.kind).toBe(SUBSCRIPTION_LIST_OUTCOMES.OK);
      const page = (outcome as SubscriptionListOk).page;
      expect(page.items).toHaveLength(TOTAL_ITEMS);
    });
  });

  describe('Status filter validation and execution (RULING 61)', () => {
    it('returns ONLY matching rows when status filter is provided', async () => {
      for (const status of [
        'detected',
        'confirmed',
        'ignored',
        'cancelled',
      ] as const) {
        const outcome = await service.listSubscriptions(
          subjectOwner,
          createSubscriptionListQuery({
            workspaceId: workspace1Id,
            statusParam: status,
          }),
        );

        expect(outcome.kind).toBe(SUBSCRIPTION_LIST_OUTCOMES.OK);
        const page = (outcome as SubscriptionListOk).page;
        expect(page.items.length).toBeGreaterThan(0);
        for (const item of page.items) {
          expect(item.status).toBe(status);
        }
      }
    });

    it('returns ALL statuses when status filter is OMITTED', async () => {
      const outcome = await service.listSubscriptions(
        subjectOwner,
        createSubscriptionListQuery({
          workspaceId: workspace1Id,
          limitParam: '50',
        }),
      );

      expect(outcome.kind).toBe(SUBSCRIPTION_LIST_OUTCOMES.OK);
      const page = (outcome as SubscriptionListOk).page;
      expect(page.items).toHaveLength(TOTAL_ITEMS);

      const returnedStatuses = new Set(page.items.map((i) => i.status));
      expect(returnedStatuses).toEqual(
        new Set(['detected', 'confirmed', 'ignored', 'cancelled']),
      );
    });
  });

  describe('Keyset pagination, created_at tiebreaker, and bound cursor security', () => {
    it('traverses all 12 items across 3-item pages with zero omissions and zero duplicates despite identical created_at timestamps', async () => {
      const PAGE_SIZE = 3;
      const seenIds: string[] = [];
      let currentCursor: string | undefined = undefined;
      let pageCount = 0;

      while (true) {
        pageCount++;
        const query = createSubscriptionListQuery({
          workspaceId: workspace1Id,
          limitParam: String(PAGE_SIZE),
          cursorParam: currentCursor,
        });

        const outcome = await service.listSubscriptions(subjectOwner, query);
        expect(outcome.kind).toBe(SUBSCRIPTION_LIST_OUTCOMES.OK);
        const page = (outcome as SubscriptionListOk).page;

        for (const item of page.items) {
          expect(seenIds).not.toContain(item.id);
          seenIds.push(item.id);
        }

        if (!page.pageInfo.hasNextPage) {
          expect(page.pageInfo.nextCursor).toBeNull();
          break;
        }

        expect(page.pageInfo.nextCursor).not.toBeNull();
        currentCursor = page.pageInfo.nextCursor!;

        // Cursor must decode into matching workspace and valid ISO timestamp with null filter
        const decoded = decodeCursor(currentCursor, workspace1Id, null);
        expect(decoded).toBeDefined();
        expect(decoded?.workspaceId).toBe(workspace1Id);
        expect(decoded?.createdAt).toBe('2026-08-29T12:00:00.000000Z');
        expect(decoded?.filter).toBeNull();
      }

      expect(pageCount).toBe(4); // 12 / 3 = 4 pages
      expect(seenIds).toHaveLength(TOTAL_ITEMS);
    });

    it('traverses filtered status items across multiple pages returning exactly the filtered set once', async () => {
      const PAGE_SIZE = 2;
      const seenIds: string[] = [];
      let currentCursor: string | undefined = undefined;
      let pageCount = 0;

      while (true) {
        pageCount++;
        const query = createSubscriptionListQuery({
          workspaceId: workspace1Id,
          limitParam: String(PAGE_SIZE),
          cursorParam: currentCursor,
          statusParam: 'detected',
        });

        const outcome = await service.listSubscriptions(subjectOwner, query);
        expect(outcome.kind).toBe(SUBSCRIPTION_LIST_OUTCOMES.OK);
        const page = (outcome as SubscriptionListOk).page;

        for (const item of page.items) {
          expect(item.status).toBe('detected');
          expect(seenIds).not.toContain(item.id);
          seenIds.push(item.id);
        }

        if (!page.pageInfo.hasNextPage) {
          expect(page.pageInfo.nextCursor).toBeNull();
          break;
        }

        expect(page.pageInfo.nextCursor).not.toBeNull();
        currentCursor = page.pageInfo.nextCursor!;

        const decoded = decodeCursor(currentCursor, workspace1Id, 'detected');
        expect(decoded).toBeDefined();
        expect(decoded?.workspaceId).toBe(workspace1Id);
        expect(decoded?.filter).toBe('detected');
      }

      expect(pageCount).toBe(2); // 4 detected / 2 = 2 pages
      expect(seenIds).toHaveLength(4);
    });

    it('rejects a cursor bound to status=detected when replayed under status=confirmed', async () => {
      const page1Query = createSubscriptionListQuery({
        workspaceId: workspace1Id,
        limitParam: '2',
        statusParam: 'detected',
      });
      const page1Outcome = await service.listSubscriptions(
        subjectOwner,
        page1Query,
      );
      expect(page1Outcome.kind).toBe(SUBSCRIPTION_LIST_OUTCOMES.OK);
      const page1Cursor = (page1Outcome as SubscriptionListOk).page.pageInfo
        .nextCursor!;
      expect(page1Cursor).not.toBeNull();

      expect(() =>
        createSubscriptionListQuery({
          workspaceId: workspace1Id,
          cursorParam: page1Cursor,
          statusParam: 'confirmed',
        }),
      ).toThrow(SubscriptionQueryValidationError);
    });

    it('rejects a cursor bound to status=detected when replayed under no filter', async () => {
      const page1Query = createSubscriptionListQuery({
        workspaceId: workspace1Id,
        limitParam: '2',
        statusParam: 'detected',
      });
      const page1Outcome = await service.listSubscriptions(
        subjectOwner,
        page1Query,
      );
      expect(page1Outcome.kind).toBe(SUBSCRIPTION_LIST_OUTCOMES.OK);
      const page1Cursor = (page1Outcome as SubscriptionListOk).page.pageInfo
        .nextCursor!;
      expect(page1Cursor).not.toBeNull();

      expect(() =>
        createSubscriptionListQuery({
          workspaceId: workspace1Id,
          cursorParam: page1Cursor,
        }),
      ).toThrow(SubscriptionQueryValidationError);
    });

    it('rejects a no-filter (null) cursor when replayed under a status filter', async () => {
      const page1Query = createSubscriptionListQuery({
        workspaceId: workspace1Id,
        limitParam: '3',
      });
      const page1Outcome = await service.listSubscriptions(
        subjectOwner,
        page1Query,
      );
      expect(page1Outcome.kind).toBe(SUBSCRIPTION_LIST_OUTCOMES.OK);
      const page1Cursor = (page1Outcome as SubscriptionListOk).page.pageInfo
        .nextCursor!;
      expect(page1Cursor).not.toBeNull();

      expect(() =>
        createSubscriptionListQuery({
          workspaceId: workspace1Id,
          cursorParam: page1Cursor,
          statusParam: 'detected',
        }),
      ).toThrow(SubscriptionQueryValidationError);
    });

    it('rejects a cursor minted in workspace 1 when replayed against workspace 2', () => {
      const ws1Cursor: Cursor = {
        workspaceId: workspace1Id,
        createdAt: '2026-08-29T12:00:00.000000Z',
        id: id(2101),
        filter: null,
      };
      const rawCursor = encodeCursor(ws1Cursor);

      expect(() =>
        createSubscriptionListQuery({
          workspaceId: workspace2Id,
          cursorParam: rawCursor,
        }),
      ).toThrow(SubscriptionQueryValidationError);
    });

    it('rejects limit values outside allowable bounds (0, negative, non-numeric, > 200)', () => {
      for (const invalidLimit of ['0', '-1', '-10', 'abc', '201', '1000']) {
        expect(() =>
          createSubscriptionListQuery({
            workspaceId: workspace1Id,
            limitParam: invalidLimit,
          }),
        ).toThrow(SubscriptionQueryValidationError);
      }
    });
  });
});
