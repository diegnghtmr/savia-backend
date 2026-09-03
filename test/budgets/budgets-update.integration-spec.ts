// Migrations under test: 202609020001_budgets.sql, 202609020004_budgets_update.sql
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUDGETS_PORT,
  type BudgetStore,
  type BudgetsPort,
} from '../../src/budgets/budget.port.js';
import { BudgetService } from '../../src/budgets/budget.service.js';
import { PostgresBudgetAdapter } from '../../src/budgets/postgres-budget.adapter.js';
import { PostgresIdempotencyAdapter } from '../../src/platform/postgres-idempotency.adapter.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { fixture, IDS, command } from './budget-fixtures.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

describe('budget update against disposable PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let app: NestFastifyApplication;
  let sequence = 6800;
  const nextKey = () =>
    `00000000-0000-0000-0000-${String(sequence++).padStart(12, '0')}`;
  const create = async (name = 'Budget') => {
    const result = await f.service.createBudget(
      IDS.user,
      IDS.workspace,
      command(name),
      nextKey(),
    );
    if (result.kind !== 'created')
      throw new Error(`seed failed: ${result.kind}`);
    return result.budget;
  };
  const headers = (key = nextKey(), token = 'owner-token') => ({
    authorization: `Bearer ${token}`,
    'x-workspace-id': IDS.workspace,
    'idempotency-key': key,
    'content-type': 'application/json',
  });
  const update = (
    id: string,
    body: unknown,
    extra: Record<string, string> = {},
  ) =>
    app.inject({
      method: 'PATCH',
      url: `/v1/budgets/${id}`,
      headers: { ...headers(), ...extra },
      payload: JSON.stringify(body),
    });

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
    });
    f = await fixture(url);
    const moduleRef = await Test.createTestingModule({
      imports: [
        (await import('../../src/budgets/budgets.module.js')).BudgetsModule,
      ],
    })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: async (token: string) => {
          if (token === 'owner-token') return { subject: IDS.user };
          if (token === 'other-token') return { subject: IDS.otherUser };
          throw new Error('token rejected');
        },
      })
      .overrideProvider(BUDGETS_PORT)
      .useValue(f.service satisfies BudgetsPort)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await f.cleanup();
    await f.close();
  });

  it('1 updates name with a matching If-Match and returns the full budget', async () => {
    const budget = await create();
    const response = await update(
      budget.id,
      { name: 'Renamed' },
      { 'if-match': '"1"' },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: budget.id,
      name: 'Renamed',
      allocations: [],
    });
  });

  it('2 updates method with a matching If-Match', async () => {
    const budget = await create();
    const response = await update(
      budget.id,
      { method: 'zero_based' },
      { 'if-match': '"1"' },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().method).toBe('zero_based');
  });

  it('3 updates name and method together', async () => {
    const budget = await create();
    const response = await update(
      budget.id,
      { name: 'Together', method: 'hybrid' },
      { 'if-match': '"1"' },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: 'Together',
      method: 'hybrid',
    });
  });

  it('4 increments version exactly once and 5 advances updated_at', async () => {
    const budget = await create();
    const before = (
      await f.admin.query('select updated_at from public.budgets where id=$1', [
        budget.id,
      ])
    ).rows[0].updated_at as Date;
    const response = await update(
      budget.id,
      { name: 'Versioned' },
      { 'if-match': '"1"' },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().version).toBe(2);
    const row = (
      await f.admin.query(
        'select version,updated_at from public.budgets where id=$1',
        [budget.id],
      )
    ).rows[0];
    expect(row.version).toBe(2);
    expect(new Date(row.updated_at).getTime()).toBeGreaterThan(
      before.getTime(),
    );
  });

  it('6 rejects a stale If-Match without changing the row', async () => {
    const budget = await create('Stable');
    const response = await update(
      budget.id,
      { name: 'Must Not Apply' },
      { 'if-match': '"99"' },
    );
    expect(response.statusCode).toBe(412);
    const row = (
      await f.admin.query(
        'select name,method,version from public.budgets where id=$1',
        [budget.id],
      )
    ).rows[0];
    expect(row).toEqual({ name: 'Stable', method: 'envelope', version: 1 });
  });

  it.each(['W/"1"', '"01"', '1', ''])(
    '7 rejects malformed If-Match %j',
    async (ifMatch) => {
      const budget = await create();
      const response = await update(
        budget.id,
        { name: 'Invalid' },
        { 'if-match': ifMatch },
      );
      expect(response.statusCode).toBe(400);
    },
  );

  it('8 accepts If-Match star for an existing budget', async () => {
    const response = await update(
      (await create()).id,
      { name: 'Star' },
      { 'if-match': '*' },
    );
    expect(response.statusCode).toBe(200);
  });

  it('9 accepts a matching version list and rejects a non-matching list', async () => {
    const matching = await create();
    expect(
      (
        await update(
          matching.id,
          { name: 'List match' },
          { 'if-match': '"2", "1"' },
        )
      ).statusCode,
    ).toBe(200);
    const nonMatching = await create();
    expect(
      (
        await update(
          nonMatching.id,
          { name: 'List miss' },
          { 'if-match': '"2", "3"' },
        )
      ).statusCode,
    ).toBe(412);
  });

  it('10 updates unconditionally when If-Match is absent and increments version', async () => {
    const budget = await create();
    const response = await update(budget.id, { name: 'Unconditional' });
    expect(response.statusCode).toBe(200);
    expect(response.json().version).toBe(2);
  });

  it('11 hides a real foreign budget as 404 even with its correct If-Match', async () => {
    const foreign = await f.service.createBudget(
      IDS.otherUser,
      IDS.otherWorkspace,
      command('Foreign'),
      nextKey(),
    );
    if (foreign.kind !== 'created') throw new Error('foreign seed failed');
    const response = await update(
      foreign.budget.id,
      { name: 'Hidden' },
      { 'if-match': '"1"' },
    );
    expect(response.statusCode).toBe(404);
  });

  it('12 returns 404 for an unknown budget', async () => {
    const response = await update(
      '00000000-0000-0000-0000-000000009999',
      { name: 'Missing' },
      { 'if-match': '"1"' },
    );
    expect(response.statusCode).toBe(404);
  });

  it('13 rejects an empty body with 422', async () => {
    expect((await update((await create()).id, {})).statusCode).toBe(422);
  });

  it('14 rejects unknown properties with 422', async () => {
    expect(
      (await update((await create()).id, { unknown: true })).statusCode,
    ).toBe(422);
  });

  it('15 rejects immutable fields and leaves period and currency unchanged', async () => {
    const budget = await create();
    for (const body of [
      { periodStart: '2027-01-01' },
      { periodEnd: '2027-02-01' },
      { currency: 'EUR' },
    ]) {
      expect((await update(budget.id, body)).statusCode).toBe(422);
    }
    const row = (
      await f.admin.query(
        "select to_char(period_start,'YYYY-MM-DD') period_start,to_char(period_end,'YYYY-MM-DD') period_end,currency from public.budgets where id=$1",
        [budget.id],
      )
    ).rows[0];
    expect(row).toEqual({
      period_start: '2026-01-01',
      period_end: '2026-02-01',
      currency: 'USD',
    });
  });

  it('16 enforces name boundaries at 0, 1, 120, and 121 characters', async () => {
    const budget = await create();
    expect((await update(budget.id, { name: '' })).statusCode).toBe(422);
    expect(
      (await update(budget.id, { name: 'a'.repeat(121) })).statusCode,
    ).toBe(422);
    expect((await update(budget.id, { name: 'a' })).statusCode).toBe(200);
    expect(
      (
        await update(
          budget.id,
          { name: 'b'.repeat(120) },
          { 'if-match': '"2"' },
        )
      ).statusCode,
    ).toBe(200);
  });

  it('17 rejects a method outside the enum', async () => {
    expect(
      (await update((await create()).id, { method: 'invalid' })).statusCode,
    ).toBe(422);
  });

  it('18 replays the stored response without incrementing twice', async () => {
    const budget = await create();
    const key = nextKey();
    const first = await app.inject({
      method: 'PATCH',
      url: `/v1/budgets/${budget.id}`,
      headers: { ...headers(key), 'if-match': '"1"' },
      payload: JSON.stringify({ name: 'Replay' }),
    });
    const second = await app.inject({
      method: 'PATCH',
      url: `/v1/budgets/${budget.id}`,
      headers: { ...headers(key), 'if-match': '"1"' },
      payload: JSON.stringify({ name: 'Replay' }),
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(
      (
        await f.admin.query('select version from public.budgets where id=$1', [
          budget.id,
        ])
      ).rows[0].version,
    ).toBe(2);
  });

  it('19 rejects the same idempotency key with a different body', async () => {
    const budget = await create();
    const key = nextKey();
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/budgets/${budget.id}`,
          headers: { ...headers(key), 'if-match': '"1"' },
          payload: JSON.stringify({ name: 'First' }),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/budgets/${budget.id}`,
          headers: { ...headers(key), 'if-match': '"1"' },
          payload: JSON.stringify({ name: 'Second' }),
        })
      ).statusCode,
    ).toBe(409);
  });

  it('25 rejects the same idempotency key with a different If-Match', async () => {
    const budget = await create();
    const key = nextKey();
    const first = await app.inject({
      method: 'PATCH',
      url: `/v1/budgets/${budget.id}`,
      headers: { ...headers(key), 'if-match': '"1"' },
      payload: JSON.stringify({ name: 'Stored' }),
    });
    const second = await app.inject({
      method: 'PATCH',
      url: `/v1/budgets/${budget.id}`,
      headers: { ...headers(key), 'if-match': '"999"' },
      payload: JSON.stringify({ name: 'Stored' }),
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
  });

  it('26 replays the same If-Match response and increments only once', async () => {
    const budget = await create();
    const key = nextKey();
    const first = await app.inject({
      method: 'PATCH',
      url: `/v1/budgets/${budget.id}`,
      headers: { ...headers(key), 'if-match': '"1"' },
      payload: JSON.stringify({ name: 'Stored' }),
    });
    const second = await app.inject({
      method: 'PATCH',
      url: `/v1/budgets/${budget.id}`,
      headers: { ...headers(key), 'if-match': '"1"' },
      payload: JSON.stringify({ name: 'Stored' }),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(
      (
        await f.admin.query('select version from public.budgets where id=$1', [
          budget.id,
        ])
      ).rows[0].version,
    ).toBe(2);
  });

  it('27 replays the original response after an unrelated update', async () => {
    const budget = await create();
    const key = nextKey();
    const first = await app.inject({
      method: 'PATCH',
      url: `/v1/budgets/${budget.id}`,
      headers: { ...headers(key), 'if-match': '"1"' },
      payload: JSON.stringify({ name: 'Stored' }),
    });
    const intervening = await update(budget.id, { name: 'Current' });
    expect(intervening.statusCode).toBe(200);
    expect(intervening.json()).toMatchObject({ name: 'Current', version: 3 });
    const beforeReplay = (
      await f.admin.query(
        'select name,version from public.budgets where id=$1',
        [budget.id],
      )
    ).rows[0];
    expect(beforeReplay).toEqual({ name: 'Current', version: 3 });
    const replay = await app.inject({
      method: 'PATCH',
      url: `/v1/budgets/${budget.id}`,
      headers: { ...headers(key), 'if-match': '"1"' },
      payload: JSON.stringify({ name: 'Stored' }),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(replay.json().name).toBe('Stored');
    expect(replay.json().version).toBe(2);
    const afterReplay = (
      await f.admin.query(
        'select name,version from public.budgets where id=$1',
        [budget.id],
      )
    ).rows[0];
    expect(afterReplay).toEqual({ name: 'Current', version: 3 });
  });

  it('28 treats absent and star If-Match as different conditions', async () => {
    const budget = await create();
    const key = nextKey();
    const first = await app.inject({
      method: 'PATCH',
      url: `/v1/budgets/${budget.id}`,
      headers: headers(key),
      payload: JSON.stringify({ name: 'Absent' }),
    });
    const second = await app.inject({
      method: 'PATCH',
      url: `/v1/budgets/${budget.id}`,
      headers: { ...headers(key), 'if-match': '*' },
      payload: JSON.stringify({ name: 'Absent' }),
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
  });

  it('29 canonicalizes version-list order and duplicates', async () => {
    const budget = await create();
    const key = nextKey();
    const first = await app.inject({
      method: 'PATCH',
      url: `/v1/budgets/${budget.id}`,
      headers: { ...headers(key), 'if-match': '"1", "2"' },
      payload: JSON.stringify({ name: 'Canonical' }),
    });
    const second = await app.inject({
      method: 'PATCH',
      url: `/v1/budgets/${budget.id}`,
      headers: { ...headers(key), 'if-match': '"2", "1", "1"' },
      payload: JSON.stringify({ name: 'Canonical' }),
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(
      (
        await f.admin.query('select version from public.budgets where id=$1', [
          budget.id,
        ])
      ).rows[0].version,
    ).toBe(2);
  });

  it('20 allows exactly one of two concurrent matching If-Match updates', async () => {
    const budget = await create();
    const responses = await Promise.all([
      update(budget.id, { name: 'Concurrent A' }, { 'if-match': '"1"' }),
      update(budget.id, { name: 'Concurrent B' }, { 'if-match': '"1"' }),
    ]);
    expect(responses.map((x) => x.statusCode).sort()).toEqual([200, 412]);
    expect(
      (
        await f.admin.query('select version from public.budgets where id=$1', [
          budget.id,
        ])
      ).rows[0].version,
    ).toBe(2);
  });

  it('21 returns 401 without a token and 403 for an authenticated non-member', async () => {
    const budget = await create();
    const unauthenticated = await app.inject({
      method: 'PATCH',
      url: `/v1/budgets/${budget.id}`,
      headers: {
        'x-workspace-id': IDS.workspace,
        'idempotency-key': nextKey(),
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ name: 'No token' }),
    });
    const nonMember = await update(
      budget.id,
      { name: 'No access' },
      { authorization: 'Bearer other-token' },
    );
    expect(unauthenticated.statusCode).toBe(401);
    expect(nonMember.statusCode).toBe(403);
  });

  it('22 maps malformed JSON, missing/invalid workspace, and non-UUID budgetId to 400', async () => {
    const budget = await create();
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/budgets/${budget.id}`,
          headers: headers(),
          payload: '{',
        })
      ).statusCode,
    ).toBe(400);
    const noWorkspace = Object.fromEntries(
      Object.entries(headers()).filter(([key]) => key !== 'x-workspace-id'),
    );
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/budgets/${budget.id}`,
          headers: noWorkspace,
          payload: '{}',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/budgets/${budget.id}`,
          headers: { ...headers(), 'x-workspace-id': 'bad' },
          payload: '{}',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/v1/budgets/not-a-uuid',
          headers: headers(),
          payload: '{}',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('23 returns converted allocation actuals in the PATCH 200 response', async () => {
    const budget = await create();
    await f.admin.query(
      'insert into public.budget_allocations (workspace_id,budget_id,category_id,planned_minor) values ($1,$2,$3,30000)',
      [IDS.workspace, budget.id, IDS.statusCategory],
    );
    await f.insertExchangeRate({
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      rate: '1.1000',
      effectiveAt: '2026-01-01T00:00:00Z',
    });
    const account = await f.insertAccount({ currency: 'EUR' });
    await f.insertPosting({
      id: '00000000-0000-0000-0000-000000006751',
      transactionId: '00000000-0000-0000-0000-000000006752',
      amountMinor: 10000,
      currency: 'EUR',
      status: 'confirmed',
      occurredAt: '2026-01-15T12:00:00Z',
      categoryId: IDS.statusCategory,
      accountId: account,
    });
    const response = await update(
      budget.id,
      { name: 'Converted' },
      { 'if-match': '"1"' },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().allocations[0].actual).toEqual({
      amountMinor: '11000',
      currency: 'USD',
    });
  });

  it('24 rolls back the update when a failure is forced after the write', async () => {
    const budget = await create('Rollback');
    const store = new PostgresBudgetAdapter();
    const idempotency = new PostgresIdempotencyAdapter();
    const failingIdempotency = {
      read: idempotency.read.bind(idempotency),
      write: async () => {
        throw new Error('forced post-write failure');
      },
    };
    const service = new BudgetService(
      f.tx,
      store as BudgetStore,
      failingIdempotency,
    );
    await expect(
      service.updateBudget(
        IDS.user,
        IDS.workspace,
        budget.id,
        { name: 'Should Roll Back' },
        nextKey(),
        { kind: 'absent' },
      ),
    ).rejects.toThrow('forced post-write failure');
    const row = (
      await f.admin.query(
        'select name,version from public.budgets where id=$1',
        [budget.id],
      )
    ).rows[0];
    expect(row).toEqual({ name: 'Rollback', version: 1 });
  });
});
