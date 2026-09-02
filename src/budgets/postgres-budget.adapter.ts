import type { TransactionClient } from '../platform/pg-transaction.js';
import { buildCategorySpendSql } from '../platform/category-spend-query.js';
import type {
  Budget,
  BudgetAllocation,
  BudgetItem,
  BudgetListQuery,
  BudgetStore,
  CreateBudgetRequest,
  RolloverPolicy,
} from './budget.port.js';
export const BUDGET_ALLOCATION_PARAMETERS_PER_ROW = 6;
export const BUDGET_ALLOCATION_BATCH_SIZE =
  Math.floor(65535 / BUDGET_ALLOCATION_PARAMETERS_PER_ROW) - 1;
interface Row extends Record<string, unknown> {
  id: string;
  name: string;
  method: Budget['method'];
  periodStart: string;
  periodEnd: string;
  currency: string;
  version: number;
  cursorAt?: string;
}
function map(row: Row, allocations: readonly BudgetAllocation[] = []): Budget {
  return {
    id: row.id,
    name: row.name,
    method: row.method,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    currency: row.currency,
    allocations,
    version: Number(row.version),
  };
}
export class PostgresBudgetAdapter implements BudgetStore {
  public async readActiveRole(
    c: TransactionClient,
    w: string,
  ): Promise<string | undefined> {
    const r = await c.query<{ role: string | null }>(
      'select public.workspace_actor_active_role($1::uuid) as role',
      [w],
    );
    return r.rows[0]?.role ?? undefined;
  }
  public async readWorkspaceCurrency(
    c: TransactionClient,
    w: string,
  ): Promise<string | undefined> {
    const r = await c.query<{ currency: string }>(
      'select base_currency as currency from public.workspaces where id=$1::uuid',
      [w],
    );
    return r.rows[0]?.currency;
  }
  public async createBudget(
    c: TransactionClient,
    w: string,
    subject: string,
    x: CreateBudgetRequest,
    currency: string,
  ): Promise<Budget> {
    const r = await c.query<Row>(
      `insert into public.budgets (workspace_id,name,method,period_start,period_end,currency,created_by) values ($1::uuid,$2,$3,$4::date,$5::date,$6,$7::uuid) returning id::text,name,method,to_char(period_start,'YYYY-MM-DD') as "periodStart",to_char(period_end,'YYYY-MM-DD') as "periodEnd",currency,version`,
      [w, x.name, x.method, x.periodStart, x.periodEnd, currency, subject],
    );
    const row = r.rows[0];
    if (!row) throw new Error('Created budget could not be read.');
    return map(row);
  }
  public async findBudget(
    c: TransactionClient,
    w: string,
    id: string,
  ): Promise<Budget | undefined> {
    const r = await c.query<Row>(
      `select id::text,name,method,to_char(period_start,'YYYY-MM-DD') as "periodStart",to_char(period_end,'YYYY-MM-DD') as "periodEnd",currency,version from public.budgets where workspace_id=$1::uuid and id=$2::uuid`,
      [w, id],
    );
    const row = r.rows[0];
    if (!row) return undefined;
    return map(row, await this.readAllocations(c, w, id));
  }
  private async readAllocations(
    c: TransactionClient,
    w: string,
    id: string,
  ): Promise<BudgetAllocation[]> {
    const r = await c.query<{
      categoryId: string;
      planned: string;
      rolloverPolicy: RolloverPolicy;
      rolloverTargetId: string | null;
      actual: string;
      foreignCurrencyLegs: string;
      currency: string;
    }>(
      `select allocation.category_id::text as "categoryId",allocation.planned_minor::text as planned,allocation.rollover_policy as "rolloverPolicy",allocation.rollover_target_id::text as "rolloverTargetId",budget.currency,spend.actual,spend."foreignCurrencyLegs" from public.budget_allocations allocation join public.budgets budget on budget.workspace_id=allocation.workspace_id and budget.id=allocation.budget_id cross join lateral (${buildCategorySpendSql()}) spend where allocation.workspace_id=$1::uuid and allocation.budget_id=$2::uuid`,
      [w, id],
    );
    if (r.rows.some((x) => x.foreignCurrencyLegs !== '0'))
      throw new Error(
        'Cannot report single-currency budget spend for an allocation holding postings in another currency.',
      );
    return r.rows.map((x) => ({
      categoryId: x.categoryId,
      planned: { amountMinor: x.planned, currency: x.currency },
      actual: { amountMinor: x.actual, currency: x.currency },
      available: {
        amountMinor: (BigInt(x.planned) - BigInt(x.actual)).toString(),
        currency: x.currency,
      },
      rolloverPolicy: x.rolloverPolicy,
      rolloverTargetId: x.rolloverTargetId,
    }));
  }
  public async findSourceAllocations(
    c: TransactionClient,
    w: string,
    id: string,
  ): Promise<readonly BudgetAllocation[]> {
    const b = await this.findBudget(c, w, id);
    return b?.allocations ?? [];
  }
  public async insertCopiedAllocations(
    c: TransactionClient,
    w: string,
    id: string,
    as: readonly BudgetAllocation[],
  ): Promise<void> {
    for (
      let offset = 0;
      offset < as.length;
      offset += BUDGET_ALLOCATION_BATCH_SIZE
    ) {
      const batch = as.slice(offset, offset + BUDGET_ALLOCATION_BATCH_SIZE);
      const values: unknown[] = [];
      const rows = batch.map((a, row) => {
        const base = row * BUDGET_ALLOCATION_PARAMETERS_PER_ROW;
        values.push(
          w,
          id,
          a.categoryId,
          a.planned.amountMinor,
          a.rolloverPolicy,
          a.rolloverTargetId ?? null,
        );
        return `($${base + 1}::uuid,$${base + 2}::uuid,$${base + 3}::uuid,$${base + 4}::bigint,$${base + 5},$${base + 6}::uuid)`;
      });
      await c.query(
        `insert into public.budget_allocations (workspace_id,budget_id,category_id,planned_minor,rollover_policy,rollover_target_id) values ${rows.join(',')}`,
        values,
      );
    }
  }
  public async listBudgets(
    c: TransactionClient,
    q: BudgetListQuery,
    limit: number,
  ): Promise<readonly BudgetItem[]> {
    const r = await c.query<Row>(
      `select id::text,name,method,to_char(period_start,'YYYY-MM-DD') as "periodStart",to_char(period_end,'YYYY-MM-DD') as "periodEnd",currency,version,to_char(created_at at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt" from public.budgets where workspace_id=$1::uuid and ($2::date is null or period_start >= $2::date) and ($3::date is null or period_end <= $3::date) and ($4::timestamptz is null or (created_at,id)>($4::timestamptz,$5::uuid)) order by created_at,id limit $6`,
      [
        q.workspaceId,
        q.from ?? null,
        q.to ?? null,
        q.cursor?.createdAt ?? null,
        q.cursor?.id ?? null,
        limit,
      ],
    );
    const out: BudgetItem[] = [];
    for (const row of r.rows)
      out.push({
        budget: map(row, await this.readAllocations(c, q.workspaceId, row.id)),
        cursorAt: row.cursorAt ?? '',
      });
    return out;
  }
}
