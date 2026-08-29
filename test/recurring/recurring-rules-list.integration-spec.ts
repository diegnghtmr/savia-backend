// Migrations under test: 202608290003_recurring_rules.sql
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { decodeCursor, type Cursor } from '../../src/platform/cursor.js';
import {
  RECURRING_LIST_OUTCOMES,
  type CreateRecurringRuleCommand,
  type RecurringListOk,
} from '../../src/recurring/recurring.port.js';
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

describe('RecurringService listRecurringRules database boundary and cursor traversal', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: RecurringService;

  const subjectOwner = subject(1961);
  const subjectViewer = subject(1962);
  const subjectNonMember = subject(1963);
  const subjectWs2Owner = subject(1964);

  const workspace1Id = id(1981);
  const workspace2Id = id(1982);

  const ws1AccountId = id(1991);
  const ws2AccountId = id(1992);

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
        'rec-list-owner@example.test',
        subjectViewer,
        'rec-list-viewer@example.test',
        subjectNonMember,
        'rec-list-nonmember@example.test',
        subjectWs2Owner,
        'rec-list-ws2owner@example.test',
      ],
    );

    for (const [userId, email, name] of [
      [subjectOwner, 'rec-list-owner@example.test', 'Rec List Owner'],
      [subjectViewer, 'rec-list-viewer@example.test', 'Rec List Viewer'],
      [
        subjectNonMember,
        'rec-list-nonmember@example.test',
        'Rec List NonMember',
      ],
      [subjectWs2Owner, 'rec-list-ws2owner@example.test', 'Rec List Ws2 Owner'],
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
       values ($1, 'Rec List WS1', 'shared', 'USD', null, $2),
              ($3, 'Rec List WS2', 'shared', 'USD', null, $4)`,
      [workspace1Id, subjectOwner, workspace2Id, subjectWs2Owner],
    );

    // 3. Memberships
    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active'),
              ($4, $5, $6, 'viewer', 'active'),
              ($7, $8, $9, 'owner', 'active')`,
      [
        id(1971),
        workspace1Id,
        subjectOwner,
        id(1972),
        workspace1Id,
        subjectViewer,
        id(1973),
        workspace2Id,
        subjectWs2Owner,
      ],
    );

    // 4. Accounts
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, created_by)
       values ($1, $2, 'WS1 Account', 'checking', 'USD', 'active', $3),
              ($4, $5, 'WS2 Account', 'checking', 'USD', 'active', $6)`,
      [
        ws1AccountId,
        workspace1Id,
        subjectOwner,
        ws2AccountId,
        workspace2Id,
        subjectWs2Owner,
      ],
    );

    // 5. Seed items in workspace 1
    for (let i = 1; i <= TOTAL_ITEMS; i++) {
      const padded = String(i).padStart(2, '0');
      const cmd: CreateRecurringRuleCommand = {
        name: `Rule ${padded}`,
        frequency: 'monthly',
        rrule: null,
        behavior: 'create_draft',
        template: {
          type: 'expense',
          accountId: ws1AccountId,
          amount: { amountMinor: `${i}000`, currency: 'USD' },
          occurredAt: '2026-08-29T12:00:00.000Z',
          status: 'draft',
          categoryId: null,
          payeeId: null,
          description: `Description ${padded}`,
          notes: null,
          tagIds: [],
          receiptId: null,
        },
        startsAt: '2026-08-29T12:00:00.000Z',
        endsAt: null,
        nextOccurrenceAt: '2026-09-29T12:00:00.000Z',
        anchorDayOfMonth: 29,
      };

      await service.createRecurringRule(
        subjectOwner,
        workspace1Id,
        cmd,
        `b0000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      );
    }

    // Seed 1 item in workspace 2 for isolation testing
    await service.createRecurringRule(
      subjectWs2Owner,
      workspace2Id,
      {
        name: 'WS2 Rule',
        frequency: 'weekly',
        rrule: null,
        behavior: 'remind',
        template: {
          type: 'expense',
          accountId: ws2AccountId,
          amount: { amountMinor: '1000', currency: 'USD' },
          occurredAt: '2026-08-29T12:00:00.000Z',
          status: 'draft',
          categoryId: null,
          payeeId: null,
          description: null,
          notes: null,
          tagIds: [],
          receiptId: null,
        },
        startsAt: '2026-08-29T12:00:00.000Z',
        endsAt: null,
        nextOccurrenceAt: '2026-09-05T12:00:00.000Z',
        anchorDayOfMonth: 29,
      },
      'b0000000-0000-0000-0000-000000000099',
    );
  });

  afterAll(async () => {
    if (admin) {
      await admin
        .query(
          'delete from public.recurring_rules where workspace_id = any($1::uuid[])',
          [[workspace1Id, workspace2Id]],
        )
        .catch(() => {});
      await admin
        .query(
          'delete from public.idempotency_keys where workspace_id = any($1::uuid[])',
          [[workspace1Id, workspace2Id]],
        )
        .catch(() => {});
      await admin
        .query(
          'delete from public.accounts where workspace_id = any($1::uuid[])',
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

  it('allows active viewer to list recurring rules with full cursor pagination traversal', async () => {
    const pageSize = 4;
    let currentCursor: Cursor | undefined;
    const collectedIds: string[] = [];
    let pagesFetched = 0;

    while (true) {
      const outcome = (await service.listRecurringRules(subjectViewer, {
        workspaceId: workspace1Id,
        cursor: currentCursor,
        limit: pageSize,
      })) as RecurringListOk;

      expect(outcome.kind).toBe(RECURRING_LIST_OUTCOMES.OK);
      const { items, pageInfo } = outcome.page;

      for (const item of items) {
        collectedIds.push(item.id);
      }
      pagesFetched++;

      if (!pageInfo.hasNextPage) {
        expect(pageInfo.nextCursor).toBeNull();
        break;
      }

      expect(pageInfo.nextCursor).not.toBeNull();
      const decoded = decodeCursor(pageInfo.nextCursor!, workspace1Id);
      expect(decoded).toBeDefined();
      currentCursor = decoded;
    }

    expect(collectedIds).toHaveLength(TOTAL_ITEMS);
    expect(pagesFetched).toBe(Math.ceil(TOTAL_ITEMS / pageSize));

    // Ensure no duplicates
    const uniqueIds = new Set(collectedIds);
    expect(uniqueIds.size).toBe(TOTAL_ITEMS);
  });

  it('enforces workspace isolation: does not return rules from another workspace', async () => {
    const outcome = (await service.listRecurringRules(subjectOwner, {
      workspaceId: workspace1Id,
      limit: 50,
    })) as RecurringListOk;

    expect(outcome.kind).toBe(RECURRING_LIST_OUTCOMES.OK);
    expect(outcome.page.items).toHaveLength(TOTAL_ITEMS);
    expect(outcome.page.items.some((item) => item.name === 'WS2 Rule')).toBe(
      false,
    );
  });

  it('rejects outsider with forbidden', async () => {
    const outcome = await service.listRecurringRules(subjectNonMember, {
      workspaceId: workspace1Id,
      limit: 50,
    });

    expect(outcome.kind).toBe(RECURRING_LIST_OUTCOMES.FORBIDDEN);
  });
});
