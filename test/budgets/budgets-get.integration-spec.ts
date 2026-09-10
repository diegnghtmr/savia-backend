// Migrations under test: 202609020001_budgets.sql
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BudgetsController } from '../../src/budgets/budgets.controller.js';
import { fixture, IDS, command } from './budget-fixtures.js';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');
function reply() {
  const state: { status?: number; etag?: string; body?: unknown } = {};
  const r = {
    status(n: number) {
      state.status = n;
      return r;
    },
    header(k: string, v: string) {
      if (k.toLowerCase() === 'etag') state.etag = v;
      return r;
    },
    send(v: unknown) {
      state.body = v;
      return r;
    },
    type() {
      return r;
    },
    request: { id: 'test', url: '/v1/budgets' },
  };
  return { r, state };
}
describe('budget get against disposable PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    f = await fixture(url);
  });
  afterAll(async () => {
    await f.cleanup();
    await f.close();
  });
  it('13 hides a real foreign budget as not found', async () => {
    const foreign = await f.service.createBudget(
      IDS.otherUser,
      IDS.otherWorkspace,
      command('Foreign'),
      '00000000-0000-0000-0000-000000006301',
    );
    if (foreign.kind !== 'created') throw new Error('foreign create failed');
    const o = await f.service.getBudget(
      IDS.user,
      IDS.workspace,
      foreign.budget.id,
    );
    expect(o.kind).toBe('not-found');
  });
  it('14 emits the stored version as HTTP ETag', async () => {
    const created = await f.service.createBudget(
      IDS.user,
      IDS.workspace,
      command('ETag'),
      '00000000-0000-0000-0000-000000006302',
    );
    if (created.kind !== 'created') throw new Error('create failed');
    const c = new BudgetsController(f.service);
    const { r, state } = reply();
    await c.get(
      created.budget.id,
      {
        identity: { subject: IDS.user },
        headers: { 'x-workspace-id': IDS.workspace },
      } as never,
      r as never,
    );
    expect(state.status).toBe(200);
    expect(state.etag).toBe('"1"');
  });
  it('20 returns forbidden for an authenticated non-member', async () => {
    const created = await f.service.createBudget(
      IDS.user,
      IDS.workspace,
      command('Protected'),
      '00000000-0000-0000-0000-000000006303',
    );
    if (created.kind !== 'created') throw new Error('create failed');
    expect(
      (
        await f.service.getBudget(
          IDS.otherUser,
          IDS.workspace,
          created.budget.id,
        )
      ).kind,
    ).toBe('forbidden');
  });
});
