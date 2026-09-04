import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  it('12. categories percentages sum to 100 for non-trivial seed; empty array when no expenses', async () => {
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
