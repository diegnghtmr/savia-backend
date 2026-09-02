import { Pool } from 'pg';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresBudgetAdapter } from '../../src/budgets/postgres-budget.adapter.js';
import { BudgetService } from '../../src/budgets/budget.service.js';
import { PostgresIdempotencyAdapter } from '../../src/platform/postgres-idempotency.adapter.js';
import type { CreateBudgetRequest } from '../../src/budgets/budget.port.js';

export const IDS = {
  user: '00000000-0000-0000-0000-000000006101',
  otherUser: '00000000-0000-0000-0000-000000006102',
  workspace: '00000000-0000-0000-0000-000000006111',
  otherWorkspace: '00000000-0000-0000-0000-000000006112',
  category: '00000000-0000-0000-0000-000000006121',
  otherCategory: '00000000-0000-0000-0000-000000006122',
  account: '00000000-0000-0000-0000-000000006123',
  statusCategory: '00000000-0000-0000-0000-000000006124',
} as const;
export const command = (
  name = 'Budget',
  start = '2026-01-01',
  end = '2026-02-01',
): CreateBudgetRequest => ({
  name,
  method: 'envelope' as const,
  periodStart: start,
  periodEnd: end,
});
export async function fixture(url: string) {
  const admin = new Pool({ connectionString: url });
  await admin.query(
    `insert into auth.users (id,email) values ($1,$2),($3,$4)`,
    [
      IDS.user,
      'budget-owner@example.test',
      IDS.otherUser,
      'budget-other@example.test',
    ],
  );
  for (const [id, email] of [
    [IDS.user, 'budget-owner@example.test'],
    [IDS.otherUser, 'budget-other@example.test'],
  ])
    await admin.query(
      `insert into public.profiles (id,email,display_name,locale,country_code,timezone,date_format,week_starts_on,number_format,default_currency,privacy_mode_enabled) values ($1,$2,'Budget User','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD',false)`,
      [id, email],
    );
  await admin.query(
    `insert into public.workspaces (id,name,kind,base_currency,personal_owner_profile_id,created_by) values ($1,'Budget Workspace','shared','USD',null,$2),($3,'Other Budget Workspace','shared','EUR',null,$4)`,
    [IDS.workspace, IDS.user, IDS.otherWorkspace, IDS.otherUser],
  );
  await admin.query(
    `insert into public.workspace_memberships (workspace_id,profile_id,role,status) values ($1,$2,'owner','active'),($3,$4,'owner','active')`,
    [IDS.workspace, IDS.user, IDS.otherWorkspace, IDS.otherUser],
  );
  await admin.query(
    `insert into public.categories (id,workspace_id,parent_id,name,kind,created_by) values ($1,$2,null,'Food','expense',$3),($4,$5,null,'Other Food','expense',$6),($7,$2,null,'Status Food','expense',$3)`,
    [
      IDS.category,
      IDS.workspace,
      IDS.user,
      IDS.otherCategory,
      IDS.otherWorkspace,
      IDS.otherUser,
      IDS.statusCategory,
    ],
  );
  await admin.query(
    `insert into public.accounts (id,workspace_id,name,type,currency,status,created_by) values ($1,$2,'Budget Cash','cash','USD','active',$3)`,
    [IDS.account, IDS.workspace, IDS.user],
  );
  const pool = new PostgresPool(PostgresConfig.fromUrl(url));
  const tx = new PgTransaction(pool);
  const service = new BudgetService(
    tx,
    new PostgresBudgetAdapter(),
    new PostgresIdempotencyAdapter(),
  );
  return {
    admin,
    pool,
    tx,
    service,
    async close() {
      await pool.end();
      await admin.end();
    },
    async cleanup() {
      await admin.query(
        'delete from public.budgets where workspace_id in ($1,$2)',
        [IDS.workspace, IDS.otherWorkspace],
      );
    },
    async insertPosting(options: {
      readonly id: string;
      readonly transactionId: string;
      readonly amountMinor: number;
      readonly currency: string;
      readonly status: string;
      readonly occurredAt: string;
      readonly categoryId?: string;
    }) {
      const transactionSuffix = options.transactionId.slice(-12);
      const externalId = `${options.transactionId.slice(0, -12)}${(
        BigInt(`0x${transactionSuffix}`) + 0x1000n
      )
        .toString(16)
        .padStart(12, '0')}`;
      await admin.query(
        `insert into public.transactions (id,workspace_id,account_id,type,status,amount_minor,currency,occurred_at,category_id,created_by) values ($1,$2,$3,'expense',$4,$5,$6,$7,$8,$9)`,
        [
          options.transactionId,
          IDS.workspace,
          IDS.account,
          options.status,
          options.amountMinor,
          options.currency,
          options.occurredAt,
          options.categoryId ?? IDS.category,
          IDS.user,
        ],
      );
      await admin.query(
        `insert into public.ledger_postings (id,workspace_id,transaction_id,account_id,leg_kind,amount_minor,currency,status,occurred_at) values ($1,$2,$3,$4,'account',$5,$6,$7,$8),($9,$2,$3,null,'external',$10,$6,$7,$8)`,
        [
          options.id,
          IDS.workspace,
          options.transactionId,
          IDS.account,
          options.amountMinor,
          options.currency,
          options.status,
          options.occurredAt,
          externalId,
          -options.amountMinor,
        ],
      );
    },
  };
}
