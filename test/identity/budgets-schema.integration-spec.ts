// Migrations under test: 202609020001_budgets.sql, 202609020002_budgets_created_at_index.sql
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, IDS, command } from '../budgets/budget-fixtures.js';
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
  it('pins columns, every constraint, foreign-key actions, grants, and policies', async () => {
    const columns = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name in ('budgets','budget_allocations') order by table_name,ordinal_position`,
    );
    expect(columns.rows).toEqual([
      expect.objectContaining({
        table_name: 'budget_allocations',
        column_name: 'id',
        data_type: 'uuid',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        table_name: 'budget_allocations',
        column_name: 'workspace_id',
        data_type: 'uuid',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        table_name: 'budget_allocations',
        column_name: 'budget_id',
        data_type: 'uuid',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        table_name: 'budget_allocations',
        column_name: 'category_id',
        data_type: 'uuid',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        table_name: 'budget_allocations',
        column_name: 'planned_minor',
        data_type: 'bigint',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        table_name: 'budget_allocations',
        column_name: 'rollover_policy',
        data_type: 'text',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        table_name: 'budget_allocations',
        column_name: 'rollover_target_id',
        data_type: 'uuid',
        is_nullable: 'YES',
      }),
      expect.objectContaining({
        table_name: 'budget_allocations',
        column_name: 'created_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        table_name: 'budgets',
        column_name: 'id',
        data_type: 'uuid',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        table_name: 'budgets',
        column_name: 'workspace_id',
        data_type: 'uuid',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        table_name: 'budgets',
        column_name: 'name',
        data_type: 'text',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        table_name: 'budgets',
        column_name: 'method',
        data_type: 'text',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        table_name: 'budgets',
        column_name: 'period_start',
        data_type: 'date',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        table_name: 'budgets',
        column_name: 'period_end',
        data_type: 'date',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        table_name: 'budgets',
        column_name: 'currency',
        data_type: 'text',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        table_name: 'budgets',
        column_name: 'version',
        data_type: 'integer',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        table_name: 'budgets',
        column_name: 'created_by',
        data_type: 'uuid',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        table_name: 'budgets',
        column_name: 'created_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        table_name: 'budgets',
        column_name: 'updated_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      }),
    ]);
    const constraints = await pool.query<{
      table_name: string;
      conname: string;
      contype: string;
      definition: string;
    }>(
      `select c.relname table_name,p.conname,p.contype,pg_get_constraintdef(p.oid) definition from pg_constraint p join pg_class c on c.oid=p.conrelid where c.relnamespace='public'::regnamespace and c.relname in ('budgets','budget_allocations') order by c.relname,p.conname`,
    );
    expect(constraints.rows.map((x) => `${x.table_name}.${x.conname}`)).toEqual(
      [
        'budget_allocations.budget_allocations_budget_workspace_fkey',
        'budget_allocations.budget_allocations_category_workspace_fkey',
        'budget_allocations.budget_allocations_pkey',
        'budget_allocations.budget_allocations_rollover_policy_check',
        'budget_allocations.budget_allocations_workspace_budget_category_key',
        'budgets.budgets_currency_check',
        'budgets.budgets_method_check',
        'budgets.budgets_name_length_check',
        'budgets.budgets_period_order_check',
        'budgets.budgets_period_span_check',
        'budgets.budgets_pkey',
        'budgets.budgets_version_check',
        'budgets.budgets_workspace_id_id_key',
        'budgets.budgets_created_by_fkey',
        'budgets.budgets_workspace_id_fkey',
      ].sort(),
    );
    expect(
      constraints.rows.find((x) => x.conname === 'budgets_period_span_check')
        ?.definition,
    ).toMatch(/period_end\s*-\s*period_start\)\s*<=\s*366/);
    expect(
      constraints.rows.find(
        (x) => x.conname === 'budget_allocations_budget_workspace_fkey',
      )?.definition,
    ).toContain('ON DELETE CASCADE');
    expect(
      constraints.rows.find(
        (x) => x.conname === 'budget_allocations_category_workspace_fkey',
      )?.definition,
    ).toContain('ON DELETE RESTRICT');
    expect(
      constraints.rows.some(
        (x) =>
          x.definition.includes('period_start') &&
          x.definition.includes('period_end') &&
          x.contype === 'u',
      ),
    ).toBe(false);
    const foreignKeys = await pool.query<{
      conname: string;
      columns: string[];
      delete_action: string;
    }>(
      `select p.conname,array_agg(a.attname order by u.ordinality)::text[] columns,case p.confdeltype when 'c' then 'CASCADE' when 'r' then 'RESTRICT' else p.confdeltype::text end delete_action from pg_constraint p cross join lateral unnest(p.conkey) with ordinality u(attnum,ordinality) join pg_attribute a on a.attrelid=p.conrelid and a.attnum=u.attnum where p.contype='f' and p.conrelid in ('public.budgets'::regclass,'public.budget_allocations'::regclass) group by p.conname,p.confdeltype order by p.conname`,
    );
    expect(foreignKeys.rows).toEqual([
      {
        conname: 'budget_allocations_budget_workspace_fkey',
        columns: ['workspace_id', 'budget_id'],
        delete_action: 'CASCADE',
      },
      {
        conname: 'budget_allocations_category_workspace_fkey',
        columns: ['workspace_id', 'category_id'],
        delete_action: 'RESTRICT',
      },
      {
        conname: 'budgets_created_by_fkey',
        columns: ['created_by'],
        delete_action: 'RESTRICT',
      },
      {
        conname: 'budgets_workspace_id_fkey',
        columns: ['workspace_id'],
        delete_action: 'CASCADE',
      },
    ]);
    const policies = await pool.query<{
      tablename: string;
      policyname: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `select tablename,policyname,cmd,qual,with_check from pg_policies where schemaname='public' and tablename in ('budgets','budget_allocations') order by tablename,policyname`,
    );
    expect(
      policies.rows.map((x) => `${x.tablename}.${x.policyname}.${x.cmd}`),
    ).toEqual([
      'budget_allocations.application_inserts_workspace_budget_allocations.INSERT',
      'budget_allocations.application_reads_workspace_budget_allocations.SELECT',
      'budgets.application_inserts_workspace_budgets.INSERT',
      'budgets.application_reads_workspace_budgets.SELECT',
    ]);
    expect(
      policies.rows.every((x) =>
        (x.qual ?? x.with_check ?? '').includes('workspace_actor_active_role'),
      ),
    ).toBe(true);
    const grants = await pool.query<{
      table_name: string;
      column_name: string;
      selectable: boolean;
      insertable: boolean;
    }>(
      `select c.table_name,c.column_name,has_column_privilege('savia_application',format('%I.%I',c.table_schema,c.table_name),c.column_name,'select') selectable,has_column_privilege('savia_application',format('%I.%I',c.table_schema,c.table_name),c.column_name,'insert') insertable from information_schema.columns c where c.table_schema='public' and c.table_name in ('budgets','budget_allocations') order by c.table_name,c.ordinal_position`,
    );
    const expectedInsertable = new Set([
      'budget_allocations.workspace_id',
      'budget_allocations.budget_id',
      'budget_allocations.category_id',
      'budget_allocations.planned_minor',
      'budget_allocations.rollover_policy',
      'budget_allocations.rollover_target_id',
      'budgets.workspace_id',
      'budgets.name',
      'budgets.method',
      'budgets.period_start',
      'budgets.period_end',
      'budgets.currency',
      'budgets.version',
      'budgets.created_by',
    ]);
    expect(grants.rows.every((x) => x.selectable)).toBe(true);
    expect(
      grants.rows
        .filter((x) => x.insertable)
        .map((x) => `${x.table_name}.${x.column_name}`)
        .sort(),
    ).toEqual([...expectedInsertable].sort());
  });
  it('pins the list keyset index to the implemented created_at,id ordering', async () => {
    const result = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname='public' and tablename='budgets' and indexname='budgets_workspace_created_at_id_idx'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.indexdef).toContain(
      '(workspace_id, created_at, id)',
    );
  });
});
describe('budgets RLS', () => {
  it('21 hides both tables from a non-member SQL role', async () => {
    const f = await fixture(url);
    const created = await f.service.createBudget(
      IDS.user,
      IDS.workspace,
      command('RLS'),
      '00000000-0000-0000-0000-000000006501',
    );
    if (created.kind !== 'created') throw new Error('create failed');
    await f.admin.query(
      'insert into public.budget_allocations(workspace_id,budget_id,category_id,planned_minor) values($1,$2,$3,1)',
      [IDS.workspace, created.budget.id, IDS.category],
    );
    const client = await f.admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_application');
      await client.query(`select set_config('app.subject_id',$1,true)`, [
        IDS.otherUser,
      ]);
      expect(
        (
          await client.query(
            'select id from public.budgets where workspace_id=$1',
            [IDS.workspace],
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await client.query(
            'select id from public.budget_allocations where workspace_id=$1',
            [IDS.workspace],
          )
        ).rows,
      ).toHaveLength(0);
      await client.query('rollback');
    } finally {
      client.release();
    }
    await f.cleanup();
    await f.close();
  });
});
