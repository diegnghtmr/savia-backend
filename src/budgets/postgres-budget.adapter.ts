import type { TransactionClient } from '../platform/pg-transaction.js';
import { buildCategorySpendSql } from '../platform/category-spend-query.js';
import {
  CURRENCY_RATE_SELECTION_SQL,
  multiplyMinorByRate,
} from '../platform/currency-conversion.js';
import type {
  Budget,
  BudgetAllocation,
  BudgetItem,
  BudgetListQuery,
  BudgetStore,
  CreateBudgetRequest,
  UpdateBudgetRequest,
  RolloverPolicy,
} from './budget.port.js';
export const BUDGET_ALLOCATION_PARAMETERS_PER_ROW = 6;
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
  public async updateBudget(
    c: TransactionClient,
    w: string,
    id: string,
    x: UpdateBudgetRequest,
    expectedVersion?: number,
  ): Promise<Budget | undefined> {
    const sets: string[] = [];
    const params: unknown[] = [w, id];
    if (x.name !== undefined) {
      params.push(x.name);
      sets.push(`name = $${params.length}`);
    }
    if (x.method !== undefined) {
      params.push(x.method);
      sets.push(`method = $${params.length}`);
    }
    sets.push('version = version + 1', 'updated_at = now()');

    let sql = `update public.budgets set ${sets.join(', ')} where workspace_id = $1::uuid and id = $2::uuid`;
    if (expectedVersion !== undefined) {
      params.push(expectedVersion);
      sql += ` and version = $${params.length}::integer`;
    }
    sql += ` returning id::text,name,method,to_char(period_start,'YYYY-MM-DD') as "periodStart",to_char(period_end,'YYYY-MM-DD') as "periodEnd",currency,version`;

    const r = await c.query<Row>(sql, params);
    if (r.rowCount !== 1) {
      if (r.rowCount === 0 && expectedVersion !== undefined) {
        return undefined;
      }
      throw new Error(
        `Budget update affected ${r.rowCount ?? 'an unknown number of'} rows`,
      );
    }
    const row = r.rows[0];
    if (!row) throw new Error('Budget update returned no row.');
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
      currency: string;
      amountMinor: string | null;
      postingCurrency: string | null;
      occurredAt: Date | null;
    }>(
      `select allocation.category_id::text as "categoryId",allocation.planned_minor::text as planned,allocation.rollover_policy as "rolloverPolicy",allocation.rollover_target_id::text as "rolloverTargetId",budget.currency,spend."amountMinor",spend.currency as "postingCurrency",spend."occurredAt" from public.budget_allocations allocation join public.budgets budget on budget.workspace_id=allocation.workspace_id and budget.id=allocation.budget_id left join lateral (${buildCategorySpendSql()}) spend on true where allocation.workspace_id=$1::uuid and allocation.budget_id=$2::uuid`,
      [w, id],
    );
    const actualByCategory = new Map<string, bigint>();
    for (const row of r.rows) {
      if (row.amountMinor === null || row.occurredAt === null) {
        actualByCategory.set(
          row.categoryId,
          actualByCategory.get(row.categoryId) ?? 0n,
        );
        continue;
      }
      const amount =
        row.postingCurrency === row.currency
          ? row.amountMinor
          : await this.convertPosting(
              c,
              w,
              row.postingCurrency ?? row.currency,
              row.currency,
              row.amountMinor,
              row.occurredAt,
            );
      actualByCategory.set(
        row.categoryId,
        (actualByCategory.get(row.categoryId) ?? 0n) + BigInt(amount),
      );
    }
    return [
      ...new Map(r.rows.map((row) => [row.categoryId, row])).values(),
    ].map((x) => {
      const actual = actualByCategory.get(x.categoryId) ?? 0n;
      return {
        categoryId: x.categoryId,
        planned: { amountMinor: x.planned, currency: x.currency },
        actual: { amountMinor: actual.toString(), currency: x.currency },
        available: {
          amountMinor: (BigInt(x.planned) - actual).toString(),
          currency: x.currency,
        },
        rolloverPolicy: x.rolloverPolicy,
        rolloverTargetId: x.rolloverTargetId,
      };
    });
  }

  /**
   * Architecture Decision (Slice 6.1 - Rounding Granularity):
   *
   * Conversions from posting currencies to budget currency are rounded
   * per-posting to integer minor units via `multiplyMinorByRate` (which implements
   * half-away-from-zero rounding) prior to aggregation into the allocation's actual total.
   *
   * Rationale for per-posting rounding:
   * 1. Line-item auditability: each posting can be converted and audited individually;
   *    its converted amount is identical whether viewed in isolation or as part of a budget.
   * 2. Consistency: individual converted amounts match line-item ledger records.
   * 3. Deterministic integer arithmetic: sums are computed over integer minor units without
   *    intermediate floating point or arbitrary-precision fraction state in the accumulator.
   *
   * Tradeoff:
   * Per-posting rounding can accumulate small half-unit rounding discrepancies across many
   * postings compared to summing infinite-precision fractional amounts and rounding once
   * per allocation. For Slice 6.1, line-item auditability and ledger reconciliation consistency
   * are intentionally prioritized over aggregate fractional smoothing.
   */
  private async convertPosting(
    c: TransactionClient,
    workspaceId: string,
    baseCurrency: string,
    quoteCurrency: string,
    amountMinor: string,
    occurredAt: Date,
  ): Promise<string> {
    const result = await c.query<{ rate: string }>(
      CURRENCY_RATE_SELECTION_SQL,
      [workspaceId, baseCurrency, quoteCurrency, occurredAt],
    );
    const rate = result.rows[0]?.rate;
    if (!rate)
      throw new Error(
        `No exchange rate found for converting posting currency ${baseCurrency} to budget currency ${quoteCurrency}.`,
      );
    return multiplyMinorByRate(amountMinor, rate);
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
    // MAX_BUDGET_ALLOCATION_COUNT is 1000; each row uses 6 parameters and PostgreSQL permits 65535, so one statement is sufficient.
    if (as.length === 0) return;
    const values: unknown[] = [];
    const rows = as.map((a, row) => {
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
