// Migrations under test: 202609020001_budgets.sql
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');
describe('budgets schema', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: url });
  });
  afterAll(() => pool.end());
  it('publishes budget tables, named checks, composite keys and forced RLS', async () => {
    const r = await pool.query<{
      table_name: string;
      rls: boolean;
      force: boolean;
    }>(
      `select c.relname table_name,c.relrowsecurity rls,c.relforcerowsecurity force from pg_class c where c.relname in ('budgets','budget_allocations')`,
    );
    expect(r.rows).toHaveLength(2);
    expect(r.rows.every((x) => x.rls && x.force)).toBe(true);
    const c = await pool.query<{ conname: string }>(
      `select conname from pg_constraint where conname in ('budgets_method_check','budgets_currency_check','budgets_name_length_check','budgets_period_order_check','budgets_period_span_check','budgets_version_check','budget_allocations_rollover_policy_check','budget_allocations_category_workspace_fkey')`,
    );
    expect(c.rows.map((x) => x.conname)).toEqual(
      expect.arrayContaining([
        'budgets_method_check',
        'budgets_period_span_check',
        'budget_allocations_category_workspace_fkey',
      ]),
    );
  });
});
