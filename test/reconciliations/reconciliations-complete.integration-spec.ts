// Migrations under test: 202608310002_reconciliations.sql
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PostgresReconciliationAdapter } from '../../src/reconciliations/postgres-reconciliation.adapter.js';
import { ReconciliationService } from '../../src/reconciliations/reconciliation.service.js';
import { PostgresIdempotencyAdapter } from '../../src/platform/postgres-idempotency.adapter.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';
import { PostgresTransactionAdapter } from '../../src/ledger/postgres-transaction.adapter.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

describe('completeReconciliation against a real database', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let tx: PgTransaction;
  let service: ReconciliationService;
  const owner = id(6101);
  const workspace = id(6102);
  const foreignWorkspace = id(6103);
  const account = id(6104);
  const foreignAccount = id(6105);
  const txConfirmed = id(6110);
  const txDraft = id(6111);
  const txPending = id(6112);
  const txVoided = id(6113);
  const txReconciled = id(6114);
  const txAfterCutoff = id(6115);
  const noPosting = id(6116);
  const txAtomic = id(6117);

  async function seedTransaction(
    txId: string,
    status: string,
    occurredAt: string,
    withPosting = true,
  ) {
    await admin.query(
      `insert into public.transactions (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by, voided_at) values ($1,$2,$3,'income',$4,100,'USD',$5,$6,case when $4='voided' then now() else null end)`,
      [txId, workspace, account, status, occurredAt, owner],
    );
    if (withPosting)
      await admin.query(
        `insert into public.ledger_postings (workspace_id,transaction_id,account_id,leg_kind,amount_minor,currency,status,occurred_at) values ($1,$2,$3,'account',100,'USD',$4,$5),($1,$2,null,'external',-100,'USD',$4,$5)`,
        [
          workspace,
          txId,
          account,
          status === 'voided' ? 'confirmed' : status,
          occurredAt,
        ],
      );
  }
  async function seedReconciliation(
    recId: string,
    status = 'open',
    difference: number | string = 100,
    ws = workspace,
    acc = account,
  ) {
    await admin.query(
      `insert into public.reconciliations (id,workspace_id,account_id,statement_date,statement_balance_minor,statement_currency,system_balance_minor,difference_minor,status,created_by,completed_at) values ($1,$2,$3,'2026-08-30',$4,'USD',0,$4,$5,$6,case when $5='completed' then now() else null end)`,
      [recId, ws, acc, difference, status, owner],
    );
  }
  async function complete(
    recId: string,
    transactionIds: string[] = [txConfirmed],
    extra: Record<string, unknown> = {},
  ) {
    return service.completeReconciliation(
      owner,
      workspace,
      recId,
      { transactionIds, createAdjustment: false, ...extra },
      id(Number(recId.slice(-4)) + 7000),
    );
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    tx = new PgTransaction(pool, { callbackTimeoutMs: 3000 });
    service = new ReconciliationService(
      tx,
      new PostgresReconciliationAdapter(),
      new PostgresIdempotencyAdapter(),
      new PostgresTransactionAdapter(),
    );
    await admin.query(
      `insert into auth.users (id,email) values ($1,'complete-owner@example.test')`,
      [owner],
    );
    await admin.query(
      `insert into public.profiles (id,email,display_name,locale,country_code,timezone,date_format,week_starts_on,number_format,default_currency,privacy_mode_enabled) values ($1,'complete-owner@example.test','Complete Owner','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD',false)`,
      [owner],
    );
    await admin.query(
      `insert into public.workspaces (id,name,kind,base_currency,personal_owner_profile_id) values ($1,'Complete WS','shared','USD',null),($2,'Foreign WS','shared','USD',null)`,
      [workspace, foreignWorkspace],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id,profile_id,role,status) values ($1,$3,'owner','active'),($2,$3,'owner','active')`,
      [workspace, foreignWorkspace, owner],
    );
    await admin.query(
      `insert into public.accounts (id,workspace_id,name,type,currency,status,created_by) values ($1,$3,'Complete Account','checking','USD','active',$4),($2,$5,'Foreign Account','checking','USD','active',$4)`,
      [account, foreignAccount, workspace, owner, foreignWorkspace],
    );
    await seedTransaction(txConfirmed, 'confirmed', '2026-08-20T10:00:00Z');
    await seedTransaction(txDraft, 'draft', '2026-08-20T10:00:00Z');
    await seedTransaction(txPending, 'pending', '2026-08-20T10:00:00Z');
    await seedTransaction(txVoided, 'voided', '2026-08-20T10:00:00Z');
    await seedTransaction(txReconciled, 'reconciled', '2026-08-20T10:00:00Z');
    await seedTransaction(txAfterCutoff, 'confirmed', '2026-09-01T10:00:00Z');
    await seedTransaction(
      noPosting,
      'confirmed',
      '2026-08-20T10:00:00Z',
      false,
    );
    await seedTransaction(txAtomic, 'confirmed', '2026-08-20T10:00:00Z');
  });
  afterAll(async () => {
    await admin.query('delete from public.workspaces where id in ($1,$2)', [
      workspace,
      foreignWorkspace,
    ]);
    await admin.query('delete from auth.users where id=$1', [owner]);
    await pool.end();
    await admin.end();
  });
  afterEach(async () => {
    await admin.query(
      'delete from public.reconciliations where workspace_id in ($1,$2)',
      [workspace, foreignWorkspace],
    );
  });

  it('completes as an attestation without moving the native balance', async () => {
    const rec = id(6201);
    await seedReconciliation(rec);
    const before = await admin.query(
      `select coalesce(sum(amount_minor),0)::text as balance from public.ledger_postings where workspace_id=$1 and account_id=$2 and status in ('confirmed','reconciled')`,
      [workspace, account],
    );
    const result = await complete(rec);
    const after = await admin.query(
      `select coalesce(sum(amount_minor),0)::text as balance from public.ledger_postings where workspace_id=$1 and account_id=$2 and status in ('confirmed','reconciled')`,
      [workspace, account],
    );
    expect(result.kind).toBe('completed');
    expect(after.rows[0].balance).toBe(before.rows[0].balance);
    expect(
      (
        await admin.query(
          'select status from public.transactions where id=$1',
          [txConfirmed],
        )
      ).rows[0].status,
    ).toBe('reconciled');
    expect(
      (
        await admin.query(
          'select status from public.reconciliations where id=$1',
          [rec],
        )
      ).rows[0].status,
    ).toBe('completed');
  });

  it.each([
    ['unknown', id(6291)],
    ['foreign workspace', foreignAccount],
    ['no posting', noPosting],
    ['draft', txDraft],
    ['pending', txPending],
    ['voided', txVoided],
    ['already reconciled', txReconciled],
    ['after cutoff', txAfterCutoff],
  ])(
    'rejects %s transaction validation with 422 outcome and no transition',
    async (_name, transactionId) => {
      const rec = id(6300 + Number(transactionId.slice(-2)));
      await seedReconciliation(rec);
      const result = await complete(rec, [transactionId]);
      expect(result.kind).toBe('transactions-invalid');
      const expectedStatus =
        transactionId === txReconciled
          ? 'reconciled'
          : transactionId === txVoided
            ? 'voided'
            : transactionId === txDraft
              ? 'draft'
              : transactionId === txPending
                ? 'pending'
                : 'confirmed';
      const transactionRow = (
        await admin.query(
          'select status from public.transactions where id=$1',
          [transactionId],
        )
      ).rows[0];
      if (transactionRow) expect(transactionRow.status).toBe(expectedStatus);
    },
  );

  it('validates the whole list atomically when the last id is invalid', async () => {
    const rec = id(6401);
    await seedReconciliation(rec);
    const result = await complete(rec, [txAtomic, txPending]);
    expect(result.kind).toBe('transactions-invalid');
    expect(
      (
        await admin.query(
          `select count(*)::text as count from public.transactions where id=$1 and status='reconciled'`,
          [txAtomic],
        )
      ).rows[0].count,
    ).toBe('0');
  });

  it.each(['completed', 'cancelled'] as const)(
    'returns 409 for %s reconciliation',
    async (status) => {
      const rec = id(status === 'completed' ? 6501 : 6502);
      await seedReconciliation(rec, status);
      expect((await complete(rec)).kind).toBe('already-final');
    },
  );

  it('returns 404 for a real reconciliation in another workspace', async () => {
    const rec = id(6601);
    await seedReconciliation(
      rec,
      'open',
      100,
      foreignWorkspace,
      foreignAccount,
    );
    expect(
      (
        await service.completeReconciliation(
          owner,
          workspace,
          rec,
          { transactionIds: [], createAdjustment: false },
          id(6602),
        )
      ).kind,
    ).toBe('not-found');
  });

  it('enforces adjustment constraints and creates one balanced reconciled transaction', async () => {
    const zero = id(6701);
    await seedReconciliation(zero, 'open', 0);
    expect((await complete(zero, [], { createAdjustment: true })).kind).toBe(
      'adjustment-invalid',
    );
    await admin.query('delete from public.reconciliations where id=$1', [zero]);
    const reason = id(6702);
    await seedReconciliation(reason);
    expect(
      (await complete(reason, [], { adjustmentReason: 'not allowed' })).kind,
    ).toBe('adjustment-invalid');
    await admin.query('delete from public.reconciliations where id=$1', [
      reason,
    ]);
    const good = id(6703);
    await seedReconciliation(good);
    const result = await complete(good, [], {
      createAdjustment: true,
      adjustmentReason: 'Statement correction',
    });
    expect(result.kind).toBe('completed');
    const rows = await admin.query(
      `select t.id,t.status,sum(lp.amount_minor)::text as total,count(lp.id)::text as legs from public.transactions t join public.ledger_postings lp on lp.transaction_id=t.id where t.account_id=$1 and t.type='adjustment' group by t.id,t.status`,
      [account],
    );
    expect(
      rows.rows.some(
        (row) =>
          row.status === 'reconciled' && row.total === '0' && row.legs === '2',
      ),
    ).toBe(true);
  });

  it('rejects an adjustment whose counter-leg overflows without persisting writes', async () => {
    const rec = id(6751);
    await seedReconciliation(rec, 'open', '-9223372036854775808');
    const beforeAdjustments = await admin.query(
      "select count(*)::text as count from public.transactions where account_id=$1 and type='adjustment'",
      [account],
    );
    const result = await complete(rec, [], { createAdjustment: true });
    expect(result.kind).toBe('amount-out-of-range');
    expect(
      (await admin.query("select status from public.reconciliations where id=$1", [rec])).rows[0].status,
    ).toBe('open');
    expect(
      (await admin.query("select count(*)::text as count from public.transactions where account_id=$1 and type='adjustment'", [account])).rows[0].count,
    ).toBe(beforeAdjustments.rows[0].count);
    expect(
      (await admin.query("select count(*)::text as count from public.transactions where id=$1 and status='reconciled'", [txConfirmed])).rows[0].count,
    ).toBe('0');
  });

  it('freezes snapshot values and replay leaves exactly one completion', async () => {
    const rec = id(6801);
    await seedReconciliation(rec);
    const snapshot = await admin.query(
      'select system_balance_minor::text,difference_minor::text from public.reconciliations where id=$1',
      [rec],
    );
    const key = id(6802);
    const first = await service.completeReconciliation(
      owner,
      workspace,
      rec,
      { transactionIds: [], createAdjustment: true },
      key,
    );
    const second = await service.completeReconciliation(
      owner,
      workspace,
      rec,
      { transactionIds: [], createAdjustment: true },
      key,
    );
    expect(first.kind).toBe('completed');
    expect(second.kind).toBe('replayed');
    expect(
      (
        await admin.query(
          "select count(*)::text as count from public.reconciliations where id=$1 and status='completed'",
          [rec],
        )
      ).rows[0].count,
    ).toBe('1');
    expect(
      (
        await admin.query(
          'select system_balance_minor::text,difference_minor::text from public.reconciliations where id=$1',
          [rec],
        )
      ).rows[0],
    ).toEqual(snapshot.rows[0]);
  });
});
