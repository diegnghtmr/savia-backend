// Migrations under test: 202609020001_budgets.sql
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BudgetsController } from '../../src/budgets/budgets.controller.js';
import {
  createBudgetListQuery,
  BudgetQueryValidationError,
} from '../../src/budgets/budget-query.js';
import { fixture, IDS, command } from './budget-fixtures.js';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');
function reply() {
  const state: { status?: number } = {};
  const r = {
    status(n: number) {
      state.status = n;
      return r;
    },
    send() {
      return r;
    },
    type() {
      return r;
    },
    request: { id: 'test', url: '/v1/budgets' },
  };
  return { r, state };
}
describe('budget list against disposable PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    f = await fixture(url);
    for (let i = 0; i < 5; i++) {
      const o = await f.service.createBudget(
        IDS.user,
        IDS.workspace,
        command(`Page ${i}`),
        `00000000-0000-0000-0000-0000000064${String(i).padStart(2, '0')}`,
      );
      if (o.kind !== 'created') throw new Error('seed failed');
    }
  });
  afterAll(async () => {
    await f.cleanup();
    await f.close();
  });
  it('17 rejects a cursor replayed with different filters', async () => {
    const first = await f.service.listBudgets(
      IDS.user,
      createBudgetListQuery({
        workspaceId: IDS.workspace,
        limitParam: '1',
        fromParam: '2026-01-01',
        toParam: '2026-12-31',
      }),
    );
    const firstCursor =
      first.kind === 'ok' ? first.page.pageInfo.nextCursor : null;
    if (!firstCursor) throw new Error('cursor missing');
    expect(() =>
      createBudgetListQuery({
        workspaceId: IDS.workspace,
        limitParam: '1',
        cursorParam: firstCursor,
        fromParam: '2026-02-01',
        toParam: '2026-12-31',
      }),
    ).toThrow(BudgetQueryValidationError);
  });
  it('18 walks every budget across multiple pages exactly once', async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const q = createBudgetListQuery({
        workspaceId: IDS.workspace,
        limitParam: '2',
        ...(cursor ? { cursorParam: cursor } : {}),
      });
      const page = await f.service.listBudgets(IDS.user, q);
      if (page.kind !== 'ok') throw new Error('list failed');
      page.page.items.forEach((x) => seen.add(x.id));
      cursor = page.page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.size).toBe(5);
  });
  it('19 maps malformed list inputs to HTTP 400', async () => {
    const c = new BudgetsController(f.service);
    const { r, state } = reply();
    await c.list(
      {
        identity: { subject: IDS.user },
        headers: { 'x-workspace-id': IDS.workspace },
      } as never,
      r as never,
      undefined,
      'bad',
    );
    expect(state.status).toBe(400);
    expect(() =>
      createBudgetListQuery({ workspaceId: IDS.workspace, limitParam: 'bad' }),
    ).toThrow(BudgetQueryValidationError);
  });
  it('20 returns forbidden for an authenticated non-member list', async () => {
    expect(
      (
        await f.service.listBudgets(IDS.otherUser, {
          workspaceId: IDS.workspace,
          limit: 2,
        })
      ).kind,
    ).toBe('forbidden');
  });
});
