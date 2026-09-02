// Migrations under test: 202609020001_budgets.sql
import { randomUUID } from 'node:crypto';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUDGETS_PORT,
  BUDGET_OUTCOMES,
  type BudgetsPort,
} from '../../src/budgets/budget.port.js';
import { MAX_BUDGET_ALLOCATION_COUNT } from '../../src/budgets/budget-limits.js';
import { BudgetsModule } from '../../src/budgets/budgets.module.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { fixture, IDS, command } from './budget-fixtures.js';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');
describe('budget creation against disposable PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let application: NestFastifyApplication | undefined;
  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
    });
    f = await fixture(url);
    const moduleRef = await Test.createTestingModule({
      imports: [BudgetsModule],
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
    application = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(application);
    await application.init();
    await application.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await application?.close();
    await f.cleanup();
    await f.close();
  });
  const create = (key: string, body = command()) =>
    f.service.createBudget(IDS.user, IDS.workspace, body, key);
  const baseHeaders = {
    authorization: 'Bearer owner-token',
    'x-workspace-id': IDS.workspace,
    'idempotency-key': '00000000-0000-0000-0000-000000006900',
    'content-type': 'application/json',
  };
  const inject = (options: Parameters<NestFastifyApplication['inject']>[0]) =>
    application!.inject(options);
  const unauthenticatedHeaders = (() => {
    return Object.fromEntries(
      Object.entries(baseHeaders).filter(([key]) => key !== 'authorization'),
    );
  })();
  it('1 snapshots workspace base currency', async () => {
    const o = await create('00000000-0000-0000-0000-000000006201');
    expect(o.kind).toBe(BUDGET_OUTCOMES.CREATED);
    if (o.kind === 'created') expect(o.budget.currency).toBe('USD');
  });
  it('2 keeps original currency after workspace change', async () => {
    const o = await f.service.createBudget(
      IDS.otherUser,
      IDS.otherWorkspace,
      command('Other currency'),
      '00000000-0000-0000-0000-000000006202',
    );
    if (o.kind !== 'created') throw new Error('create failed');
    await f.admin.query(
      `update public.workspaces set base_currency='USD' where id=$1`,
      [IDS.otherWorkspace],
    );
    const read = await f.service.getBudget(
      IDS.otherUser,
      IDS.otherWorkspace,
      o.budget.id,
    );
    expect(read.kind).toBe('found');
    if (read.kind === 'found') expect(read.budget.currency).toBe('EUR');
    await f.admin.query(
      `update public.workspaces set base_currency='EUR' where id=$1`,
      [IDS.otherWorkspace],
    );
  });
  it('3 returns version one and empty allocations', async () => {
    const o = await create('00000000-0000-0000-0000-000000006203');
    if (o.kind !== 'created') throw new Error('create failed');
    expect(o.budget.version).toBe(1);
    expect(o.budget.allocations).toEqual([]);
    const r = await f.admin.query(
      `select count(*)::int as count from public.budget_allocations where budget_id=$1`,
      [o.budget.id],
    );
    expect(r.rows[0].count).toBe(0);
  });
  it('4 rejects equal dates', async () => {
    const response = await inject({
      method: 'POST',
      url: '/v1/budgets',
      headers: {
        ...baseHeaders,
        'idempotency-key': '00000000-0000-0000-0000-000000006204',
      },
      payload: JSON.stringify(command('Equal', '2026-02-01', '2026-02-01')),
    });
    expect(response.statusCode).toBe(422);
  });
  it('5 rejects inverted dates', async () => {
    const response = await inject({
      method: 'POST',
      url: '/v1/budgets',
      headers: {
        ...baseHeaders,
        'idempotency-key': '00000000-0000-0000-0000-000000006205',
      },
      payload: JSON.stringify(command('Inverted', '2026-03-01', '2026-02-01')),
    });
    expect(response.statusCode).toBe(422);
  });
  it('6 rejects a 367-day period', async () => {
    const response = await inject({
      method: 'POST',
      url: '/v1/budgets',
      headers: {
        ...baseHeaders,
        'idempotency-key': '00000000-0000-0000-0000-000000006206',
      },
      payload: JSON.stringify(command('Long', '2026-01-01', '2027-01-03')),
    });
    expect(response.statusCode).toBe(422);
  });
  it('7 accepts exactly 366 days', async () => {
    const o = await create(
      '00000000-0000-0000-0000-000000006207',
      command('Boundary', '2026-01-01', '2027-01-02'),
    );
    expect(o.kind).toBe('created');
  });
  it('7b accepts the leap-day 366-day boundary over HTTP', async () => {
    const response = await inject({
      method: 'POST',
      url: '/v1/budgets',
      headers: {
        ...baseHeaders,
        'idempotency-key': '00000000-0000-0000-0000-000000006226',
      },
      payload: JSON.stringify(
        command('Leap boundary', '2028-02-29', '2029-03-01'),
      ),
    });
    expect(response.statusCode).toBe(201);
  });
  it('8 allows identical overlapping periods', async () => {
    expect(
      (
        await create(
          '00000000-0000-0000-0000-000000006208',
          command('Overlap A'),
        )
      ).kind,
    ).toBe('created');
    expect(
      (
        await create(
          '00000000-0000-0000-0000-000000006209',
          command('Overlap B'),
        )
      ).kind,
    ).toBe('created');
  });
  it('9 copies allocation plan rows', async () => {
    const source = await create('00000000-0000-0000-0000-000000006210');
    if (source.kind !== 'created') throw new Error('source failed');
    await f.admin.query(
      `insert into public.budget_allocations (workspace_id,budget_id,category_id,planned_minor,rollover_policy,rollover_target_id) values ($1,$2,$3,12345,'to_category',$4)`,
      [IDS.workspace, source.budget.id, IDS.category, IDS.category],
    );
    const copied = await create('00000000-0000-0000-0000-000000006211', {
      ...command('Copy'),
      copyFromBudgetId: source.budget.id,
    });
    if (copied.kind !== 'created') throw new Error('copy failed');
    const r = await f.admin.query(
      `select category_id::text,planned_minor::text,rollover_policy,rollover_target_id::text from public.budget_allocations where budget_id=$1`,
      [copied.budget.id],
    );
    expect(r.rows).toEqual([
      {
        category_id: IDS.category,
        planned_minor: '12345',
        rollover_policy: 'to_category',
        rollover_target_id: IDS.category,
      },
    ]);
  });
  it('10 copies no outcome values from the source period', async () => {
    const source = await create(
      '00000000-0000-0000-0000-000000006212',
      command('Source outcome', '2026-01-01', '2026-02-01'),
    );
    if (source.kind !== 'created') throw new Error('source failed');
    await f.admin.query(
      `insert into public.budget_allocations (workspace_id,budget_id,category_id,planned_minor,rollover_policy) values ($1,$2,$3,99,'none')`,
      [IDS.workspace, source.budget.id, IDS.category],
    );
    await f.insertPosting({
      id: '00000000-0000-0000-0000-000000006711',
      transactionId: '00000000-0000-0000-0000-000000006712',
      amountMinor: 17,
      currency: 'USD',
      status: 'confirmed',
      occurredAt: '2026-01-15T12:00:00Z',
    });
    const copied = await create('00000000-0000-0000-0000-000000006213', {
      ...command('Copy outcome', '2026-03-01', '2026-04-01'),
      copyFromBudgetId: source.budget.id,
    });
    if (copied.kind !== 'created') throw new Error('copy failed');
    await f.insertPosting({
      id: '00000000-0000-0000-0000-000000006713',
      transactionId: '00000000-0000-0000-0000-000000006714',
      amountMinor: 23,
      currency: 'USD',
      status: 'confirmed',
      occurredAt: '2026-03-15T12:00:00Z',
    });
    const read = await f.service.getBudget(
      IDS.user,
      IDS.workspace,
      copied.budget.id,
    );
    if (read.kind !== 'found') throw new Error('copy read failed');
    expect(read.budget.allocations[0]?.actual.amountMinor).toBe('23');
    expect(read.budget.allocations[0]?.available.amountMinor).toBe('76');
  });
  it('11 rejects an unknown source UUID with 422 outcome', async () => {
    const o = await create('00000000-0000-0000-0000-000000006214', {
      ...command('Unknown'),
      copyFromBudgetId: '00000000-0000-0000-0000-000000009999',
    });
    expect(o.kind).toBe('invalid-source');
  });
  it('12 rejects a source from another workspace', async () => {
    const other = await f.service.createBudget(
      IDS.otherUser,
      IDS.otherWorkspace,
      command('Foreign'),
      '00000000-0000-0000-0000-000000006215',
    );
    if (other.kind !== 'created') throw new Error('foreign create failed');
    const o = await create('00000000-0000-0000-0000-000000006216', {
      ...command('Foreign source'),
      copyFromBudgetId: other.budget.id,
    });
    expect(o.kind).toBe('invalid-source');
  });
  it('15 replays sequentially without adding a second row', async () => {
    const key = '00000000-0000-0000-0000-000000006217';
    const before = (
      await f.admin.query(
        `select count(*)::int as count from public.budgets where workspace_id=$1`,
        [IDS.workspace],
      )
    ).rows[0].count;
    const a = await create(key, command('Replay'));
    const b = await create(key, command('Replay'));
    expect(a.kind).toBe('created');
    expect(b.kind).toBe('replayed');
    const r = await f.admin.query(
      `select count(*)::int as count from public.budgets where workspace_id=$1`,
      [IDS.workspace],
    );
    expect(r.rows[0].count - before).toBe(1);
  });
  it('16 rejects same key with a different body', async () => {
    const key = '00000000-0000-0000-0000-000000006218';
    await create(key, command('First'));
    const o = await create(key, command('Second'));
    expect(o.kind).toBe('conflict');
  });
  it('22 ten concurrent same-key creates leave one row', async () => {
    const key = '00000000-0000-0000-0000-000000006219';
    const before = (
      await f.admin.query(
        `select count(*)::int as count from public.budgets where workspace_id=$1`,
        [IDS.workspace],
      )
    ).rows[0].count;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => create(key, command('Concurrent'))),
    );
    expect(results.filter((x) => x.kind === 'created')).toHaveLength(1);
    expect(results.filter((x) => x.kind === 'replayed')).toHaveLength(9);
    const after = (
      await f.admin.query(
        `select count(*)::int as count from public.budgets where workspace_id=$1`,
        [IDS.workspace],
      )
    ).rows[0].count;
    expect(after - before).toBe(1);
  });
  it('23 converts two foreign-currency postings and keeps get/list HTTP at 200', async () => {
    const budget = await create('00000000-0000-0000-0000-000000006220');
    if (budget.kind !== 'created') throw new Error('create failed');
    await f.admin.query(
      `insert into public.budget_allocations (workspace_id,budget_id,category_id,planned_minor) values ($1,$2,$3,30000)`,
      [IDS.workspace, budget.budget.id, IDS.statusCategory],
    );
    await f.insertExchangeRate({
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      rate: '1.0800',
      effectiveAt: '2026-01-01T00:00:00Z',
    });
    await f.insertExchangeRate({
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      rate: '1.1000',
      effectiveAt: '2026-03-01T00:00:00Z',
    });
    await f.insertExchangeRate({
      baseCurrency: 'GBP',
      quoteCurrency: 'USD',
      rate: '1.2500',
      effectiveAt: '2026-03-01T00:00:00Z',
    });
    const eurAccount = await f.insertAccount({ currency: 'EUR' });
    const gbpAccount = await f.insertAccount({ currency: 'GBP' });
    await f.insertPosting({
      id: '00000000-0000-0000-0000-000000006715',
      transactionId: '00000000-0000-0000-0000-000000006716',
      amountMinor: 10000,
      currency: 'EUR',
      status: 'confirmed',
      occurredAt: '2026-01-15T12:00:00Z',
      categoryId: IDS.statusCategory,
      accountId: eurAccount,
    });
    await f.insertPosting({
      id: '00000000-0000-0000-0000-000000006725',
      transactionId: '00000000-0000-0000-0000-000000006726',
      amountMinor: 5000,
      currency: 'GBP',
      status: 'reconciled',
      occurredAt: '2026-01-15T12:00:00Z',
      categoryId: IDS.statusCategory,
      accountId: gbpAccount,
    });
    await f.insertPosting({
      id: '00000000-0000-0000-0000-000000006719',
      transactionId: '00000000-0000-0000-0000-000000006720',
      amountMinor: 7000,
      currency: 'USD',
      status: 'confirmed',
      occurredAt: '2026-01-20T12:00:00Z',
      categoryId: IDS.statusCategory,
    });
    const read = await f.service.getBudget(
      IDS.user,
      IDS.workspace,
      budget.budget.id,
    );
    if (read.kind !== 'found') throw new Error('read failed');
    expect(read.budget.allocations[0]?.actual.amountMinor).toBe('24050');
    expect(read.budget.allocations[0]?.available.amountMinor).toBe('5950');
    const getResponse = await inject({
      method: 'GET',
      url: `/v1/budgets/${budget.budget.id}`,
      headers: baseHeaders,
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json().allocations[0].actual.amountMinor).toBe('24050');
    const listResponse = await inject({
      method: 'GET',
      url: '/v1/budgets?limit=100',
      headers: baseHeaders,
    });
    expect(listResponse.statusCode).toBe(200);
    expect(
      listResponse
        .json()
        .items.some((item: { id: string }) => item.id === budget.budget.id),
    ).toBe(true);
    await f.admin.query(
      `delete from public.ledger_postings where transaction_id = any($1::uuid[])`,
      [
        [
          '00000000-0000-0000-0000-000000006716',
          '00000000-0000-0000-0000-000000006726',
          '00000000-0000-0000-0000-000000006720',
        ],
      ],
    );
    await f.admin.query(
      `delete from public.transactions where id = any($1::uuid[])`,
      [
        [
          '00000000-0000-0000-0000-000000006716',
          '00000000-0000-0000-0000-000000006726',
          '00000000-0000-0000-0000-000000006720',
        ],
      ],
    );
    await f.admin.query(
      `delete from public.accounts where id = any($1::uuid[])`,
      [[eurAccount, gbpAccount]],
    );
  });
  it('pins per-posting half-away-from-zero conversion rounding granularity for positive half-units (N1)', async () => {
    // Decision: conversions round per-posting to integer minor units via half-away-from-zero
    // prior to summation into allocation actuals.
    // Two postings of 1 EUR @ 0.5000 USD: each rounds 0.5 -> 1 USD, resulting in sum = 2 USD.
    // (Per-allocation rounding would sum 0.5 + 0.5 = 1.0 -> 1 USD).
    const categoryId = randomUUID();
    await f.admin.query(
      `insert into public.categories (id,workspace_id,parent_id,name,kind,created_by) values ($1,$2,null,'Rounding Pos Cat','expense',$3)`,
      [categoryId, IDS.workspace, IDS.user],
    );
    const budget = await create('00000000-0000-0000-0000-000000006231');
    if (budget.kind !== 'created') throw new Error('create failed');
    await f.admin.query(
      `insert into public.budget_allocations (workspace_id,budget_id,category_id,planned_minor) values ($1,$2,$3,10000)`,
      [IDS.workspace, budget.budget.id, categoryId],
    );
    await f.insertExchangeRate({
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      rate: '0.5000',
      effectiveAt: '2026-01-10T00:00:00Z',
    });
    const eurAccount = await f.insertAccount({ currency: 'EUR' });
    const tx1 = '00000000-0000-0000-0000-000000006731';
    const tx2 = '00000000-0000-0000-0000-000000006732';
    try {
      await f.insertPosting({
        id: '00000000-0000-0000-0000-000000006733',
        transactionId: tx1,
        amountMinor: 1,
        currency: 'EUR',
        status: 'confirmed',
        occurredAt: '2026-01-15T12:00:00Z',
        categoryId,
        accountId: eurAccount,
      });
      await f.insertPosting({
        id: '00000000-0000-0000-0000-000000006734',
        transactionId: tx2,
        amountMinor: 1,
        currency: 'EUR',
        status: 'confirmed',
        occurredAt: '2026-01-16T12:00:00Z',
        categoryId,
        accountId: eurAccount,
      });
      const read = await f.service.getBudget(
        IDS.user,
        IDS.workspace,
        budget.budget.id,
      );
      if (read.kind !== 'found') throw new Error('read failed');
      expect(read.budget.allocations[0]?.actual.amountMinor).toBe('2');
      expect(read.budget.allocations[0]?.available.amountMinor).toBe('9998');
    } finally {
      await f.admin.query(
        `delete from public.ledger_postings where transaction_id = any($1::uuid[])`,
        [[tx1, tx2]],
      );
      await f.admin.query(
        `delete from public.transactions where id = any($1::uuid[])`,
        [[tx1, tx2]],
      );
      await f.admin.query(
        `delete from public.budget_allocations where budget_id = $1::uuid`,
        [budget.budget.id],
      );
      await f.admin.query(`delete from public.budgets where id = $1::uuid`, [
        budget.budget.id,
      ]);
      await f.admin.query(`delete from public.categories where id = $1::uuid`, [
        categoryId,
      ]);
      await f.admin.query(`delete from public.accounts where id = $1::uuid`, [
        eurAccount,
      ]);
      await f.admin.query(
        `delete from public.exchange_rates where workspace_id = $1::uuid and base_currency = 'EUR' and rate = '0.5000'`,
        [IDS.workspace],
      );
    }
  });
  it('pins per-posting half-away-from-zero conversion rounding granularity for negative half-units (N1)', async () => {
    // Symmetric rounding behavior: two negative postings of -1 EUR @ 0.5000 USD.
    // Each rounds -0.5 -> -1 USD, resulting in sum = -2 USD.
    // (Per-allocation rounding would sum -0.5 + -0.5 = -1.0 -> -1 USD).
    const categoryId = randomUUID();
    await f.admin.query(
      `insert into public.categories (id,workspace_id,parent_id,name,kind,created_by) values ($1,$2,null,'Rounding Neg Cat','expense',$3)`,
      [categoryId, IDS.workspace, IDS.user],
    );
    const budget = await create('00000000-0000-0000-0000-000000006232');
    if (budget.kind !== 'created') throw new Error('create failed');
    await f.admin.query(
      `insert into public.budget_allocations (workspace_id,budget_id,category_id,planned_minor) values ($1,$2,$3,10000)`,
      [IDS.workspace, budget.budget.id, categoryId],
    );
    await f.insertExchangeRate({
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      rate: '0.5000',
      effectiveAt: '2026-01-10T00:00:00Z',
    });
    const eurAccount = await f.insertAccount({ currency: 'EUR' });
    const tx1 = '00000000-0000-0000-0000-000000006735';
    const tx2 = '00000000-0000-0000-0000-000000006736';
    try {
      await f.insertPosting({
        id: '00000000-0000-0000-0000-000000006737',
        transactionId: tx1,
        amountMinor: -1,
        currency: 'EUR',
        status: 'confirmed',
        occurredAt: '2026-01-15T12:00:00Z',
        categoryId,
        accountId: eurAccount,
      });
      await f.insertPosting({
        id: '00000000-0000-0000-0000-000000006738',
        transactionId: tx2,
        amountMinor: -1,
        currency: 'EUR',
        status: 'confirmed',
        occurredAt: '2026-01-16T12:00:00Z',
        categoryId,
        accountId: eurAccount,
      });
      const read = await f.service.getBudget(
        IDS.user,
        IDS.workspace,
        budget.budget.id,
      );
      if (read.kind !== 'found') throw new Error('read failed');
      expect(read.budget.allocations[0]?.actual.amountMinor).toBe('-2');
      expect(read.budget.allocations[0]?.available.amountMinor).toBe('10002');
    } finally {
      await f.admin.query(
        `delete from public.ledger_postings where transaction_id = any($1::uuid[])`,
        [[tx1, tx2]],
      );
      await f.admin.query(
        `delete from public.transactions where id = any($1::uuid[])`,
        [[tx1, tx2]],
      );
      await f.admin.query(
        `delete from public.budget_allocations where budget_id = $1::uuid`,
        [budget.budget.id],
      );
      await f.admin.query(`delete from public.budgets where id = $1::uuid`, [
        budget.budget.id,
      ]);
      await f.admin.query(`delete from public.categories where id = $1::uuid`, [
        categoryId,
      ]);
      await f.admin.query(`delete from public.accounts where id = $1::uuid`, [
        eurAccount,
      ]);
      await f.admin.query(
        `delete from public.exchange_rates where workspace_id = $1::uuid and base_currency = 'EUR' and rate = '0.5000'`,
        [IDS.workspace],
      );
    }
  });
  it('isolates per-category totals for multiple allocations with different currency mixes (N1)', async () => {
    // Proves that two allocations within the same budget with different currency mixes
    // compute their converted spend independently without bleeding across categories.
    // Category A (catA): planned 50000
    //   - 10000 USD (native)
    //   - 10000 EUR @ 1.1000 USD -> 11000 USD
    //   -> total actual: 21000 USD
    // Category B (catB): planned 50000
    //   - 4000 GBP @ 1.2500 USD -> 5000 USD
    //   - 2500 USD (native)
    //   -> total actual: 7500 USD
    const catA = randomUUID();
    const catB = randomUUID();
    await f.admin.query(
      `insert into public.categories (id,workspace_id,parent_id,name,kind,created_by) values ($1,$2,null,'Cat Mix A','expense',$3),($4,$2,null,'Cat Mix B','expense',$3)`,
      [catA, IDS.workspace, IDS.user, catB],
    );
    const budget = await create('00000000-0000-0000-0000-000000006233');
    if (budget.kind !== 'created') throw new Error('create failed');
    await f.admin.query(
      `insert into public.budget_allocations (workspace_id,budget_id,category_id,planned_minor) values ($1,$2,$3,50000),($1,$2,$4,50000)`,
      [IDS.workspace, budget.budget.id, catA, catB],
    );
    await f.insertExchangeRate({
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      rate: '1.1000',
      effectiveAt: '2026-01-10T00:00:00Z',
    });
    await f.insertExchangeRate({
      baseCurrency: 'GBP',
      quoteCurrency: 'USD',
      rate: '1.2500',
      effectiveAt: '2026-01-10T00:00:00Z',
    });
    const eurAccount = await f.insertAccount({ currency: 'EUR' });
    const gbpAccount = await f.insertAccount({ currency: 'GBP' });
    const tx1 = '00000000-0000-0000-0000-000000006741';
    const tx2 = '00000000-0000-0000-0000-000000006742';
    const tx3 = '00000000-0000-0000-0000-000000006743';
    const tx4 = '00000000-0000-0000-0000-000000006744';
    try {
      await f.insertPosting({
        id: '00000000-0000-0000-0000-000000006745',
        transactionId: tx1,
        amountMinor: 10000,
        currency: 'USD',
        status: 'confirmed',
        occurredAt: '2026-01-15T12:00:00Z',
        categoryId: catA,
      });
      await f.insertPosting({
        id: '00000000-0000-0000-0000-000000006746',
        transactionId: tx2,
        amountMinor: 10000,
        currency: 'EUR',
        status: 'confirmed',
        occurredAt: '2026-01-15T12:00:00Z',
        categoryId: catA,
        accountId: eurAccount,
      });
      await f.insertPosting({
        id: '00000000-0000-0000-0000-000000006747',
        transactionId: tx3,
        amountMinor: 4000,
        currency: 'GBP',
        status: 'reconciled',
        occurredAt: '2026-01-15T12:00:00Z',
        categoryId: catB,
        accountId: gbpAccount,
      });
      await f.insertPosting({
        id: '00000000-0000-0000-0000-000000006748',
        transactionId: tx4,
        amountMinor: 2500,
        currency: 'USD',
        status: 'confirmed',
        occurredAt: '2026-01-15T12:00:00Z',
        categoryId: catB,
      });
      const read = await f.service.getBudget(
        IDS.user,
        IDS.workspace,
        budget.budget.id,
      );
      if (read.kind !== 'found') throw new Error('read failed');
      const allocA = read.budget.allocations.find((a) => a.categoryId === catA);
      const allocB = read.budget.allocations.find((a) => a.categoryId === catB);
      expect(allocA?.actual.amountMinor).toBe('21000');
      expect(allocA?.available.amountMinor).toBe('29000');
      expect(allocB?.actual.amountMinor).toBe('7500');
      expect(allocB?.available.amountMinor).toBe('42500');

      const httpRes = await inject({
        method: 'GET',
        url: `/v1/budgets/${budget.budget.id}`,
        headers: baseHeaders,
      });
      expect(httpRes.statusCode).toBe(200);
      const httpAllocA = httpRes
        .json()
        .allocations.find((a: { categoryId: string }) => a.categoryId === catA);
      const httpAllocB = httpRes
        .json()
        .allocations.find((a: { categoryId: string }) => a.categoryId === catB);
      expect(httpAllocA.actual.amountMinor).toBe('21000');
      expect(httpAllocB.actual.amountMinor).toBe('7500');
    } finally {
      await f.admin.query(
        `delete from public.ledger_postings where transaction_id = any($1::uuid[])`,
        [[tx1, tx2, tx3, tx4]],
      );
      await f.admin.query(
        `delete from public.transactions where id = any($1::uuid[])`,
        [[tx1, tx2, tx3, tx4]],
      );
      await f.admin.query(
        `delete from public.budget_allocations where budget_id = $1::uuid`,
        [budget.budget.id],
      );
      await f.admin.query(`delete from public.budgets where id = $1::uuid`, [
        budget.budget.id,
      ]);
      await f.admin.query(
        `delete from public.categories where id = any($1::uuid[])`,
        [[catA, catB]],
      );
      await f.admin.query(
        `delete from public.accounts where id = any($1::uuid[])`,
        [[eurAccount, gbpAccount]],
      );
      await f.admin.query(
        `delete from public.exchange_rates where workspace_id = $1::uuid and effective_at = '2026-01-10T00:00:00Z'`,
        [IDS.workspace],
      );
    }
  });
  it('24 uses posting status when it diverges from transaction status', async () => {
    const budget = await create('00000000-0000-0000-0000-000000006221');
    if (budget.kind !== 'created') throw new Error('create failed');
    await f.admin.query(
      `insert into public.budget_allocations (workspace_id,budget_id,category_id,planned_minor) values ($1,$2,$3,10000)`,
      [IDS.workspace, budget.budget.id, IDS.statusCategory],
    );
    await f.insertPosting({
      id: '00000000-0000-0000-0000-000000006727',
      transactionId: '00000000-0000-0000-0000-000000006728',
      amountMinor: 2500,
      currency: 'USD',
      status: 'pending',
      occurredAt: '2026-01-15T12:00:00Z',
      categoryId: IDS.statusCategory,
    });
    await f.admin.query(
      `update public.transactions set status='confirmed' where id=$1`,
      ['00000000-0000-0000-0000-000000006728'],
    );
    const read = await f.service.getBudget(
      IDS.user,
      IDS.workspace,
      budget.budget.id,
    );
    if (read.kind !== 'found') throw new Error('read failed');
    expect(read.budget.allocations[0]?.actual.amountMinor).toBe('0');
  });
  it('25 replays a copied budget with the identical materialized body', async () => {
    const source = await create('00000000-0000-0000-0000-000000006222');
    if (source.kind !== 'created') throw new Error('source failed');
    await f.admin.query(
      `insert into public.budget_allocations (workspace_id,budget_id,category_id,planned_minor) values ($1,$2,$3,4321)`,
      [IDS.workspace, source.budget.id, IDS.category],
    );
    const key = '00000000-0000-0000-0000-000000006223';
    const first = await create(key, {
      ...command('Copied replay'),
      copyFromBudgetId: source.budget.id,
    });
    const replay = await create(key, {
      ...command('Copied replay'),
      copyFromBudgetId: source.budget.id,
    });
    if (first.kind !== 'created' || replay.kind !== 'replayed')
      throw new Error('replay failed');
    expect(replay.body).toEqual(first.budget);
    expect(first.budget.allocations).not.toHaveLength(0);
  });
  it('27 copies the maximum supported allocation count within the production callback deadline', async () => {
    const source = await create('00000000-0000-0000-0000-000000006224');
    if (source.kind !== 'created') throw new Error('source failed');
    const categories = Array.from(
      { length: MAX_BUDGET_ALLOCATION_COUNT },
      (_, i) => `00000000-0000-0000-0000-${String(7300 + i).padStart(12, '0')}`,
    );
    await f.admin.query(
      `insert into public.categories (id,workspace_id,parent_id,name,kind,created_by) select x, $1, null, 'Bulk ' || row_number() over (), 'expense', $2 from unnest($3::uuid[]) x`,
      [IDS.workspace, IDS.user, categories],
    );
    await f.admin.query(
      `insert into public.budget_allocations (workspace_id,budget_id,category_id,planned_minor) select $1,$2,x,1 from unnest($3::uuid[]) x`,
      [IDS.workspace, source.budget.id, categories],
    );
    const started = performance.now();
    const copied = await create('00000000-0000-0000-0000-000000006225', {
      ...command('Bulk copy'),
      copyFromBudgetId: source.budget.id,
    });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(copied.kind).toBe('created');
  });
  it('27a rejects a source with more than the maximum supported allocation count', async () => {
    const source = await create('00000000-0000-0000-0000-000000006227');
    if (source.kind !== 'created') throw new Error('source failed');
    const categories = Array.from(
      { length: MAX_BUDGET_ALLOCATION_COUNT + 1 },
      (_, i) =>
        `00000000-0000-0000-0000-${String(17300 + i).padStart(12, '0')}`,
    );
    await f.admin.query(
      `insert into public.categories (id,workspace_id,parent_id,name,kind,created_by) select x, $1, null, 'Overflow ' || row_number() over (), 'expense', $2 from unnest($3::uuid[]) x`,
      [IDS.workspace, IDS.user, categories],
    );
    await f.admin.query(
      `insert into public.budget_allocations (workspace_id,budget_id,category_id,planned_minor) select $1,$2,x,1 from unnest($3::uuid[]) x`,
      [IDS.workspace, source.budget.id, categories],
    );
    const copied = await create('00000000-0000-0000-0000-000000006228', {
      ...command('Overflow copy'),
      copyFromBudgetId: source.budget.id,
    });
    expect(copied.kind).toBe('too-many-allocations');
  });
  it('19a rejects malformed JSON over HTTP with 400', async () => {
    const response = await inject({
      method: 'POST',
      url: '/v1/budgets',
      headers: baseHeaders,
      payload: '{',
    });
    expect(response.statusCode).toBe(400);
  });
  it('19b rejects a missing workspace header over HTTP with 400', async () => {
    const headers = Object.fromEntries(
      Object.entries(baseHeaders).filter(([key]) => key !== 'x-workspace-id'),
    );
    const response = await inject({
      method: 'GET',
      url: '/v1/budgets',
      headers,
    });
    expect(response.statusCode).toBe(400);
  });
  it('19c rejects an invalid workspace header over HTTP with 400', async () => {
    const response = await inject({
      method: 'GET',
      url: '/v1/budgets',
      headers: { ...baseHeaders, 'x-workspace-id': 'not-a-uuid' },
    });
    expect(response.statusCode).toBe(400);
  });
  it('19d rejects a non-UUID budget path over HTTP with 400', async () => {
    const response = await inject({
      method: 'GET',
      url: '/v1/budgets/not-a-uuid',
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(400);
  });
  it('19e rejects an invalid limit over HTTP with 400', async () => {
    const response = await inject({
      method: 'GET',
      url: '/v1/budgets?limit=0',
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(400);
  });
  it('19f rejects a malformed cursor over HTTP with 400', async () => {
    const response = await inject({
      method: 'GET',
      url: '/v1/budgets?cursor=bad',
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(400);
  });
  it('20a answers 401 without a token on create', async () => {
    const response = await inject({
      method: 'POST',
      url: '/v1/budgets',
      headers: unauthenticatedHeaders,
      payload: JSON.stringify(command()),
    });
    expect(response.statusCode).toBe(401);
  });
  it('20b answers 401 without a token on list', async () => {
    const response = await inject({
      method: 'GET',
      url: '/v1/budgets',
      headers: unauthenticatedHeaders,
    });
    expect(response.statusCode).toBe(401);
  });
  it('20c answers 401 without a token on get', async () => {
    const response = await inject({
      method: 'GET',
      url: `/v1/budgets/${IDS.category}`,
      headers: unauthenticatedHeaders,
    });
    expect(response.statusCode).toBe(401);
  });
  it('20d answers 403 for a non-member on create', async () => {
    const response = await inject({
      method: 'POST',
      url: '/v1/budgets',
      headers: {
        ...baseHeaders,
        authorization: 'Bearer other-token',
        'idempotency-key': '00000000-0000-0000-0000-000000006901',
      },
      payload: JSON.stringify(command()),
    });
    expect(response.statusCode).toBe(403);
  });
  it('20e answers 403 for a non-member on list', async () => {
    const response = await inject({
      method: 'GET',
      url: '/v1/budgets',
      headers: { ...baseHeaders, authorization: 'Bearer other-token' },
    });
    expect(response.statusCode).toBe(403);
  });
  it('20f answers 403 for a non-member on get', async () => {
    const response = await inject({
      method: 'GET',
      url: `/v1/budgets/${IDS.category}`,
      headers: { ...baseHeaders, authorization: 'Bearer other-token' },
    });
    expect(response.statusCode).toBe(403);
  });
});
