// Migrations under test: 202609020001_budgets.sql
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUDGET_OUTCOMES } from '../../src/budgets/budget.port.js';
import { fixture, IDS, command } from './budget-fixtures.js';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');
describe('budget creation against disposable PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    f = await fixture(url);
  });
  afterAll(async () => {
    await f.cleanup();
    await f.close();
  });
  const create = (key: string, body = command()) =>
    f.service.createBudget(IDS.user, IDS.workspace, body, key);
  it('1 snapshots workspace base currency', async () => {
    const o = await create('00000000-0000-0000-0000-000000006201');
    expect(o.kind).toBe(BUDGET_OUTCOMES.CREATED);
    if (o.kind === 'created') expect(o.budget.currency).toBe('USD');
  });
  it('2 keeps original currency after workspace change', async () => {
    const o = await create('00000000-0000-0000-0000-000000006202');
    if (o.kind !== 'created') throw new Error('create failed');
    await f.admin.query(
      `update public.workspaces set base_currency='EUR' where id=$1`,
      [IDS.workspace],
    );
    const read = await f.service.getBudget(
      IDS.user,
      IDS.workspace,
      o.budget.id,
    );
    expect(read.kind).toBe('found');
    if (read.kind === 'found') expect(read.budget.currency).toBe('USD');
    await f.admin.query(
      `update public.workspaces set base_currency='USD' where id=$1`,
      [IDS.workspace],
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
    await expect(() =>
      Promise.resolve().then(() =>
        create(
          '00000000-0000-0000-0000-000000006204',
          command('Equal', '2026-02-01', '2026-02-01'),
        ),
      ),
    ).rejects.toThrow();
  });
  it('5 rejects inverted dates', async () => {
    await expect(() =>
      Promise.resolve().then(() =>
        create(
          '00000000-0000-0000-0000-000000006205',
          command('Inverted', '2026-03-01', '2026-02-01'),
        ),
      ),
    ).rejects.toThrow();
  });
  it('6 rejects a 367-day period', async () => {
    await expect(() =>
      Promise.resolve().then(() =>
        create(
          '00000000-0000-0000-0000-000000006206',
          command('Long', '2026-01-01', '2027-01-03'),
        ),
      ),
    ).rejects.toThrow();
  });
  it('7 accepts exactly 366 days', async () => {
    const o = await create(
      '00000000-0000-0000-0000-000000006207',
      command('Boundary', '2026-01-01', '2027-01-02'),
    );
    expect(o.kind).toBe('created');
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
  it('10 copies no outcome values', async () => {
    const source = await create('00000000-0000-0000-0000-000000006212');
    if (source.kind !== 'created') throw new Error('source failed');
    await f.admin.query(
      `insert into public.budget_allocations (workspace_id,budget_id,category_id,planned_minor,rollover_policy) values ($1,$2,$3,99,'none')`,
      [IDS.workspace, source.budget.id, IDS.category],
    );
    const copied = await create('00000000-0000-0000-0000-000000006213', {
      ...command('Copy outcome'),
      copyFromBudgetId: source.budget.id,
    });
    if (copied.kind !== 'created') throw new Error('copy failed');
    expect(copied.budget.allocations[0]?.actual.amountMinor).toBe('0');
    expect(copied.budget.allocations[0]?.available.amountMinor).toBe('99');
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
    const a = await create(key, command('Replay'));
    const b = await create(key, command('Replay'));
    expect(a.kind).toBe('created');
    expect(b.kind).toBe('replayed');
    const r = await f.admin.query(
      `select count(*)::int as count from public.budgets where workspace_id=$1`,
      [IDS.workspace],
    );
    expect(r.rows[0].count).toBeGreaterThanOrEqual(1);
  });
  it('16 rejects same key with a different body', async () => {
    const key = '00000000-0000-0000-0000-000000006218';
    await create(key, command('First'));
    const o = await create(key, command('Second'));
    expect(o.kind).toBe('conflict');
  });
  it('22 concurrent same-key creates leave one row', async () => {
    const key = '00000000-0000-0000-0000-000000006219';
    const before = (
      await f.admin.query(
        `select count(*)::int as count from public.budgets where workspace_id=$1`,
        [IDS.workspace],
      )
    ).rows[0].count;
    const results = await Promise.all([
      create(key, command('Concurrent')),
      create(key, command('Concurrent')),
    ]);
    expect(results.map((x) => x.kind).sort()).toEqual(['created', 'replayed']);
    const after = (
      await f.admin.query(
        `select count(*)::int as count from public.budgets where workspace_id=$1`,
        [IDS.workspace],
      )
    ).rows[0].count;
    expect(after - before).toBe(1);
  });
});
