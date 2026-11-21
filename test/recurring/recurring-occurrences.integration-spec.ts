// Migration under test: 202609170012_recurring_occurrence_actions.sql
import { randomUUID } from 'node:crypto';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { TransactionService } from '../../src/ledger/transaction.service.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresOccurrenceAdapter } from '../../src/recurring/postgres-occurrence.adapter.js';
import { RecurringMaterializer } from '../../src/recurring/recurring-materializer.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const owner = randomUUID();
const viewer = randomUUID();
const editor = randomUUID();
const stranger = randomUUID();
const workspace = randomUUID();
const account = randomUUID();
const amount = { amountMinor: '6500', currency: 'USD' };
const start = '2026-09-01T09:00:00.000Z';
const root = '/v1/recurring-rules';
const occurrencePath = (id: string) => `${root}/${id}/occurrences`;
const headers = (actor = owner) => ({
  authorization: `Bearer ${actor}`,
  'x-workspace-id': workspace,
});

interface Occurrence {
  readonly id: string;
  readonly ruleId: string;
  readonly originalScheduledAt: string;
  readonly scheduledAt: string;
  readonly status: string;
  readonly transactionId: string | null;
  readonly amount: typeof amount;
  readonly description: string | null;
  readonly categoryId: string | null;
  readonly etag: string;
}
interface Page {
  readonly items: Occurrence[];
  readonly ruleEtag: string;
  readonly pageInfo: { hasNextPage: boolean; nextCursor: string | null };
}
interface Rule {
  readonly id: string;
  readonly nextOccurrenceAt: string;
  readonly template: { description: string };
}

