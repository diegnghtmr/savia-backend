import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  Budget,
  BudgetAllocation,
  BudgetItem,
  BudgetListQuery,
  BudgetStore,
  CreateBudgetRequest,
  RolloverPolicy,
} from './budget.port.js';
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
      currency: string;
    }>(
      `select a.category_id::text as "categoryId",a.planned_minor::text as planned,a.rollover_policy as "rolloverPolicy",a.rollover_target_id::text as "rolloverTargetId",b.currency,coalesce((select sum(lp.amount_minor)::text from public.ledger_postings lp join public.transactions t on t.workspace_id=lp.workspace_id and t.id=lp.transaction_id where lp.workspace_id=a.workspace_id and t.category_id=a.category_id and lp.account_id is not null and t.occurred_at::date between b.period_start and b.period_end and t.status in ('confirmed','reconciled')), '0') as actual from public.budget_allocations a join public.budgets b on b.workspace_id=a.workspace_id and b.id=a.budget_id where a.workspace_id=$1::uuid and a.budget_id=$2::uuid`,
      [w, id],
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
    for (const a of as)
      await c.query(
        'insert into public.budget_allocations (workspace_id,budget_id,category_id,planned_minor,rollover_policy,rollover_target_id) values ($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5,$6::uuid)',
        [
          w,
          id,
          a.categoryId,
          a.planned.amountMinor,
          a.rolloverPolicy,
          a.rolloverTargetId ?? null,
        ],
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
