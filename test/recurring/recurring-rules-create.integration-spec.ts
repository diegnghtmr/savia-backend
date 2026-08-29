// Migrations under test: 202608290003_recurring_rules.sql
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  RECURRING_CREATE_OUTCOMES,
  type CreateRecurringRuleCommand,
  type RecurringCreateCreated,
  type RecurringCreateReplayed,
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

describe('RecurringService createRecurringRule database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: RecurringService;

  const subjectOwner = subject(1861);
  const subjectAdmin = subject(1862);
  const subjectEditor = subject(1863);
  const subjectViewer = subject(1864);
  const subjectNonMember = subject(1865);
  const subjectWs2Owner = subject(1866);

  const workspace1Id = id(1881);
  const workspace2Id = id(1882);

  const ws1AccountId = id(1891);
  const ws2AccountId = id(1892);

  const ws1CategoryId = id(1893);
  const ws2CategoryId = id(1894);

  const ws1PayeeId = id(1895);
  const ws2PayeeId = id(1896);

  const ws1TagId = id(1897);
  const ws2TagId = id(1898);

  const validCommand: CreateRecurringRuleCommand = {
    name: 'Internet Fiber',
    frequency: 'monthly',
    rrule: null,
    behavior: 'create_draft',
    template: {
      type: 'expense',
      accountId: ws1AccountId,
      amount: {
        amountMinor: '6000',
        currency: 'USD',
      },
      occurredAt: '2026-08-29T12:00:00.000Z',
      status: 'draft',
      categoryId: ws1CategoryId,
      payeeId: ws1PayeeId,
      description: 'Fiber subscription',
      notes: null,
      tagIds: [ws1TagId],
      receiptId: null,
    },
    startsAt: '2026-08-29T12:00:00.000Z',
    endsAt: null,
    nextOccurrenceAt: '2026-09-29T12:00:00.000Z',
    anchorDayOfMonth: 29,
  };

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
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12)`,
      [
        subjectOwner,
        'rec-int-owner@example.test',
        subjectAdmin,
        'rec-int-admin@example.test',
        subjectEditor,
        'rec-int-editor@example.test',
        subjectViewer,
        'rec-int-viewer@example.test',
        subjectNonMember,
        'rec-int-nonmember@example.test',
        subjectWs2Owner,
        'rec-int-ws2owner@example.test',
      ],
    );

    for (const [userId, email, name] of [
      [subjectOwner, 'rec-int-owner@example.test', 'Rec Int Owner'],
      [subjectAdmin, 'rec-int-admin@example.test', 'Rec Int Admin'],
      [subjectEditor, 'rec-int-editor@example.test', 'Rec Int Editor'],
      [subjectViewer, 'rec-int-viewer@example.test', 'Rec Int Viewer'],
      [subjectNonMember, 'rec-int-nonmember@example.test', 'Rec Int NonMember'],
      [subjectWs2Owner, 'rec-int-ws2owner@example.test', 'Rec Int Ws2 Owner'],
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
       values ($1, 'Rec Int WS1', 'shared', 'USD', null, $2),
              ($3, 'Rec Int WS2', 'shared', 'USD', null, $4)`,
      [workspace1Id, subjectOwner, workspace2Id, subjectWs2Owner],
    );

    // 3. Memberships
    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active'),
              ($4, $5, $6, 'administrator', 'active'),
              ($7, $8, $9, 'editor', 'active'),
              ($10, $11, $12, 'viewer', 'active'),
              ($13, $14, $15, 'owner', 'active')`,
      [
        id(1871),
        workspace1Id,
        subjectOwner,
        id(1872),
        workspace1Id,
        subjectAdmin,
        id(1873),
        workspace1Id,
        subjectEditor,
        id(1874),
        workspace1Id,
        subjectViewer,
        id(1875),
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

    // 5. Catalogs (categories, payees, tags)
    await admin.query(
      `insert into public.categories (id, workspace_id, name, kind, created_by)
       values ($1, $2, 'WS1 Utilities', 'expense', $3),
              ($4, $5, 'WS2 Utilities', 'expense', $6)`,
      [
        ws1CategoryId,
        workspace1Id,
        subjectOwner,
        ws2CategoryId,
        workspace2Id,
        subjectWs2Owner,
      ],
    );

    await admin.query(
      `insert into public.payees (id, workspace_id, name, created_by)
       values ($1, $2, 'WS1 Telecom', $3),
              ($4, $5, 'WS2 Telecom', $6)`,
      [
        ws1PayeeId,
        workspace1Id,
        subjectOwner,
        ws2PayeeId,
        workspace2Id,
        subjectWs2Owner,
      ],
    );

    await admin.query(
      `insert into public.tags (id, workspace_id, name, created_by)
       values ($1, $2, 'bills', $3),
              ($4, $5, 'bills', $6)`,
      [
        ws1TagId,
        workspace1Id,
        subjectOwner,
        ws2TagId,
        workspace2Id,
        subjectWs2Owner,
      ],
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
        .query('delete from public.tags where workspace_id = any($1::uuid[])', [
          [workspace1Id, workspace2Id],
        ])
        .catch(() => {});
      await admin
        .query(
          'delete from public.payees where workspace_id = any($1::uuid[])',
          [[workspace1Id, workspace2Id]],
        )
        .catch(() => {});
      await admin
        .query(
          'delete from public.categories where workspace_id = any($1::uuid[])',
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
          [
            subjectOwner,
            subjectAdmin,
            subjectEditor,
            subjectViewer,
            subjectNonMember,
            subjectWs2Owner,
          ],
        ])
        .catch(() => {});
      await admin
        .query('delete from auth.users where id = any($1::uuid[])', [
          [
            subjectOwner,
            subjectAdmin,
            subjectEditor,
            subjectViewer,
            subjectNonMember,
            subjectWs2Owner,
          ],
        ])
        .catch(() => {});
      await admin.end();
    }
    if (pool) {
      await pool.end();
    }
  });

  describe('Authorization and RLS boundaries', () => {
    it('allows owner, administrator, and editor to create recurring rules', async () => {
      const resOwner = await service.createRecurringRule(
        subjectOwner,
        workspace1Id,
        { ...validCommand, name: 'Owner Rule' },
        'a0000000-0000-0000-0000-000000000001',
      );
      expect(resOwner.kind).toBe(RECURRING_CREATE_OUTCOMES.CREATED);

      const resAdmin = await service.createRecurringRule(
        subjectAdmin,
        workspace1Id,
        { ...validCommand, name: 'Admin Rule' },
        'a0000000-0000-0000-0000-000000000002',
      );
      expect(resAdmin.kind).toBe(RECURRING_CREATE_OUTCOMES.CREATED);

      const resEditor = await service.createRecurringRule(
        subjectEditor,
        workspace1Id,
        { ...validCommand, name: 'Editor Rule' },
        'a0000000-0000-0000-0000-000000000003',
      );
      expect(resEditor.kind).toBe(RECURRING_CREATE_OUTCOMES.CREATED);
    });

    it('rejects viewer and non-member with forbidden', async () => {
      const resViewer = await service.createRecurringRule(
        subjectViewer,
        workspace1Id,
        validCommand,
        'a0000000-0000-0000-0000-000000000004',
      );
      expect(resViewer.kind).toBe(RECURRING_CREATE_OUTCOMES.FORBIDDEN);

      const resNonMember = await service.createRecurringRule(
        subjectNonMember,
        workspace1Id,
        validCommand,
        'a0000000-0000-0000-0000-000000000005',
      );
      expect(resNonMember.kind).toBe(RECURRING_CREATE_OUTCOMES.FORBIDDEN);
    });
  });

  describe('RULING 53: Cross-workspace containment validation', () => {
    it('refuses cross-workspace account via composite FK (account_not_found)', async () => {
      const res = await service.createRecurringRule(
        subjectOwner,
        workspace1Id,
        {
          ...validCommand,
          template: {
            ...validCommand.template,
            accountId: ws2AccountId, // account belongs to workspace 2!
          },
        },
        'a0000000-0000-0000-0000-000000000006',
      );
      expect(res.kind).toBe(RECURRING_CREATE_OUTCOMES.ACCOUNT_NOT_FOUND);
    });

    it('refuses cross-workspace category (category_not_found)', async () => {
      const res = await service.createRecurringRule(
        subjectOwner,
        workspace1Id,
        {
          ...validCommand,
          template: {
            ...validCommand.template,
            categoryId: ws2CategoryId, // category belongs to workspace 2!
          },
        },
        'a0000000-0000-0000-0000-000000000007',
      );
      expect(res.kind).toBe(RECURRING_CREATE_OUTCOMES.CATEGORY_NOT_FOUND);
    });

    it('refuses cross-workspace payee (payee_not_found)', async () => {
      const res = await service.createRecurringRule(
        subjectOwner,
        workspace1Id,
        {
          ...validCommand,
          template: {
            ...validCommand.template,
            payeeId: ws2PayeeId, // payee belongs to workspace 2!
          },
        },
        'a0000000-0000-0000-0000-000000000008',
      );
      expect(res.kind).toBe(RECURRING_CREATE_OUTCOMES.PAYEE_NOT_FOUND);
    });

    it('refuses cross-workspace tag (tag_not_found)', async () => {
      const res = await service.createRecurringRule(
        subjectOwner,
        workspace1Id,
        {
          ...validCommand,
          template: {
            ...validCommand.template,
            tagIds: [ws2TagId], // tag belongs to workspace 2!
          },
        },
        'a0000000-0000-0000-0000-000000000009',
      );
      expect(res.kind).toBe(RECURRING_CREATE_OUTCOMES.TAG_NOT_FOUND);
    });
  });

  describe('Idempotency handling', () => {
    it('replays identical response for identical request and key and does not persist duplicate row', async () => {
      const key = 'a0000000-0000-0000-0000-000000000010';
      const first = (await service.createRecurringRule(
        subjectOwner,
        workspace1Id,
        validCommand,
        key,
      )) as RecurringCreateCreated;
      expect(first.kind).toBe(RECURRING_CREATE_OUTCOMES.CREATED);

      const countBefore = await admin.query<{ count: number }>(
        'select count(*)::int as count from public.recurring_rules where workspace_id = $1',
        [workspace1Id],
      );

      const second = (await service.createRecurringRule(
        subjectOwner,
        workspace1Id,
        validCommand,
        key,
      )) as RecurringCreateReplayed;
      expect(second.kind).toBe(RECURRING_CREATE_OUTCOMES.REPLAYED);
      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.rule);

      const countAfter = await admin.query<{ count: number }>(
        'select count(*)::int as count from public.recurring_rules where workspace_id = $1',
        [workspace1Id],
      );
      expect(countAfter.rows[0].count).toBe(countBefore.rows[0].count);
    });

    it('conflicts when idempotency key is reused with different payload and does not persist rule', async () => {
      const key = 'a0000000-0000-0000-0000-000000000011';
      const first = await service.createRecurringRule(
        subjectOwner,
        workspace1Id,
        validCommand,
        key,
      );
      expect(first.kind).toBe(RECURRING_CREATE_OUTCOMES.CREATED);

      const countBefore = await admin.query<{ count: number }>(
        'select count(*)::int as count from public.recurring_rules where workspace_id = $1',
        [workspace1Id],
      );

      const second = await service.createRecurringRule(
        subjectOwner,
        workspace1Id,
        { ...validCommand, name: 'Different Name' },
        key,
      );
      expect(second.kind).toBe(RECURRING_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT);

      const countAfter = await admin.query<{ count: number }>(
        'select count(*)::int as count from public.recurring_rules where workspace_id = $1',
        [workspace1Id],
      );
      expect(countAfter.rows[0].count).toBe(countBefore.rows[0].count);
    });
  });
});
