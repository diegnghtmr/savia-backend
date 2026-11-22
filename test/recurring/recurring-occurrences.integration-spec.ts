// Migrations under test: 202609170012_recurring_occurrence_actions.sql, 202609170021_recurring_occurrence_edits.sql
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
import {
  RecurringMaterializer,
  type DueOccurrence,
} from '../../src/recurring/recurring-materializer.js';

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
const headers = (actor: string = owner) => ({
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

  function materialize(rule: Rule, asOf = rule.nextOccurrenceAt) {
    return transaction.run(owner, (client) =>
      materializer.materialize(client, {
        workspaceId: workspace,
        ruleId: rule.id,
        subject: owner,
        scheduledAt: rule.nextOccurrenceAt,
        asOf,
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

  function change(
    rule: Rule,
    action: 'reschedule' | 'edit-one' | 'edit-series',
    payload: object,
    options: {
      item?: Occurrence;
      match?: string;
      key?: string;
      actor?: string;
    } = {},
  ) {
    const itemPath = `${occurrencePath(rule.id)}/${options.item?.id}`;
    const url =
      action === 'edit-series'
        ? `${root}/${rule.id}/edit-series`
        : action === 'edit-one'
          ? itemPath
          : `${itemPath}/reschedule`;
    const match = options.match ?? options.item?.etag;
    return app.inject({
      method: action === 'edit-one' ? 'PATCH' : 'POST',
      url,
      headers: {
        ...headers(options.actor),
        'idempotency-key': options.key ?? randomUUID(),
        ...(match ? { 'if-match': match } : {}),
      },
      payload,
    });
  }

  const plusHours = (date: string, hours: number) =>
    new Date(Date.parse(date) + hours * 3_600_000).toISOString();

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

  it('discovers and delivers a moved occurrence independently of its original cursor', async () => {
    const rule = await createRule('remind');
    const item = (await list(rule.id)).items[0]!;
    const store = new PostgresOccurrenceAdapter();
    const discovered = (cutoff: string) =>
      transaction.runAsQueueConsumer(async (client) => {
        const candidates = await store.findDue(client, cutoff);
        return candidates.filter(({ ruleId }) => ruleId === rule.id);
      });
    const deliver = (work: DueOccurrence) =>
      transaction.run(owner, (client) =>
        materializer.materialize(client, work),
      );
    const [original] = await discovered(item.originalScheduledAt);
    expect(original?.scheduleVersion).toBeUndefined();
    expect(original).toBeDefined();
    const scheduledAt = plusHours(item.scheduledAt, 2);
    const moved = await change(rule, 'reschedule', { scheduledAt }, { item });
    expect(moved.statusCode, moved.payload).toBe(200);
    expect(await deliver(original!)).toBeNull();
    expect(await discovered(item.originalScheduledAt)).toEqual([]);
    const [current] = await discovered(scheduledAt);
    expect(current).toMatchObject({
      scheduledAt: original!.scheduledAt,
      scheduleVersion: expect.any(Number),
    });
    const results = await Promise.all([deliver(current!), deliver(current!)]);
    expect(results).toContain(item.id);
    expect(results).toContain(null);
    expect(await discovered(scheduledAt)).toEqual([]);
    expect((await list(rule.id)).items[0]).toMatchObject({
      ...item,
      scheduledAt,
      status: 'reminder',
      etag: expect.any(String),
    });
  });

  it('reschedules a prospective slot once, keeping its original ID and the daily cadence', async () => {
    const rule = await createRule('remind');
    const before = await list(rule.id);
    const item = before.items[0]!;
    const scheduledAt = plusHours(item.scheduledAt, 26);
    const key = randomUUID();
    const move = (time: string, actor = owner, idempotencyKey = key) =>
      change(
        rule,
        'reschedule',
        { scheduledAt: time },
        { item, key: idempotencyKey, actor },
      );
    problem(await move(scheduledAt, editor), 403, 'Workspace access forbidden');
    problem(
      await move(plusHours(item.scheduledAt, 48)),
      409,
      'Recurring occurrence state conflict',
    );
    expect(await list(rule.id)).toEqual(before);
    const moved = await move(scheduledAt);
    expect(moved.statusCode, moved.payload).toBe(200);
    expect(moved.json()).toEqual({
      ...item,
      scheduledAt,
      etag: moved.headers.etag,
    });
    expect(moved.headers.etag).not.toBe(item.etag);
    expect((await move(scheduledAt)).json()).toEqual(moved.json());
    expect((await move(plusHours(scheduledAt, 1))).statusCode).toBe(409);
    expect(
      (await move(plusHours(scheduledAt, 1), owner, randomUUID())).statusCode,
    ).toBe(412);
    expect(await materialize(rule)).toBeNull();
    const next = {
      ...rule,
      nextOccurrenceAt: plusHours(item.originalScheduledAt, 24),
    };
    expect(await materialize(next)).not.toBeNull();
    expect(await materialize(rule, scheduledAt)).toBe(item.id);
    expect(await materialize(rule, scheduledAt)).toBeNull();
    const page = await list(rule.id);
    expect(page.items.find(({ id }) => id === item.id)).toEqual({
      ...moved.json<Occurrence>(),
      status: 'reminder',
      etag: expect.any(String),
    });
    expect(
      page.items.filter(
        ({ originalScheduledAt }) =>
          originalScheduledAt === item.originalScheduledAt,
      ),
    ).toHaveLength(1);
    expect(
      page.items.find(({ status }) => status === 'scheduled')?.scheduledAt,
    ).toBe(plusHours(item.originalScheduledAt, 48));
  });

  it.each(['create_draft', 'create_pending'])(
    'rejects editing a linked %s booking but reschedules it in place',
    async (behavior) => {
      const rule = await createRule(behavior);
      await materialize(rule);
      const before = await list(rule.id);
      const item = before.items[0]!;
      const booking = () =>
        app.inject({
          method: 'GET',
          url: `/v1/transactions/${item.transactionId}`,
          headers: headers(),
        });
      const originalBooking = (await booking()).json<{ occurredAt: string }>();
      problem(
        await change(rule, 'edit-one', { description: 'Booked' }, { item }),
        409,
        'Recurring occurrence state conflict',
      );
      expect(await list(rule.id)).toEqual(before);
      expect((await booking()).json()).toEqual(originalBooking);
      const scheduledAt = plusHours(item.scheduledAt, 2);
      const previousBalance = await balance(originalBooking.occurredAt);
      const effectiveBalance = await balance(scheduledAt);
      const moved = await change(rule, 'reschedule', { scheduledAt }, { item });
      expect(moved.statusCode, moved.payload).toBe(200);
      expect(moved.json()).toEqual({
        ...item,
        scheduledAt,
        etag: moved.headers.etag,
      });
      expect((await booking()).json()).toMatchObject({
        id: item.transactionId,
        occurredAt: scheduledAt,
        status: item.status,
        amount,
      });
      expect(await balance(scheduledAt)).toBe(effectiveBalance);
      const confirmed = await command(moved.json<Occurrence>(), 'confirm');
      expect(confirmed.statusCode, confirmed.payload).toBe(200);
      expect(await balance(originalBooking.occurredAt)).toBe(previousBalance);
      expect(await balance(scheduledAt)).toBe(
        effectiveBalance + BigInt(amount.amountMinor),
      );
      const newItem = confirmed.json<Occurrence>();
      problem(
        await change(
          rule,
          'reschedule',
          { scheduledAt: plusHours(scheduledAt, 1) },
          { item: newItem },
        ),
        409,
        'Recurring occurrence state conflict',
      );
    },
  );

  it('preserves slots before the series boundary', async () => {
    const rule = await createRule('create_pending');
    const before = await list(rule.id);
    const effectiveFrom = plusHours(rule.nextOccurrenceAt, 24);
    const changes = { description: 'Starts tomorrow' };
    const result = await change(
      rule,
      'edit-series',
      { effectiveFrom, changes },
      { match: before.ruleEtag },
    );
    expect(result.statusCode, result.payload).toBe(200);
    expect(result.json()).toEqual({ ruleId: rule.id, effectiveFrom, changes });
    expect((await list(rule.id)).items).toEqual(before.items);
    await materialize(rule);
    const next = { ...rule, nextOccurrenceAt: effectiveFrom };
    await materialize(next);
    const after = await list(rule.id);
    expect(after.items[0]).toMatchObject({
      status: 'pending',
      description: before.items[0]?.description,
    });
    expect(after.items[1]).toMatchObject({
      status: 'pending',
      originalScheduledAt: effectiveFrom,
      ...changes,
    });
  });

  it('edits the series inclusively by original slot, preserving reminders and one-slot overrides', async () => {
    const rule = await createRule('remind');
    await materialize(rule);
    const before = await list(rule.id);
    const [reminder, scheduled] = before.items as [Occurrence, Occurrence];
    const editedReminder = await change(
      rule,
      'edit-one',
      { description: null },
      { item: reminder },
    );
    expect(editedReminder.statusCode, editedReminder.payload).toBe(200);
    expect(editedReminder.json()).toEqual({
      ...reminder,
      description: null,
      etag: editedReminder.headers.etag,
    });
    const edited = await change(
      rule,
      'edit-one',
      { description: 'Only this one' },
      { item: scheduled },
    );
    expect(edited.statusCode, edited.payload).toBe(200);
    expect(edited.json()).toEqual({
      ...scheduled,
      description: 'Only this one',
      etag: edited.headers.etag,
    });
    const key = randomUUID();
    const changes = {
      amount: { ...amount, amountMinor: '4200' },
      description: 'New series',
    };
    const invalid = await change(rule, 'edit-series', {
      effectiveFrom: '2000-01-01T00:00:00.000Z',
      changes,
    });
    expect(invalid.statusCode, invalid.payload).toBe(422);
    const payload = { effectiveFrom: scheduled.originalScheduledAt, changes };
    const series = await change(rule, 'edit-series', payload, {
      key,
      match: before.ruleEtag,
    });
    expect(series.statusCode, series.payload).toBe(200);
    expect(series.json()).toEqual({ ruleId: rule.id, ...payload });
    expect(series.headers.etag).not.toBe(before.ruleEtag);
    expect(
      (
        await change(rule, 'edit-series', payload, {
          key,
          match: before.ruleEtag,
        })
      ).json(),
    ).toEqual(series.json());
    expect(
      (await change(rule, 'edit-series', payload, { match: before.ruleEtag }))
        .statusCode,
    ).toBe(412);
    await materialize({
      ...rule,
      nextOccurrenceAt: scheduled.originalScheduledAt,
    });
    const after = await list(rule.id);
    expect(after.ruleEtag).toBe(series.headers.etag);
    expect(after.items[0]).toEqual(editedReminder.json());
    expect(after.items[1]).toMatchObject({
      id: scheduled.id,
      status: 'reminder',
      description: 'Only this one',
      amount: changes.amount,
    });
    expect(after.items[2]).toMatchObject({ status: 'scheduled', ...changes });
  });

  // Reviewer regressions (verify mwr708uy); migration 202609170024_recurring_series_rls.sql.
  it.each(['confirm', 'reschedule'] as const)(
    'can %s a linked booking after PATCH transitions it from draft to pending',
    async (action) => {
      const rule = await createRule('create_draft');
      await materialize(rule);
      const draft = (await list(rule.id)).items[0]!;
      const patched = await app.inject({
        method: 'PATCH',
        url: `/v1/transactions/${draft.transactionId}`,
        headers: { ...headers(), 'idempotency-key': randomUUID() },
        payload: { status: 'pending' },
      });
      expect(patched.statusCode, patched.payload).toBe(200);
      const pending = (await list(rule.id)).items[0]!;
      expect(pending.status).toBe('pending');
      const scheduledAt = plusHours(pending.scheduledAt, 2);
      const snapshot = async () =>
        (
          await db.query(
            `select md5(to_jsonb(t)::text || coalesce((select jsonb_agg(to_jsonb(p) order by p.id)::text
              from public.ledger_postings p where p.transaction_id = t.id), '[]')) as state
              from public.transactions t where t.id = $1`,
            [draft.transactionId],
          )
        ).rows[0].state;
      const before = await snapshot();
      const result =
        action === 'confirm'
          ? await command(pending, 'confirm')
          : await change(
              rule,
              'reschedule',
              { scheduledAt },
              { item: pending },
            );
      if (result.statusCode !== 200) {
        expect(await snapshot()).toBe(before);
        expect((await list(rule.id)).items[0]).toEqual(pending);
      }
      expect(result.statusCode, result.payload).toBe(200);
      const current = result.json<Occurrence>();
      expect(current.transactionId).toBe(draft.transactionId);
      expect(current.status).toBe(
        action === 'confirm' ? 'confirmed' : 'pending',
      );
      const postings = await db.query(
        `select status, occurred_at from public.ledger_postings where transaction_id = $1`,
        [draft.transactionId],
      );
      expect(postings.rows).toEqual(
        Array.from({ length: 2 }, () => ({
          status: current.status,
          occurred_at: new Date(current.scheduledAt),
        })),
      );
    },
  );

  it('does not leave a balance contribution behind when skipping a PATCH-demoted booking', async () => {
    const rule = await createRule('confirm_automatically');
    const initial = await balance(rule.nextOccurrenceAt);
    await materialize(rule);
    const booked = (await list(rule.id)).items[0]!;
    expect(await balance(booked.scheduledAt)).toBe(
      initial + BigInt(amount.amountMinor),
    );
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/transactions/${booked.transactionId}`,
      headers: { ...headers(), 'idempotency-key': randomUUID() },
      payload: { status: 'pending' },
    });
    expect(patched.statusCode, patched.payload).toBe(200);
    const pending = (await list(rule.id)).items[0]!;
    expect(pending.status).toBe('pending');
    const skipped = await command(pending, 'skip');
    expect(skipped.statusCode, skipped.payload).toBe(200);
    expect(skipped.json()).toMatchObject({
      status: 'skipped',
      transactionId: booked.transactionId,
    });
    expect(await balance(booked.scheduledAt)).toBe(initial);
  });

  it('enforces creator-only series edits under the application RLS role', async () => {
    const rule = await createRule('remind');
    const before = (await list(rule.id)).ruleEtag;
    const result = await transaction
      .run(editor, (client) =>
        client.query(
          `update public.recurring_rules set version = version + 1,
            series_changes = series_changes || $2::jsonb where id = $1`,
          [
            rule.id,
            JSON.stringify([
              {
                effectiveFrom: rule.nextOccurrenceAt,
                changes: { description: 'Denied' },
              },
            ]),
          ],
        ),
      )
      .catch((error: { code?: string }) => {
        if (error.code === '42501') return { rowCount: 0 };
        throw error;
      });
    expect(result.rowCount).toBe(0);
    expect((await list(rule.id)).ruleEtag).toBe(before);
  });

  it('races a materializer delivery, reschedule and skip on the same slot', async () => {
    const rule = await createRule('confirm_automatically');
    const item = (await list(rule.id)).items[0]!;
    const dest = plusHours(item.scheduledAt, 3);
    const [worker, moved, skipped] = await Promise.all([
      materialize(rule),
      change(rule, 'reschedule', { scheduledAt: dest }, { item }),
      command(item, 'skip'),
    ]);
    expect(
      Number(worker !== null) +
        Number(moved.statusCode === 200) +
        Number(skipped.statusCode === 200),
    ).toBe(1);
    for (const res of [moved, skipped]) {
      if (res.statusCode !== 200)
        problem(res, 412, 'Recurring occurrence version mismatch');
    }
    const checked = (await list(rule.id)).items.find(
      ({ id }) => id === item.id,
    )!;
    if (moved.statusCode === 200) {
      expect(checked.scheduledAt).toBe(dest);
      expect(await materialize(rule, dest)).toBe(item.id);
    }
    expect(await materialize(rule, dest)).toBeNull();
    const stored = await db.query(
      `select transaction_id from public.recurring_occurrences where rule_id = $1 and scheduled_at = $2`,
      [rule.id, item.originalScheduledAt],
    );
    expect(stored.rowCount).toBe(1);
    const transactionId = stored.rows[0].transaction_id;
    if (skipped.statusCode === 200) expect(transactionId).toBeNull();
    else {
      expect(transactionId).toEqual(expect.any(String));
      const { rows } = await db.query(
        `select status, occurred_at from public.ledger_postings where transaction_id = $1`,
        [transactionId],
      );
      expect(rows).toEqual(
        Array.from({ length: 2 }, () => ({
          status: 'confirmed',
          occurred_at: new Date(
            moved.statusCode === 200 ? dest : item.scheduledAt,
          ),
        })),
      );
    }
  });

  it('retains the original and compensating postings when skipping pending', async () => {
    const rule = await createRule('create_pending');
    await materialize(rule);
    const item = (await list(rule.id)).items[0]!;
    const postings = async () =>
      (
        await db.query(
          `select id, leg_kind, amount_minor, status, occurred_at from public.ledger_postings where transaction_id = $1 order by id`,
          [item.transactionId],
        )
      ).rows;
    const initial = await postings();
    expect(initial).toHaveLength(2);
    const before = await balance(item.scheduledAt);
    const result = await command(item, 'skip');
    expect(result.statusCode, result.payload).toBe(200);
    expect(result.json()).toMatchObject({
      status: 'skipped',
      transactionId: item.transactionId,
    });
    const all = await postings();
    expect(all).toHaveLength(4);
    expect(
      all.filter((row) => initial.some(({ id }) => row.id === id)),
    ).toEqual(initial);
    for (const row of initial) {
      expect(
        all.find(
          (extra) => extra.id !== row.id && extra.leg_kind === row.leg_kind,
        ),
      ).toMatchObject({
        status: row.status,
        amount_minor: String(-BigInt(row.amount_minor)),
      });
    }
    expect(await balance(item.scheduledAt)).toBe(before);
  });

  // Reviewer regressions (verify mwra06vh, PASS WITH FINDINGS).
  it('offsets PATCH-demoted bookings at the exact original posting cutoff', async () => {
    const rule = await createRule('confirm_automatically');
    const beforeSlot = new Date(
      Date.parse(rule.nextOccurrenceAt) - 1,
    ).toISOString();
    const patchedDate = plusHours(rule.nextOccurrenceAt, 2);
    const cutoffs = [beforeSlot, rule.nextOccurrenceAt, patchedDate];
    const balances = () => Promise.all(cutoffs.map(balance));
    const baseline = await balances();
    await materialize(rule);
    const booked = (await list(rule.id)).items[0]!;
    const postings = async () =>
      (
        await db.query<{
          entry: Record<string, unknown> & { id: string; status: string };
          terms: Record<string, unknown> & { amount_minor: string };
        }>(
          `select to_jsonb(p) as entry,
                  (to_jsonb(p) - 'id' - 'created_at') ||
                    jsonb_build_object('amount_minor', p.amount_minor::text) as terms
             from public.ledger_postings p where transaction_id = $1 order by id`,
          [booked.transactionId],
        )
      ).rows;
    const originals = await postings();
    expect(originals).toHaveLength(2);
    expect(originals.map(({ entry }) => entry.status)).toEqual([
      'confirmed',
      'confirmed',
    ]);
    expect(await balances()).toEqual(
      baseline.map((value, index) =>
        index === 0 ? value : value + BigInt(amount.amountMinor),
      ),
    );
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/transactions/${booked.transactionId}`,
      headers: { ...headers(), 'idempotency-key': randomUUID() },
      payload: { occurredAt: patchedDate, status: 'pending' },
    });
    expect(patch.statusCode, patch.payload).toBe(200);
    expect(patch.json()).toMatchObject({
      occurredAt: patchedDate,
      status: 'pending',
    });
    const pending = (await list(rule.id)).items[0]!;
    const skipped = await command(pending, 'skip');
    expect(skipped.statusCode, skipped.payload).toBe(200);
    expect(skipped.json()).toMatchObject({
      status: 'skipped',
      transactionId: booked.transactionId,
    });
    const history = await postings();
    expect(history).toHaveLength(4);
    const ids = new Set(originals.map(({ entry }) => entry.id));
    expect(history.filter(({ entry }) => ids.has(entry.id))).toEqual(originals);
    expect(
      history
        .filter(({ entry }) => !ids.has(entry.id))
        .map(({ terms }) => terms),
    ).toEqual(
      expect.arrayContaining(
        originals.map(({ terms }) => ({
          ...terms,
          amount_minor: String(-BigInt(terms.amount_minor)),
        })),
      ),
    );
    expect(await balances()).toEqual(baseline);
  });

  it('distinguishes a forbidden creator lock from a missing rule', async () => {
    const rule = await createRule('remind');
    const item = (await list(rule.id)).items[0]!;
    const payload = {
      effectiveFrom: item.originalScheduledAt,
      changes: { description: 'Updated' },
    };
    problem(
      await change(rule, 'edit-series', payload, { actor: editor }),
      403,
      'Workspace access forbidden',
    );
    problem(
      await change({ ...rule, id: randomUUID() }, 'edit-series', payload, {
        actor: editor,
      }),
      404,
      'Recurring resource not found',
    );
    problem(
      await command(item, 'skip', randomUUID(), editor),
      403,
      'Workspace access forbidden',
    );
    problem(
      await command(
        { ...item, ruleId: randomUUID() },
        'skip',
        randomUUID(),
        editor,
      ),
      404,
      'Recurring resource not found',
    );
    problem(
      await command({ ...item, id: randomUUID() }, 'skip'),
      404,
      'Recurring resource not found',
    );
    expect((await list(rule.id)).items[0]).toEqual(item);
  });

  it('lets an editor creator advance and edit their own rule, but not after demotion', async () => {
    const created = await app.inject({
      method: 'POST',
      url: root,
      headers: { ...headers(editor), 'idempotency-key': randomUUID() },
      payload: {
        name: 'Editor recurrence',
        frequency: 'daily',
        behavior: 'remind',
        startsAt: start,
        template: {
          type: 'expense',
          accountId: account,
          amount,
          occurredAt: start,
        },
      },
    });
    expect(created.statusCode, created.payload).toBe(201);
    const rule = created.json<Rule>();
    const initial = await list(rule.id);
    const item = initial.items[0]!;
    const delivery = (scheduledAt: string) =>
      transaction.run(editor, (client) =>
        materializer.materialize(client, {
          workspaceId: workspace,
          ruleId: rule.id,
          subject: editor,
          scheduledAt,
          asOf: scheduledAt,
        }),
      );
    const next = plusHours(item.originalScheduledAt, 24);
    const payload = {
      effectiveFrom: next,
      changes: { description: 'Editor-created change' },
    };
    problem(
      await change(rule, 'edit-series', payload),
      403,
      'Workspace access forbidden',
    );
    const allowed = await change(rule, 'edit-series', payload, {
      actor: editor,
      match: initial.ruleEtag,
    });
    expect(allowed.statusCode, allowed.payload).toBe(200);
    expect(await delivery(item.originalScheduledAt)).toBe(item.id);
    const advanced = await list(rule.id);
    expect(advanced.items[1]).toMatchObject({
      originalScheduledAt: next,
      status: 'scheduled',
      ...payload.changes,
    });
    const setRole = (role: 'viewer' | 'editor') =>
      db.query(
        `update public.workspace_memberships set role = $3 where workspace_id = $1 and profile_id = $2`,
        [workspace, editor, role],
      );
    try {
      await setRole('viewer');
      problem(
        await change(rule, 'edit-series', payload, { actor: editor }),
        403,
        'Workspace access forbidden',
      );
      expect(await delivery(next)).toBeNull();
      expect(await list(rule.id)).toEqual(advanced);
    } finally {
      await setRole('editor');
    }
  });

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