describe('Recurring occurrence actions through HTTP and PostgreSQL', () => {
  let db: Pool;
  let app: NestFastifyApplication;
  let transaction: PgTransaction;
  let materializer: RecurringMaterializer;

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
    });
    db = new Pool({ connectionString: url });
    const users = [
      [owner, 'owner'],
      [viewer, 'viewer'],
      [editor, 'editor'],
      [stranger, 'stranger'],
    ] as const;
    for (const [user, role] of users) {
      const email = `occurrence-${role}@example.test`;
      await db.query('insert into auth.users (id, email) values ($1, $2)', [
        user,
        email,
      ]);
      await db.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
        values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [user, email, role],
      );
    }
    await db.query(
      "insert into public.workspaces (id, name, kind, base_currency, created_by) values ($1, 'Recurrence workspace', 'shared', 'USD', $2)",
      [workspace, owner],
    );
    await db.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values
      ($1, $2, 'owner', 'active'), ($1, $3, 'viewer', 'active'), ($1, $4, 'editor', 'active')`,
      [workspace, owner, viewer, editor],
    );
    await db.query(
      "insert into public.accounts (id, workspace_id, name, type, currency, status, created_by) values ($1, $2, 'Checking', 'checking', 'USD', 'active', $3)",
      [account, workspace, owner],
    );

    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: (token: string) => Promise.resolve({ subject: token }),
      })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(app);
    await app.init();
    transaction = module.get(PgTransaction);
    materializer = new RecurringMaterializer(
      new PostgresOccurrenceAdapter(),
      module.get(TransactionService),
    );
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  async function createRule(behavior: string): Promise<Rule> {
    const result = await app.inject({
      method: 'POST',
      url: root,
      headers: { ...headers(), 'idempotency-key': randomUUID() },
      payload: {
        name: 'Recurring expense',
        frequency: 'daily',
        behavior,
        startsAt: start,
        template: {
          type: 'expense',
          accountId: account,
          amount,
          occurredAt: start,
          description: randomUUID(),
        },
      },
    });
    expect(result.statusCode, result.payload).toBe(201);
    return result.json<Rule>();
  }

  function materialize(rule: Rule) {
    return transaction.run(owner, (client) =>
      materializer.materialize(client, {
        workspaceId: workspace,
        ruleId: rule.id,
        subject: owner,
        scheduledAt: rule.nextOccurrenceAt,
        asOf: rule.nextOccurrenceAt,
      }),
    );
  }

  async function list(rule: string, query = '', actor = owner): Promise<Page> {
    const result = await app.inject({
      method: 'GET',
      url: `${occurrencePath(rule)}${query}`,
      headers: headers(actor),
    });
    expect(result.statusCode, result.payload).toBe(200);
    return result.json<Page>();
  }

  function command(
    item: Occurrence,
    action: string,
    key = randomUUID(),
    actor = owner,
    match = item.etag,
  ) {
    return app.inject({
      method: 'POST',
      url: `${occurrencePath(item.ruleId)}/${item.id}/${action}`,
      headers: {
        ...headers(actor),
        'idempotency-key': key,
        ...(match ? { 'if-match': match } : {}),
      },
    });
  }

  function problem(
    response: Awaited<ReturnType<typeof command>>,
    status: number,
    title: string,
  ) {
    expect(response.statusCode, response.payload).toBe(status);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.json()).toMatchObject({ status, title });
  }

  async function balance(asOf: string): Promise<bigint> {
    const result = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${account}/balance?asOf=${encodeURIComponent(asOf)}`,
      headers: headers(),
    });
    expect(result.statusCode, result.payload).toBe(200);
    const { nativeBalance } = result.json<{ nativeBalance: typeof amount }>();
    return BigInt(nativeBalance.amountMinor);
  }

  it('lists materialized and scheduled items, preserving the slot ID and paginating in schedule order', async () => {
    const rule = await createRule('remind');
    const initial = await list(rule.id, '?status=scheduled', viewer);
    const next = initial.items[0]!;
    expect(initial).toEqual({
      items: [
        {
          id: expect.any(String),
          ruleId: rule.id,
          originalScheduledAt: rule.nextOccurrenceAt,
          scheduledAt: rule.nextOccurrenceAt,
          status: 'scheduled',
          transactionId: null,
          amount,
          description: rule.template.description,
          categoryId: null,
          etag: expect.any(String),
        },
      ],
      pageInfo: { hasNextPage: false, nextCursor: null },
      ruleEtag: expect.any(String),
    });
    expect(await materialize(rule)).toBe(next.id);
    const first = await list(rule.id, '?limit=1', viewer);
    expect(first.items).toEqual([
      { ...next, status: 'reminder', etag: expect.any(String) },
    ]);
    expect(first.items[0]?.etag).not.toBe(next.etag);
    expect(first.pageInfo).toEqual({
      hasNextPage: true,
      nextCursor: expect.any(String),
    });
    const cursor = first.pageInfo.nextCursor;
    const second = await list(rule.id, `?limit=1&cursor=${cursor}`, viewer);
    expect(second.items).toEqual([
      expect.objectContaining({ status: 'scheduled' }),
    ]);
    expect(second.items[0]?.id).not.toBe(next.id);
    expect(second.pageInfo).toEqual({ hasNextPage: false, nextCursor: null });
    const reminders = await list(rule.id, '?status=reminder');
    expect(reminders.items).toEqual(first.items);
    const wrongFilter = await app.inject({
      method: 'GET',
      url: `${occurrencePath(rule.id)}?status=reminder&cursor=${cursor}`,
      headers: headers(),
    });
    problem(wrongFilter, 400, 'Invalid recurring occurrence query');
    const wrongRule = await app.inject({
      method: 'GET',
      url: occurrencePath(randomUUID()),
      headers: headers(),
    });
    problem(wrongRule, 404, 'Recurring resource not found');
    const invisible = await app.inject({
      method: 'GET',
      url: occurrencePath(rule.id),
      headers: headers(stranger),
    });
    problem(invisible, 403, 'Workspace access forbidden');
  });

  it.each(['remind', 'create_draft', 'create_pending'])(
    'confirms %s exactly once and replays the original response and ETag',
    async (behavior) => {
      const rule = await createRule(behavior);
      await materialize(rule);
      const before = (await list(rule.id)).items[0]!;
      // Rule creation chooses a future slot and the test delivers it ahead
      // of wall-clock time. The ledger still uses the slot as the posting date.
      const atSlot = before.scheduledAt;
      const beforeSlot = new Date(Date.parse(atSlot) - 1).toISOString();
      const initialBalance = await balance(atSlot);
      const earlierBalance = await balance(beforeSlot);
      const forbidden = await command(before, 'confirm', randomUUID(), editor);
      problem(forbidden, 403, 'Workspace access forbidden');
      const stale = await command(
        before,
        'confirm',
        randomUUID(),
        owner,
        '"0"',
      );
      problem(stale, 412, 'Recurring occurrence version mismatch');
      expect((await list(rule.id)).items[0]).toEqual(before);
      expect(await balance(atSlot)).toBe(initialBalance);
      const key = randomUUID();
      const confirmation = await command(before, 'confirm', key);
      expect(confirmation.statusCode, confirmation.payload).toBe(200);
      const confirmed = confirmation.json<Occurrence>();
      expect(confirmed).toEqual({
        ...before,
        status: 'confirmed',
        transactionId: before.transactionId ?? expect.any(String),
        etag: expect.any(String),
      });
      expect(confirmation.headers.etag).toBe(confirmed.etag);
      expect(confirmed.etag).not.toBe(before.etag);
      const replay = await command(before, 'confirm', key);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(confirmed);
      expect(replay.headers.etag).toBe(confirmed.etag);
      const misuse = await command(confirmed, 'confirm', key);
      problem(misuse, 409, 'Idempotency key reused with different payload');
      const booking = await app.inject({
        method: 'GET',
        url: `/v1/transactions/${confirmed.transactionId}`,
        headers: headers(),
      });
      expect(booking.statusCode, booking.payload).toBe(200);
      expect(booking.json()).toMatchObject({
        id: confirmed.transactionId,
        status: 'confirmed',
        amount,
        occurredAt: before.scheduledAt,
      });
      const freshSkip = await command(confirmed, 'skip');
      problem(freshSkip, 409, 'Recurring occurrence state conflict');
      expect((await list(rule.id)).items[0]).toEqual(confirmed);
      expect(await balance(beforeSlot)).toBe(earlierBalance);
      expect(await balance(atSlot)).toBe(
        initialBalance + BigInt(amount.amountMinor),
      );
    },
  );

  it('skips the next scheduled slot and rejects stale materializer work without producing a booking', async () => {
    const rule = await createRule('confirm_automatically');
    const scheduled = (await list(rule.id)).items[0]!;
    const initialBalance = await balance(scheduled.scheduledAt);
    const skip = await command(scheduled, 'skip');
    expect(skip.statusCode, skip.payload).toBe(200);
    const skipped = skip.json<Occurrence>();
    expect(skipped).toEqual({
      ...scheduled,
      status: 'skipped',
      etag: expect.any(String),
    });
    expect(skip.headers.etag).toBe(skipped.etag);
    expect(await materialize(rule)).toBeNull();
    const page = await list(rule.id);
    expect(page.items).toEqual([
      skipped,
      expect.objectContaining({ status: 'scheduled' }),
    ]);
    expect(page.items[1]?.scheduledAt).not.toBe(scheduled.scheduledAt);
    expect(await balance(scheduled.scheduledAt)).toBe(initialBalance);
  });

  it.each(['create_draft', 'create_pending'])(
    'voids the linked %s booking on skip and preserves its identity',
    async (behavior) => {
      const rule = await createRule(behavior);
      await materialize(rule);
      const before = (await list(rule.id)).items[0]!;
      const initialBalance = await balance(before.scheduledAt);
      if (behavior === 'create_draft') {
        const standalone = await app.inject({
          method: 'POST',
          url: `/v1/transactions/${before.transactionId}/void`,
          headers: { ...headers(), 'idempotency-key': randomUUID() },
          payload: { reason: 'Not an occurrence skip' },
        });
        problem(standalone, 409, 'Transaction is draft');
        expect((await list(rule.id)).items[0]).toEqual(before);
      }
      const skip = await command(before, 'skip');
      expect(skip.statusCode, skip.payload).toBe(200);
      expect(skip.json()).toEqual({
        ...before,
        status: 'skipped',
        etag: expect.any(String),
      });
      const booking = await app.inject({
        method: 'GET',
        url: `/v1/transactions/${before.transactionId}`,
        headers: headers(),
      });
      expect(booking.statusCode, booking.payload).toBe(200);
      expect(booking.json()).toMatchObject({
        id: before.transactionId,
        status: 'voided',
        amount,
      });
      expect(await balance(before.scheduledAt)).toBe(initialBalance);
    },
  );

  it('serializes confirm and skip of the same reminder so exactly one wins', async () => {
    const rule = await createRule('remind');
    await materialize(rule);
    const reminder = (await list(rule.id)).items[0]!;
    const results = await Promise.all([
      command(reminder, 'confirm', randomUUID(), owner, ''),
      command(reminder, 'skip', randomUUID(), owner, ''),
    ]);
    const codes = results.map((result) => result.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    const winner = results.find((result) => result.statusCode === 200)!;
    const loser = results.find((result) => result.statusCode === 409)!;
    problem(loser, 409, 'Recurring occurrence state conflict');
    expect((await list(rule.id)).items[0]).toEqual(winner.json());
  });
});
