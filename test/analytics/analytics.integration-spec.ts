import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required for integration tests.');
}

describe('Analytics integration suite against disposable PostgreSQL', () => {
  let admin: Pool;
  let application: NestFastifyApplication;

  const ownerId = '11111111-0000-4000-8000-000000000001';
  const viewerId = '22222222-0000-4000-8000-000000000001';
  const otherOwnerId = '33333333-0000-4000-8000-000000000001';
  const nonMemberId = '44444444-0000-4000-8000-000000000001';

  const ws1Id = 'aaaaaaaa-0000-4000-8000-000000000001';
  const ws2Id = 'bbbbbbbb-0000-4000-8000-000000000001';

  const acctCheckingId = 'cccccccc-0000-4000-8000-000000000001';
  const acctSavingsId = 'cccccccc-0000-4000-8000-000000000002';
  const acctEurId = 'cccccccc-0000-4000-8000-000000000003';
  const acctClosedId = 'cccccccc-0000-4000-8000-000000000004';
  const acctWs2Id = 'dddddddd-0000-4000-8000-000000000001';

  const catGroceriesId = 'eeeeeeee-0000-4000-8000-000000000001';
  const catEntertainmentId = 'eeeeeeee-0000-4000-8000-000000000002';
  const catSalaryId = 'eeeeeeee-0000-4000-8000-000000000003';
  const catWs2Id = 'eeeeeeee-0000-4000-8000-000000000004';

  async function seedTransaction(options: {
    readonly id?: string;
    readonly workspaceId?: string;
    readonly accountId?: string;
    readonly type:
      | 'income'
      | 'expense'
      | 'refund'
      | 'adjustment'
      | 'debt_payment'
      | 'fund_contribution';
    readonly status?: 'confirmed' | 'pending' | 'voided';
    readonly amountMinor: number;
    readonly currency?: string;
    readonly occurredAt: string;
    readonly categoryId?: string | null;
    readonly createdBy?: string;
    readonly includeInAccountBalance?: boolean;
  }): Promise<string> {
    const txnId = options.id ?? randomUUID();
    const ws = options.workspaceId ?? ws1Id;
    const acct = options.accountId ?? acctCheckingId;
    const status = options.status ?? 'confirmed';
    const currency = options.currency ?? 'USD';
    const user = options.createdBy ?? ownerId;
    const voidedAt = status === 'voided' ? options.occurredAt : null;
    const postingAccount =
      options.includeInAccountBalance || ws !== ws1Id ? acct : acctClosedId;
    const postingAmount = options.type === 'refund' ? 0 : options.amountMinor;

    await admin.query(
      `insert into public.transactions (
        id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, category_id, voided_at, created_by
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10::timestamptz, $11)`,
      [
        txnId,
        ws,
        acct,
        options.type,
        status,
        options.amountMinor,
        currency,
        options.occurredAt,
        options.categoryId ?? null,
        voidedAt,
        user,
      ],
    );

    const postingStatus = status === 'voided' ? 'pending' : status;
    const leg1Id = randomUUID();
    const leg2Id = randomUUID();

    await admin.query(
      `insert into public.ledger_postings (
        id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at
      ) values
        ($1, $2, $3, $4, 'account', $5, $6, $7, $8::timestamptz),
        ($9, $2, $3, null, 'external', $10, $6, $7, $8::timestamptz)`,
      [
        leg1Id,
        ws,
        txnId,
        postingAccount,
        postingAmount,
        currency,
        postingStatus,
        options.occurredAt,
        leg2Id,
        -postingAmount,
      ],
    );

    return txnId;
  }

  async function seedTransfer(options: {
    readonly workspaceId?: string;
    readonly sourceAccountId: string;
    readonly destinationAccountId: string;
    readonly amountMinor: number;
    readonly currency?: string;
    readonly occurredAt: string;
    readonly createdBy?: string;
  }): Promise<string> {
    const transferId = randomUUID();
    const ws = options.workspaceId ?? ws1Id;
    const currency = options.currency ?? 'USD';
    const user = options.createdBy ?? ownerId;

    await admin.query(
      `insert into public.transfers (
        id, workspace_id, source_account_id, destination_account_id,
        source_amount_minor, source_currency, destination_amount_minor, destination_currency,
        occurred_at, status, created_by
      ) values ($1, $2, $3, $4, $5, $6, $5, $6, $7::timestamptz, 'confirmed', $8)`,
      [
        transferId,
        ws,
        options.sourceAccountId,
        options.destinationAccountId,
        options.amountMinor,
        currency,
        options.occurredAt,
        user,
      ],
    );

    const leg1Id = randomUUID();
    const leg2Id = randomUUID();

    await admin.query(
      `insert into public.ledger_postings (
        id, workspace_id, transfer_id, account_id, leg_kind, amount_minor, currency, status, occurred_at
      ) values
        ($1, $2, $3, $4, 'account', $5, $6, 'confirmed', $7::timestamptz),
        ($8, $2, $3, $9, 'account', $10, $6, 'confirmed', $7::timestamptz)`,
      [
        leg1Id,
        ws,
        transferId,
        options.sourceAccountId,
        -options.amountMinor,
        currency,
        options.occurredAt,
        leg2Id,
        options.destinationAccountId,
        options.amountMinor,
      ],
    );

    return transferId;
  }

  async function seedDebt(options: {
    readonly id?: string;
    readonly workspaceId?: string;
    readonly name: string;
    readonly principalMinor: number;
    readonly currency?: string;
    readonly status?: 'active' | 'paid' | 'defaulted' | 'archived';
    readonly createdBy?: string;
  }): Promise<string> {
    const debtId = options.id ?? randomUUID();
    const ws = options.workspaceId ?? ws1Id;
    const currency = options.currency ?? 'USD';
    const status = options.status ?? 'active';

    await admin.query(
      `insert into public.debts (
        id, workspace_id, name, currency, principal_minor, annual_rate, rate_type, status
      ) values ($1, $2, $3, $4, $5, '0.050000000000000000', 'fixed', $6)`,
      [debtId, ws, options.name, currency, options.principalMinor, status],
    );

    return debtId;
  }

  async function seedDebtPayment(options: {
    readonly debtId: string;
    readonly workspaceId?: string;
    readonly accountId?: string;
    readonly principalPaidMinor: number;
    readonly currency?: string;
    readonly occurredAt: string;
    readonly createdBy?: string;
  }): Promise<void> {
    const ws = options.workspaceId ?? ws1Id;
    const acct = options.accountId ?? acctCheckingId;
    const currency = options.currency ?? 'USD';
    const user = options.createdBy ?? ownerId;
    const paymentId = randomUUID();
    const txnId = randomUUID();

    await seedTransaction({
      id: txnId,
      workspaceId: ws,
      accountId: acct,
      type: 'debt_payment',
      amountMinor: options.principalPaidMinor,
      currency,
      occurredAt: options.occurredAt,
      createdBy: user,
    });

    await admin.query(
      `insert into public.debt_payments (
        id, workspace_id, debt_id, transaction_id, principal_minor, interest_minor, fee_minor, created_at
      ) values ($1, $2, $3, $4, $5, 0, 0, $6::timestamptz)`,
      [
        paymentId,
        ws,
        options.debtId,
        txnId,
        options.principalPaidMinor,
        options.occurredAt,
      ],
    );
  }

  async function seedBudgetAndAllocation(options: {
    readonly workspaceId?: string;
    readonly name: string;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly currency?: string;
    readonly categoryId: string;
    readonly plannedMinor: number;
    readonly createdBy?: string;
  }): Promise<{ budgetId: string; allocationId: string }> {
    const budgetId = randomUUID();
    const allocationId = randomUUID();
    const ws = options.workspaceId ?? ws1Id;
    const currency = options.currency ?? 'USD';
    const user = options.createdBy ?? ownerId;

    await admin.query(
      `insert into public.budgets (
        id, workspace_id, name, method, period_start, period_end, currency, created_by
      ) values ($1, $2, $3, 'envelope', $4::date, $5::date, $6, $7)`,
      [
        budgetId,
        ws,
        options.name,
        options.periodStart,
        options.periodEnd,
        currency,
        user,
      ],
    );

    await admin.query(
      `insert into public.budget_allocations (
        id, workspace_id, budget_id, category_id, planned_minor, rollover_policy
      ) values ($1, $2, $3, $4, $5, 'none')`,
      [allocationId, ws, budgetId, options.categoryId, options.plannedMinor],
    );

    return { budgetId, allocationId };
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
    });

    admin = new Pool({ connectionString: url });

    await admin.query(
      `insert into auth.users (id, email) values
        ($1, 'analytics-owner@example.test'),
        ($2, 'analytics-viewer@example.test'),
        ($3, 'analytics-other@example.test'),
        ($4, 'analytics-nonmember@example.test')`,
      [ownerId, viewerId, otherOwnerId, nonMemberId],
    );

    for (const [userId, email, name] of [
      [ownerId, 'analytics-owner@example.test', 'Analytics Owner'],
      [viewerId, 'analytics-viewer@example.test', 'Analytics Viewer'],
      [otherOwnerId, 'analytics-other@example.test', 'Analytics Other Owner'],
      [nonMemberId, 'analytics-nonmember@example.test', 'Analytics Non Member'],
    ] as const) {
      await admin.query(
        `insert into public.profiles (
          id, email, display_name, locale, country_code, timezone,
          date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled
        ) values (
          $1, $2, $3, 'en', 'US', 'UTC',
          'YYYY-MM-DD', 1, '1,234.56', 'USD', false
        )`,
        [userId, email, name],
      );
    }

    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by) values
        ($1, 'Analytics Workspace 1', 'shared', 'USD', null, $2),
        ($3, 'Analytics Workspace 2', 'shared', 'USD', null, $4)`,
      [ws1Id, ownerId, ws2Id, otherOwnerId],
    );

    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values
        ($1, $2, 'owner', 'active'),
        ($1, $3, 'viewer', 'active'),
        ($4, $5, 'owner', 'active')`,
      [ws1Id, ownerId, viewerId, ws2Id, otherOwnerId],
    );

    // Exchange rates must precede foreign-currency accounts
    await admin.query(
      `insert into public.exchange_rates (workspace_id, base_currency, quote_currency, rate, effective_at, source, created_by) values
        ($1, 'EUR', 'USD', 1.080000000000000000, now(), 'test', $2),
        ($1, 'USD', 'EUR', 0.920000000000000000, now(), 'test', $2)`,
      [ws1Id, ownerId],
    );

    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, closed_at, created_by) values
        ($1, $2, 'Checking Account', 'checking', 'USD', 'active', null, $3),
        ($4, $2, 'Savings Account', 'savings', 'USD', 'active', null, $3),
        ($5, $2, 'EUR Account', 'checking', 'EUR', 'active', null, $3),
        ($6, $2, 'Closed Account', 'checking', 'USD', 'closed', now(), $3),
        ($7, $8, 'WS2 Account', 'checking', 'USD', 'active', null, $9)`,
      [
        acctCheckingId,
        ws1Id,
        ownerId,
        acctSavingsId,
        acctEurId,
        acctClosedId,
        acctWs2Id,
        ws2Id,
        otherOwnerId,
      ],
    );

    await admin.query(
      `insert into public.categories (id, workspace_id, parent_id, name, kind, created_by) values
        ($1, $2, null, 'Groceries', 'expense', $3),
        ($4, $2, null, 'Entertainment', 'expense', $3),
        ($5, $2, null, 'Salary', 'income', $3),
        ($6, $7, null, 'Cross Category', 'expense', $8)`,
      [
        catGroceriesId,
        ws1Id,
        ownerId,
        catEntertainmentId,
        catSalaryId,
        catWs2Id,
        ws2Id,
        otherOwnerId,
      ],
    );

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: async (token: string) => {
          if (token === 'owner-token') return { subject: ownerId };
          if (token === 'viewer-token') return { subject: viewerId };
          if (token === 'other-owner-token') return { subject: otherOwnerId };
          if (token === 'non-member-token') return { subject: nonMemberId };
          throw new Error('token rejected');
        },
      })
      .compile();

    application = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(application);
    await application.init();
    await application.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await application?.close();
    await admin?.end();
  });

  it('1. summary with known seeded data returns exact expected values for every field', async () => {
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'income',
      amountMinor: 500000,
      currency: 'USD',
      occurredAt: '2026-05-01T00:00:00Z',
      includeInAccountBalance: true,
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctSavingsId,
      type: 'income',
      amountMinor: 300000,
      currency: 'USD',
      occurredAt: '2026-05-01T00:00:00Z',
      includeInAccountBalance: true,
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctEurId,
      type: 'income',
      amountMinor: 10000,
      currency: 'EUR',
      occurredAt: '2026-05-01T00:00:00Z',
      includeInAccountBalance: true,
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctClosedId,
      type: 'income',
      amountMinor: 999999,
      currency: 'USD',
      occurredAt: '2026-05-01T00:00:00Z',
    });

    const debt1Id = await seedDebt({
      name: 'Car Loan',
      principalMinor: 200000,
      currency: 'USD',
      status: 'active',
    });
    await seedDebtPayment({
      debtId: debt1Id,
      principalPaidMinor: 50000,
      currency: 'USD',
      occurredAt: '2026-05-15T00:00:00Z',
    });
    await seedDebt({
      name: 'Archived Debt',
      principalMinor: 999999,
      currency: 'USD',
      status: 'archived',
    });

    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'income',
      amountMinor: 400000,
      currency: 'USD',
      occurredAt: '2026-06-10T12:00:00Z',
      categoryId: catSalaryId,
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'expense',
      amountMinor: 150000,
      currency: 'USD',
      occurredAt: '2026-06-15T12:00:00Z',
      categoryId: catGroceriesId,
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'expense',
      amountMinor: 50000,
      currency: 'USD',
      occurredAt: '2026-06-20T12:00:00Z',
      categoryId: catEntertainmentId,
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'refund',
      amountMinor: 10000,
      currency: 'USD',
      occurredAt: '2026-06-22T12:00:00Z',
      categoryId: catGroceriesId,
    });

    await seedBudgetAndAllocation({
      name: 'June 2026 Budget',
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
      currency: 'USD',
      categoryId: catGroceriesId,
      plannedMinor: 200000,
    });

    const res = await application.inject({
      method: 'GET',
      url: '/v1/analytics/summary?from=2026-06-01&to=2026-06-30',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.periodStart).toBe('2026-06-01');
    expect(body.periodEnd).toBe('2026-06-30');
    expect(body.baseCurrency).toBe('USD');
    expect(body.netWorth).toEqual({ amountMinor: '660800', currency: 'USD' });
    expect(body.assets).toEqual({ amountMinor: '810800', currency: 'USD' });
    expect(body.debts).toEqual({ amountMinor: '150000', currency: 'USD' });
    expect(body.income).toEqual({ amountMinor: '400000', currency: 'USD' });
    expect(body.expenses).toEqual({ amountMinor: '190000', currency: 'USD' });
    expect(body.savingsCapacity).toEqual({
      amountMinor: '210000',
      currency: 'USD',
    });
    expect(body.budgetUtilizationPercent).toBe(75);
  });

  it('2. transfers do not inflate income or expenses', async () => {
    await seedTransfer({
      workspaceId: ws1Id,
      sourceAccountId: acctCheckingId,
      destinationAccountId: acctSavingsId,
      amountMinor: 1000000,
      currency: 'USD',
      occurredAt: '2026-06-15T15:00:00Z',
    });

    const res = await application.inject({
      method: 'GET',
      url: '/v1/analytics/summary?from=2026-06-01&to=2026-06-30',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.income).toEqual({ amountMinor: '400000', currency: 'USD' });
    expect(body.expenses).toEqual({ amountMinor: '190000', currency: 'USD' });
    expect(body.savingsCapacity).toEqual({
      amountMinor: '210000',
      currency: 'USD',
    });
  });

  it('3. refund reduces expenses; adjustment, debt_payment and fund_contribution are excluded', async () => {
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'income',
      amountMinor: 100000,
      currency: 'USD',
      occurredAt: '2026-07-05T10:00:00Z',
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'expense',
      amountMinor: 50000,
      currency: 'USD',
      occurredAt: '2026-07-10T10:00:00Z',
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'refund',
      amountMinor: 20000,
      currency: 'USD',
      occurredAt: '2026-07-12T10:00:00Z',
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'adjustment',
      amountMinor: 100000,
      currency: 'USD',
      occurredAt: '2026-07-15T10:00:00Z',
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'debt_payment',
      amountMinor: 100000,
      currency: 'USD',
      occurredAt: '2026-07-16T10:00:00Z',
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'fund_contribution',
      amountMinor: 100000,
      currency: 'USD',
      occurredAt: '2026-07-17T10:00:00Z',
    });

    const res = await application.inject({
      method: 'GET',
      url: '/v1/analytics/summary?from=2026-07-01&to=2026-07-31',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.income).toEqual({ amountMinor: '100000', currency: 'USD' });
    expect(body.expenses).toEqual({ amountMinor: '30000', currency: 'USD' });
    expect(body.savingsCapacity).toEqual({
      amountMinor: '70000',
      currency: 'USD',
    });
  });

  it('3a. refunds exceeding expenses remain negative and preserve exact savings capacity', async () => {
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'income',
      amountMinor: 30000,
      currency: 'USD',
      occurredAt: '2027-04-05T10:00:00Z',
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'expense',
      amountMinor: 10000,
      currency: 'USD',
      occurredAt: '2027-04-10T10:00:00Z',
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'refund',
      amountMinor: 20000,
      currency: 'USD',
      occurredAt: '2027-04-15T10:00:00Z',
    });

    const res = await application.inject({
      method: 'GET',
      url: '/v1/analytics/summary?from=2027-04-01&to=2027-04-30',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.expenses).toEqual({ amountMinor: '-10000', currency: 'USD' });
    expect(body.savingsCapacity.amountMinor).toBe(
      (
        BigInt(body.income.amountMinor) - BigInt(body.expenses.amountMinor)
      ).toString(),
    );
  });

  it('4. pending or voided posting does not contribute to any aggregate', async () => {
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'income',
      status: 'pending',
      amountMinor: 500000,
      currency: 'USD',
      occurredAt: '2026-08-10T10:00:00Z',
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'expense',
      status: 'voided',
      amountMinor: 300000,
      currency: 'USD',
      occurredAt: '2026-08-15T10:00:00Z',
    });

    const res = await application.inject({
      method: 'GET',
      url: '/v1/analytics/summary?from=2026-08-01&to=2026-08-31',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.income).toEqual({ amountMinor: '0', currency: 'USD' });
    expect(body.expenses).toEqual({ amountMinor: '0', currency: 'USD' });
    expect(body.savingsCapacity).toEqual({
      amountMinor: '0',
      currency: 'USD',
    });
  });

  it('5. cross-workspace data does not contribute to aggregates', async () => {
    await seedTransaction({
      workspaceId: ws2Id,
      accountId: acctWs2Id,
      type: 'income',
      amountMinor: 999999999,
      currency: 'USD',
      occurredAt: '2026-06-10T10:00:00Z',
      categoryId: catWs2Id,
      createdBy: otherOwnerId,
    });
    await seedTransaction({
      workspaceId: ws2Id,
      accountId: acctWs2Id,
      type: 'expense',
      amountMinor: 888888888,
      currency: 'USD',
      occurredAt: '2026-06-15T10:00:00Z',
      categoryId: catWs2Id,
      createdBy: otherOwnerId,
    });
    await seedDebt({
      workspaceId: ws2Id,
      name: 'WS2 Huge Debt',
      principalMinor: 777777777,
      currency: 'USD',
      createdBy: otherOwnerId,
    });

    const res = await application.inject({
      method: 'GET',
      url: '/v1/analytics/summary?from=2026-06-01&to=2026-06-30',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.income).toEqual({ amountMinor: '400000', currency: 'USD' });
    expect(body.expenses).toEqual({ amountMinor: '190000', currency: 'USD' });
    expect(body.debts).toEqual({ amountMinor: '150000', currency: 'USD' });
  });

  it('6. presentationCurrency converts correctly with exact values', async () => {
    await seedTransfer({
      workspaceId: ws1Id,
      sourceAccountId: acctCheckingId,
      destinationAccountId: acctSavingsId,
      amountMinor: 1000000,
      currency: 'USD',
      occurredAt: '2026-06-25T15:00:00Z',
    });

    const res = await application.inject({
      method: 'GET',
      url: '/v1/analytics/summary?from=2026-06-01&to=2026-06-30&presentationCurrency=EUR',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.baseCurrency).toBe('EUR');
    expect(body.income).toEqual({ amountMinor: '368000', currency: 'EUR' });
    expect(body.expenses).toEqual({ amountMinor: '174800', currency: 'EUR' });
    expect(body.savingsCapacity).toEqual({
      amountMinor: '193200',
      currency: 'EUR',
    });
    expect(body.assets).toEqual({ amountMinor: '746000', currency: 'EUR' });
    expect(body.debts).toEqual({ amountMinor: '138000', currency: 'EUR' });
    expect(body.netWorth).toEqual({ amountMinor: '608000', currency: 'EUR' });
  });

  it('7. missing exchange rate returns 400 naming the pair instead of 500', async () => {
    const res = await application.inject({
      method: 'GET',
      url: '/v1/analytics/summary?from=2026-06-01&to=2026-06-30&presentationCurrency=GBP',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe(400);
    expect(body.title).toBe('Missing exchange rate');
    expect(body.detail).toContain('GBP');
  });

  it('8. budgetUtilizationPercent is omitted when total planned is zero', async () => {
    const res = await application.inject({
      method: 'GET',
      url: '/v1/analytics/summary?from=2026-10-01&to=2026-10-31',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.budgetUtilizationPercent).toBeUndefined();
    expect('budgetUtilizationPercent' in body).toBe(false);
  });

  it('9. cash-flow at each granularity produces expected bucket count and boundaries', async () => {
    const monthRes = await application.inject({
      method: 'GET',
      url: '/v1/analytics/cash-flow?from=2026-01-01&to=2026-03-31&granularity=month',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });
    expect(monthRes.statusCode).toBe(200);
    const monthBody = JSON.parse(monthRes.payload);
    expect(monthBody.series).toHaveLength(3);
    expect(monthBody.series.map((s: { period: string }) => s.period)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ]);

    const quarterRes = await application.inject({
      method: 'GET',
      url: '/v1/analytics/cash-flow?from=2026-01-01&to=2026-03-31&granularity=quarter',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });
    expect(quarterRes.statusCode).toBe(200);
    const quarterBody = JSON.parse(quarterRes.payload);
    expect(quarterBody.series).toHaveLength(1);
    expect(quarterBody.series[0].period).toBe('2026-01-01');

    const dayRes = await application.inject({
      method: 'GET',
      url: '/v1/analytics/cash-flow?from=2026-01-01&to=2026-01-07&granularity=day',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });
    expect(dayRes.statusCode).toBe(200);
    const dayBody = JSON.parse(dayRes.payload);
    expect(dayBody.series).toHaveLength(7);
    expect(dayBody.series[0].period).toBe('2026-01-01');
    expect(dayBody.series[6].period).toBe('2026-01-07');

    const weekRes = await application.inject({
      method: 'GET',
      url: '/v1/analytics/cash-flow?from=2026-01-05&to=2026-01-25&granularity=week',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });
    expect(weekRes.statusCode).toBe(200);
    const weekBody = JSON.parse(weekRes.payload);
    expect(weekBody.series).toHaveLength(3);
    expect(weekBody.series.map((s: { period: string }) => s.period)).toEqual([
      '2026-01-05',
      '2026-01-12',
      '2026-01-19',
    ]);
  });

  it('9a. week buckets align to UTC Mondays for a period starting mid-week', async () => {
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'income',
      amountMinor: 100,
      occurredAt: '2026-04-08T12:00:00Z',
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'expense',
      amountMinor: 30,
      occurredAt: '2026-04-15T12:00:00Z',
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'refund',
      amountMinor: 20,
      occurredAt: '2026-04-29T12:00:00Z',
    });

    const res = await application.inject({
      method: 'GET',
      url: '/v1/analytics/cash-flow?from=2026-04-08&to=2026-04-29&granularity=week',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.series).toEqual([
      {
        period: '2026-04-06',
        value: { amountMinor: '100', currency: 'USD' },
        secondaryValue: { amountMinor: '100', currency: 'USD' },
      },
      {
        period: '2026-04-13',
        value: { amountMinor: '-30', currency: 'USD' },
        secondaryValue: { amountMinor: '70', currency: 'USD' },
      },
      {
        period: '2026-04-20',
        value: { amountMinor: '0', currency: 'USD' },
        secondaryValue: { amountMinor: '70', currency: 'USD' },
      },
      {
        period: '2026-04-27',
        value: { amountMinor: '20', currency: 'USD' },
        secondaryValue: { amountMinor: '90', currency: 'USD' },
      },
    ]);
    expect(body.series).toHaveLength(4);
    expect(body.series[0].period).toBe('2026-04-06');
    expect(body.series[3].period).toBe('2026-04-27');
  });

  it('9b. quarter buckets align to UTC quarter starts for a period starting mid-quarter', async () => {
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'income',
      amountMinor: 100,
      occurredAt: '2028-02-15T12:00:00Z',
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'expense',
      amountMinor: 40,
      occurredAt: '2028-05-10T12:00:00Z',
    });

    const res = await application.inject({
      method: 'GET',
      url: '/v1/analytics/cash-flow?from=2028-02-10&to=2028-08-20&granularity=quarter',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.series).toEqual([
      {
        period: '2028-01-01',
        value: { amountMinor: '100', currency: 'USD' },
        secondaryValue: { amountMinor: '100', currency: 'USD' },
      },
      {
        period: '2028-04-01',
        value: { amountMinor: '-40', currency: 'USD' },
        secondaryValue: { amountMinor: '60', currency: 'USD' },
      },
      {
        period: '2028-07-01',
        value: { amountMinor: '0', currency: 'USD' },
        secondaryValue: { amountMinor: '60', currency: 'USD' },
      },
    ]);
    expect(body.series).toHaveLength(3);
    expect(body.series[0].period).toBe('2028-01-01');
    expect(body.series[2].period).toBe('2028-07-01');
  });

  it('10. empty buckets appear with zero values (gap-free series)', async () => {
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'income',
      amountMinor: 200000,
      currency: 'USD',
      occurredAt: '2026-11-15T12:00:00Z',
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'expense',
      amountMinor: 50000,
      currency: 'USD',
      occurredAt: '2027-01-15T12:00:00Z',
    });

    const res = await application.inject({
      method: 'GET',
      url: '/v1/analytics/cash-flow?from=2026-11-01&to=2027-01-31&granularity=month',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.series).toHaveLength(3);
    expect(body.series[0]).toEqual({
      period: '2026-11-01',
      value: { amountMinor: '200000', currency: 'USD' },
      secondaryValue: { amountMinor: '200000', currency: 'USD' },
    });
    expect(body.series[1]).toEqual({
      period: '2026-12-01',
      value: { amountMinor: '0', currency: 'USD' },
      secondaryValue: { amountMinor: '200000', currency: 'USD' },
    });
    expect(body.series[2]).toEqual({
      period: '2027-01-01',
      value: { amountMinor: '-50000', currency: 'USD' },
      secondaryValue: { amountMinor: '150000', currency: 'USD' },
    });
  });

  it('11. secondaryValue is the correct running cumulative total across positive, zero, and negative flows', async () => {
    const res = await application.inject({
      method: 'GET',
      url: '/v1/analytics/cash-flow?from=2026-11-01&to=2027-01-31&granularity=month',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.series[0].secondaryValue.amountMinor).toBe('200000');
    expect(body.series[1].secondaryValue.amountMinor).toBe('200000');
    expect(body.series[2].secondaryValue.amountMinor).toBe('150000');
  });

  it('12. category percentages use total expenses including uncategorised spending; empty array when no expenses', async () => {
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'expense',
      amountMinor: 60000,
      currency: 'USD',
      occurredAt: '2027-02-05T12:00:00Z',
      categoryId: catGroceriesId,
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'expense',
      amountMinor: 40000,
      currency: 'USD',
      occurredAt: '2027-02-10T12:00:00Z',
      categoryId: catEntertainmentId,
    });
    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'expense',
      amountMinor: 20000,
      currency: 'USD',
      occurredAt: '2027-02-15T12:00:00Z',
      categoryId: null,
    });

    const res = await application.inject({
      method: 'GET',
      url: '/v1/analytics/cash-flow?from=2027-02-01&to=2027-02-28',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.categories).toHaveLength(2);

    const groceries = body.categories.find(
      (c: { categoryId: string }) => c.categoryId === catGroceriesId,
    );
    const entertainment = body.categories.find(
      (c: { categoryId: string }) => c.categoryId === catEntertainmentId,
    );

    expect(groceries).toBeDefined();
    expect(entertainment).toBeDefined();
    expect(groceries.amount).toEqual({
      amountMinor: '60000',
      currency: 'USD',
    });
    expect(entertainment.amount).toEqual({
      amountMinor: '40000',
      currency: 'USD',
    });

    expect(groceries.percentage).toBe(50);
    expect(entertainment.percentage).toBeCloseTo(33.333333, 4);
    const uncategorisedRemainder =
      100 - groceries.percentage - entertainment.percentage;
    expect(
      groceries.percentage + entertainment.percentage + uncategorisedRemainder,
    ).toBeCloseTo(100, 4);

    await seedTransaction({
      workspaceId: ws1Id,
      accountId: acctCheckingId,
      type: 'income',
      amountMinor: 50000,
      currency: 'USD',
      occurredAt: '2027-03-05T12:00:00Z',
    });

    const zeroExpensesRes = await application.inject({
      method: 'GET',
      url: '/v1/analytics/cash-flow?from=2027-03-01&to=2027-03-31',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });

    expect(zeroExpensesRes.statusCode).toBe(200);
    const zeroExpensesBody = JSON.parse(zeroExpensesRes.payload);
    expect(zeroExpensesBody.categories).toEqual([]);
  });

  it('13. invalid query parameters return 400 Problem Details', async () => {
    const reversedDatesRes = await application.inject({
      method: 'GET',
      url: '/v1/analytics/summary?from=2026-06-30&to=2026-06-01',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });
    expect(reversedDatesRes.statusCode).toBe(400);
    expect(JSON.parse(reversedDatesRes.payload).title).toBe(
      'Invalid analytics summary query',
    );

    const malformedDateRes = await application.inject({
      method: 'GET',
      url: '/v1/analytics/summary?from=invalid-date&to=2026-06-30',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });
    expect(malformedDateRes.statusCode).toBe(400);

    const unknownGranularityRes = await application.inject({
      method: 'GET',
      url: '/v1/analytics/cash-flow?from=2026-06-01&to=2026-06-30&granularity=yearly',
      headers: {
        authorization: 'Bearer owner-token',
        'x-workspace-id': ws1Id,
      },
    });
    expect(unknownGranularityRes.statusCode).toBe(400);
  });

  it('L16 cash flow clips UTC year buckets, matches any ID in each dimension, and uses historical FX', async () => {
    const payeeId = randomUUID();
    const tagId = randomUUID();
    const {
      rows: [member],
    } = await admin.query<{ id: string }>(
      `select id from public.workspace_memberships where workspace_id = $1 and profile_id = $2`,
      [ws1Id, ownerId],
    );
    await admin.query(
      `insert into public.payees (id, workspace_id, name, created_by) values ($1, $2, 'L16 payee', $3)`,
      [payeeId, ws1Id, ownerId],
    );
    await admin.query(
      `insert into public.tags (id, workspace_id, name, created_by) values ($1, $2, 'L16 tag', $3)`,
      [tagId, ws1Id, ownerId],
    );
    await admin.query(
      `insert into public.exchange_rates (workspace_id, base_currency, quote_currency, rate, effective_at, source, created_by)
       values ($1, 'USD', 'CAD', 1.5, '2024-12-30', 'manual', $2),
              ($1, 'USD', 'CAD', 2, '2025-02-01', 'manual', $2)`,
      [ws1Id, ownerId],
    );
    for (const [occurredAt, accountId, amountMinor] of [
      ['2024-12-31T00:30:00+01:00', acctCheckingId, 999],
      ['2024-12-31T23:59:59Z', acctCheckingId, 101],
      ['2025-01-01T00:00:00Z', acctCheckingId, 20],
      ['2025-01-01T00:00:01Z', acctSavingsId, 999],
      ['2025-01-02T00:00:00Z', acctCheckingId, 999],
    ] as const) {
      const id = await seedTransaction({
        type: 'expense',
        occurredAt,
        accountId,
        amountMinor,
        categoryId: catGroceriesId,
      });
      await admin.query(
        'update public.transactions set payee_id = $2, tag_ids = array[$3::uuid] where id = $1',
        [id, payeeId, tagId],
      );
    }
    await seedTransaction({
      type: 'expense',
      occurredAt: '2025-01-01T01:00Z',
      amountMinor: 999,
      categoryId: catGroceriesId,
    });
    const query = new URLSearchParams({
      from: '2024-12-31',
      to: '2025-01-01',
      granularity: 'year',
      presentationCurrency: 'CAD',
      accountIds: acctCheckingId,
      categoryIds: catGroceriesId,
      tagIds: tagId,
      payeeIds: payeeId,
      memberIds: member.id,
    });
    query.append('accountIds', acctWs2Id);
    const inject = () =>
      application.inject({
        method: 'GET',
        url: `/v1/analytics/cash-flow?${query}`,
        headers: {
          authorization: 'Bearer viewer-token',
          'x-workspace-id': ws1Id,
        },
      });
    const money = (amountMinor: string) => ({ amountMinor, currency: 'CAD' });
    const response = await inject();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      fxRatesUsed: [
        {
          baseCurrency: 'USD',
          quoteCurrency: 'CAD',
          rate: '1.5',
          rateDate: '2024-12-30',
          source: 'manual',
          freshness: 'fresh',
        },
      ],
      series: [
        {
          period: '2024-01-01',
          value: money('-152'),
          secondaryValue: money('-152'),
        },
        {
          period: '2025-01-01',
          value: money('-30'),
          secondaryValue: money('-182'),
        },
      ],
      categories: [
        {
          categoryId: catGroceriesId,
          categoryName: 'Groceries',
          amount: money('182'),
          percentage: 100,
        },
      ],
    });
    for (const dimension of [
      'accountIds',
      'categoryIds',
      'tagIds',
      'payeeIds',
      'memberIds',
    ]) {
      const previous = query.getAll(dimension);
      query.set(dimension, randomUUID());
      const unmatched = await inject();
      expect(unmatched.statusCode).toBe(200);
      expect(unmatched.json()).toEqual({
        series: ['2024-01-01', '2025-01-01'].map((period) => ({
          period,
          value: money('0'),
          secondaryValue: money('0'),
        })),
        categories: [],
      });
      query.delete(dimension);
      previous.forEach((id) => query.append(dimension, id));
    }
    query.append('accountIds', acctCheckingId.toUpperCase());
    const duplicate = await inject();
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toMatchObject({
      title: 'Invalid cash flow analytics query',
      status: 400,
      errors: [
        {
          field: 'accountIds',
          code: 'invalid',
          message: 'accountIds must contain unique UUIDs.',
        },
      ],
    });
  });

  it('202609170034_l16_analytics.sql defaults classification flags and excludes flagged bookings', async () => {
    const id = await seedTransaction({
      type: 'expense',
      amountMinor: 71,
      categoryId: catGroceriesId,
      occurredAt: '2025-06-01T00:00Z',
      includeInAccountBalance: true,
    });
    const { rows } = await admin.query(
      `select to_jsonb(t)->'extraordinary' as extraordinary,
              to_jsonb(t)->'excluded_from_reports' as excluded,
              to_jsonb(c)->'essential' as essential
         from public.transactions t join public.categories c on c.id = t.category_id
        where t.id = $1`,
      [id],
    );
    expect(rows).toEqual([
      { extraordinary: false, excluded: false, essential: false },
    ]);
    const read = async (path: string) => {
      const response = await application.inject({
        method: 'GET',
        url: `/v1/analytics/${path}?from=2025-06-01&to=2025-06-01`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': ws1Id,
        },
      });
      expect(response.statusCode).toBe(200);
      return response.json();
    };
    expect((await read('cash-flow')).series[0].value.amountMinor).toBe('-71');
    await admin.query(
      'update public.transactions set excluded_from_reports = true where id = $1',
      [id],
    );
    expect(await read('cash-flow')).toEqual({
      categories: [],
      series: [
        {
          period: '2025-06-01',
          value: { amountMinor: '0', currency: 'USD' },
          secondaryValue: { amountMinor: '0', currency: 'USD' },
        },
      ],
    });
    expect((await read('summary')).expenses.amountMinor).toBe('0');
  });

  async function advanced(metric: string, params: Record<string, string> = {}) {
    const query = new URLSearchParams({ metric, ...params });
    const response = await application.inject({
      method: 'GET',
      url: `/v1/analytics/advanced?${query}`,
      headers: {
        authorization: 'Bearer viewer-token',
        'x-workspace-id': ws1Id,
      },
    });
    expect(response.statusCode, response.payload).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      metric,
      generatedAt: expect.any(String),
      currency: expect.any(String),
      assumptions: expect.any(Array),
      missingData: expect.any(Array),
      data: expect.any(Object),
    });
    return body;
  }

  it('L16 returns median, income trend, source shares and UTC refund-adjusted spending cells', async () => {
    const source = randomUUID();
    await admin.query(
      `insert into public.payees (id, workspace_id, name, created_by) values ($1, $2, 'L16 income source', $3)`,
      [source, ws1Id, ownerId],
    );
    const income = await seedTransaction({
      type: 'income',
      amountMinor: 100,
      occurredAt: '2024-03-05T00:00Z',
    });
    await admin.query(
      'update public.transactions set payee_id = $2 where id = $1',
      [income, source],
    );
    await seedTransaction({
      type: 'income',
      amountMinor: 300,
      occurredAt: '2024-05-05T00:00Z',
    });
    await seedTransaction({
      type: 'expense',
      amountMinor: 40,
      occurredAt: '2024-04-03T01:00Z',
    });
    await seedTransaction({
      type: 'refund',
      amountMinor: 12,
      occurredAt: '2024-04-02T21:00:00-03:00',
    });
    const range = {
      from: '2024-03-03',
      to: '2024-05-31',
      accountIds: acctCheckingId,
    };
    const stability = await advanced('income_stability', range);
    expect(stability.data).toEqual({
      monthsCounted: 3,
      meanMonthlyIncomeMinor: '133',
      minMonthlyIncomeMinor: '0',
      maxMonthlyIncomeMinor: '300',
      coefficientOfVariationPercent: 93.54,
      medianMonthlyIncomeMinor: '100',
      trendPercent: 200,
      regularityPercent: 66.67,
      sourceConcentration: [
        {
          payeeId: null,
          amount: { amountMinor: '300', currency: 'USD' },
          sharePercent: 75,
        },
        {
          payeeId: source,
          amount: { amountMinor: '100', currency: 'USD' },
          sharePercent: 25,
        },
      ],
    });
    expect(stability.assumptions.join(' ')).toMatch(
      /partial.*UTC|UTC.*partial/i,
    );
    const spending = await advanced('spending_heatmap', range);
    expect(spending.data).toEqual({
      cells: [
        {
          weekday: 3,
          dayOfMonth: 3,
          amount: { amountMinor: '28', currency: 'USD' },
          count: 2,
        },
      ],
    });
    const missing = await advanced('spending_heatmap', {
      ...range,
      presentationCurrency: 'GBP',
    });
    expect(missing.data).toEqual({ cells: [] });
    expect(missing.missingData.join(' ')).toMatch(/USD.*GBP/);
  });

  it('L16 annualizes active subscriptions exactly, labels unknown frequency, and emits native prices', async () => {
    const monthly = randomUUID();
    const unknown = randomUUID();
    await admin.query(
      `insert into public.subscriptions (id, workspace_id, payee_name, current_amount_minor, current_currency, previous_amount_minor, previous_currency, frequency, next_expected_at, status, created_by)
       values ($1,$3,'L16 monthly',101,'USD',100,'USD','monthly','2025-08-05','detected',$4),
              ($2,$3,'L16 unknown',300,'USD',null,null,'unknown',null,'confirmed',$4)`,
      [monthly, unknown, ws1Id, ownerId],
    );
    const { data, missingData } = await advanced('subscription_annual_cost');
    expect(data).toEqual({
      items: [
        {
          subscriptionId: monthly,
          payeeName: 'L16 monthly',
          currentAmount: { amountMinor: '101', currency: 'USD' },
          previousAmount: { amountMinor: '100', currency: 'USD' },
          increasePercent: 1,
          frequency: 'monthly',
          nextExpectedDate: '2025-08-05',
          annualCost: { amountMinor: '1212', currency: 'USD' },
        },
        {
          subscriptionId: unknown,
          payeeName: 'L16 unknown',
          currentAmount: { amountMinor: '300', currency: 'USD' },
          frequency: 'unknown',
          annualCost: null,
        },
      ],
      totalAnnualCost: { amountMinor: '1212', currency: 'USD' },
    });
    expect(missingData.join(' ')).toMatch(/frequency/i);
  });

  it('L16 calendar separates actual income from scheduled income, instalments, funds and reminders', async () => {
    const day = '2027-10-05';
    const actual = await seedTransaction({
      type: 'income',
      amountMinor: 72,
      occurredAt: `${day}T00:00Z`,
    });
    const debt = await seedDebt({
      name: 'L16 instalment',
      principalMinor: 200,
    });
    await admin.query(
      'update public.debts set term_months = 3, minimum_payment_minor = 45, next_payment_at = $2 where id = $1',
      [debt, day],
    );
    const events = [];
    for (const [type, behavior, amount, name] of [
      ['income', 'confirm_automatically', 95, 'L16 salary'],
      ['fund_contribution', 'create_pending', 25, 'L16 fund'],
      ['expense', 'remind', 30, 'L16 reminder'],
    ] as const) {
      const id = randomUUID();
      await admin.query(
        `insert into public.recurring_rules (id, workspace_id, name, frequency, behavior, account_id, template, starts_at, next_occurrence_at, anchor_day_of_month, created_by)
        values ($1,$2,$3,'monthly',$4,$5,$6,'2027-10-01',$7,5,$8)`,
        [
          id,
          ws1Id,
          name,
          behavior,
          acctCheckingId,
          JSON.stringify({
            type,
            amount: { amountMinor: String(amount), currency: 'USD' },
          }),
          day,
          ownerId,
        ],
      );
      events.push(id);
    }
    const { data } = await advanced('financial_calendar', {
      from: day,
      to: day,
    });
    expect(data).toMatchObject({
      periodStart: day,
      periodEnd: day,
      totalExpectedOutflowMinor: '70',
      totalExpectedInflowMinor: '95',
      recurringRulesWithUnreadableTemplate: 0,
    });
    expect(data.days).toEqual([
      {
        date: day,
        expectedOutflowMinor: '70',
        expectedInflowMinor: '95',
        items: [
          {
            kind: 'fund_contribution',
            refId: events[1],
            label: 'L16 fund',
            amountMinor: '25',
            state: 'scheduled',
            direction: 'outflow',
          },
          {
            kind: 'income',
            refId: actual,
            label: 'Income',
            amountMinor: '72',
            state: 'actual',
            direction: 'inflow',
          },
          {
            kind: 'income',
            refId: events[0],
            label: 'L16 salary',
            amountMinor: '95',
            state: 'scheduled',
            direction: 'inflow',
          },
          {
            kind: 'installment',
            refId: debt,
            label: 'L16 instalment',
            amountMinor: '45',
            state: 'scheduled',
            direction: 'outflow',
          },
          {
            kind: 'reminder',
            refId: events[2],
            label: 'L16 reminder',
            amountMinor: null,
            state: 'scheduled',
            direction: 'none',
          },
        ].sort(
          (a, b) =>
            a.kind.localeCompare(b.kind) || a.refId.localeCompare(b.refId),
        ),
      },
    ]);
  });

  it('L16 net worth values recorded balances at the UTC cut and discloses unknown FX instead of replaying future rates', async () => {
    const id = randomUUID();
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, created_by, created_at) values ($1,$2,'L16 historical asset','checking','EUR',$3,'2024-01-01')`,
      [id, ws1Id, ownerId],
    );
    await seedTransaction({
      type: 'income',
      accountId: id,
      amountMinor: 100,
      currency: 'EUR',
      occurredAt: '2024-01-02T00:00Z',
      includeInAccountBalance: true,
    });
    await admin.query(
      `insert into public.exchange_rates (workspace_id, base_currency, quote_currency, rate, effective_at, source, created_by)
       values ($1,'EUR','USD',1.2,'2024-02-01','manual',$2), ($1,'EUR','USD',1.4,'2024-03-01','manual',$2)`,
      [ws1Id, ownerId],
    );
    await seedTransaction({
      type: 'income',
      accountId: id,
      amountMinor: 100,
      currency: 'EUR',
      occurredAt: '2024-03-17T18:00Z',
      includeInAccountBalance: true,
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2024-03-17T12:00Z'));
    const { data, missingData } = await advanced('net_worth_history', {
      from: '2023-12-01',
      to: '2024-03-17',
      accountIds: id,
    }).finally(() => vi.useRealTimers());
    const usd = (amountMinor: string) => ({ amountMinor, currency: 'USD' });
    expect(data).toEqual({
      series: [
        {
          date: '2024-02-29',
          assets: usd('120'),
          debts: usd('0'),
          netWorth: usd('120'),
          fxValuationChange: null,
        },
        {
          date: '2024-03-17',
          assets: usd('140'),
          debts: usd('0'),
          netWorth: usd('140'),
          fxValuationChange: usd('20'),
        },
      ],
    });
    expect(missingData.join(' ')).toMatch(/EUR.*USD.*2024-01-31/);
  });

  it('L16 savings separates essential, discretionary, extraordinary, debt and contributed savings', async () => {
    const range = {
      from: '2024-06-01',
      to: '2024-06-30',
      accountIds: acctCheckingId,
    };
    await admin.query(
      'update public.categories set essential = true where id = $1',
      [catGroceriesId],
    );
    for (const [type, amountMinor, categoryId] of [
      ['income', 100, null],
      ['expense', 24, catGroceriesId],
      ['expense', 12, null],
      ['debt_payment', 11, null],
      ['fund_contribution', 7, null],
    ] as const) {
      await seedTransaction({
        type,
        amountMinor,
        categoryId,
        occurredAt: '2024-06-02T00:00Z',
      });
    }
    const extraordinary = await seedTransaction({
      type: 'expense',
      amountMinor: 15,
      occurredAt: '2024-06-02T00:00Z',
    });
    await admin.query(
      'update public.transactions set extraordinary = true where id = $1',
      [extraordinary],
    );
    const { data, missingData } = await advanced(
      'monthly_savings_capacity',
      range,
    );
    expect(data).toEqual({
      series: [
        {
          month: '2024-06-01',
          incomeMinor: '100',
          expensesMinor: '51',
          savingsCapacityMinor: '38',
          recurringIncomeMinor: '0',
          essentialExpensesMinor: '24',
          discretionaryExpensesMinor: '12',
          obligationsMinor: '11',
          currentSavingsMinor: '7',
        },
      ],
    });
    expect(missingData.join(' ')).toMatch(/recurr/i);
  });

  it('L16 debt evolution separates principal, interest and fees and labels unknown outlook', async () => {
    const known = await seedDebt({
      name: 'L16 modeled debt',
      principalMinor: 240,
    });
    const unknown = await seedDebt({
      name: 'L16 unmodeled debt',
      principalMinor: 120,
    });
    await admin.query(
      `update public.debts set minimum_payment_minor = 100, annual_rate = 0.12, created_at = '2024-07-01' where id = $1`,
      [known],
    );
    await admin.query(
      `update public.debts set created_at = '2024-07-01' where id = $1`,
      [unknown],
    );
    const id = await seedTransaction({
      type: 'debt_payment',
      amountMinor: 48,
      occurredAt: '2024-07-06T00:00Z',
    });
    await admin.query(
      `insert into public.debt_payments (workspace_id, debt_id, transaction_id, principal_minor, interest_minor, fee_minor) values ($1, $2, $3, 40, 5, 3)`,
      [ws1Id, known, id],
    );
    const { data, missingData } = await advanced('debt_cost_evolution', {
      from: '2024-07-01',
      to: '2024-07-31',
    });
    expect(data).toMatchObject({
      totalInterestMinor: '5',
      totalFeeMinor: '3',
      totalCostMinor: '8',
      series: [
        {
          month: '2024-07-01',
          principalPaidMinor: '40',
          paymentsMinor: '48',
          interestMinor: '5',
          feeMinor: '3',
          totalCostMinor: '8',
        },
      ],
      debtOutlook: expect.arrayContaining([
        {
          debtId: known,
          estimatedFutureCost: { amountMinor: '3', currency: 'USD' },
          estimatedRemainingMonths: 3,
        },
        {
          debtId: unknown,
          estimatedFutureCost: null,
          estimatedRemainingMonths: null,
        },
      ]),
    });
    expect(missingData.join(' ')).toContain(unknown);
  });

  it('L17 lists distinct exact rates actually applied by summary, cash flow and advanced analytics', async () => {
    await admin.query(
      `insert into public.exchange_rates (workspace_id, base_currency, quote_currency, rate, effective_at, source, manual, created_by)
      values ($1, 'USD', 'GBP', 0.999999999999999999, '2024-06-01', 'manual', true, $2),
             ($1, 'USD', 'GBP', 1.200000000000000001, '2024-06-05', 'frankfurter', false, null),
             ($1, 'USD', 'GBP', 1.5, '2024-06-12', 'vendor', false, $2),
             ($1, 'USD', 'GBP', 8, '2024-06-30', 'frankfurter', false, null)`,
      [ws2Id, otherOwnerId],
    );
    for (const day of [3, 4, 5, 9, 15]) {
      await seedTransaction({
        workspaceId: ws2Id,
        accountId: acctWs2Id,
        createdBy: otherOwnerId,
        type: 'expense',
        amountMinor: 100,
        occurredAt: `2024-06-${String(day).padStart(2, '0')}T12:00Z`,
        categoryId: catWs2Id,
      });
    }
    const rates = [
      {
        baseCurrency: 'USD',
        quoteCurrency: 'GBP',
        rate: '0.999999999999999999',
        rateDate: '2024-06-01',
        source: 'manual',
        freshness: 'fresh',
      },
      {
        baseCurrency: 'USD',
        quoteCurrency: 'GBP',
        rate: '1.200000000000000001',
        rateDate: '2024-06-05',
        source: 'frankfurter',
        freshness: 'fresh',
      },
      {
        baseCurrency: 'USD',
        quoteCurrency: 'GBP',
        rate: '1.5',
        rateDate: '2024-06-12',
        source: 'vendor',
        freshness: 'unknown',
      },
    ];
    for (const [path, metric] of [
      ['summary', ''],
      ['cash-flow', ''],
      ['advanced', '&metric=spending_heatmap'],
    ]) {
      const read = (presentationCurrency: string) =>
        application.inject({
          method: 'GET',
          url: `/v1/analytics/${path}?from=2024-06-01&to=2024-06-29&presentationCurrency=${presentationCurrency}${metric}`,
          headers: {
            authorization: 'Bearer other-owner-token',
            'x-workspace-id': ws2Id,
          },
        });
      const response = await read('GBP');
      expect(response.statusCode, response.payload).toBe(200);
      expect(response.json().fxRatesUsed).toEqual(rates);
      const native = await read('USD');
      expect(native.statusCode).toBe(200);
      expect(native.json()).not.toHaveProperty('fxRatesUsed');
    }
  });

  it('14. authorization contracts: 401 unauthenticated, 403 non-member, 200 viewer', async () => {
    const noTokenSummary = await application.inject({
      method: 'GET',
      url: '/v1/analytics/summary?from=2026-06-01&to=2026-06-30',
      headers: {
        'x-workspace-id': ws1Id,
      },
    });
    expect(noTokenSummary.statusCode).toBe(401);

    const noTokenCashFlow = await application.inject({
      method: 'GET',
      url: '/v1/analytics/cash-flow?from=2026-06-01&to=2026-06-30',
      headers: {
        'x-workspace-id': ws1Id,
      },
    });
    expect(noTokenCashFlow.statusCode).toBe(401);

    const nonMemberSummary = await application.inject({
      method: 'GET',
      url: '/v1/analytics/summary?from=2026-06-01&to=2026-06-30',
      headers: {
        authorization: 'Bearer non-member-token',
        'x-workspace-id': ws1Id,
      },
    });
    expect(nonMemberSummary.statusCode).toBe(403);

    const nonMemberCashFlow = await application.inject({
      method: 'GET',
      url: '/v1/analytics/cash-flow?from=2026-06-01&to=2026-06-30',
      headers: {
        authorization: 'Bearer non-member-token',
        'x-workspace-id': ws1Id,
      },
    });
    expect(nonMemberCashFlow.statusCode).toBe(403);

    const viewerSummary = await application.inject({
      method: 'GET',
      url: '/v1/analytics/summary?from=2026-06-01&to=2026-06-30',
      headers: {
        authorization: 'Bearer viewer-token',
        'x-workspace-id': ws1Id,
      },
    });
    expect(viewerSummary.statusCode).toBe(200);

    const viewerCashFlow = await application.inject({
      method: 'GET',
      url: '/v1/analytics/cash-flow?from=2026-06-01&to=2026-06-30',
      headers: {
        authorization: 'Bearer viewer-token',
        'x-workspace-id': ws1Id,
      },
    });
    expect(viewerCashFlow.statusCode).toBe(200);
  });
});
