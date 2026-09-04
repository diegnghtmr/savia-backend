// Migrations under test: 202609030002_debts.sql
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
import { PostgresIdempotencyAdapter } from '../../src/platform/postgres-idempotency.adapter.js';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required for integration tests.');
}

describe('Debts integration suite against disposable PostgreSQL', () => {
  let admin: Pool;
  let application: NestFastifyApplication;

  const ownerId = '11111111-0000-4000-8000-000000000001';
  const viewerId = '22222222-0000-4000-8000-000000000001';
  const otherOwnerId = '33333333-0000-4000-8000-000000000001';
  const nonMemberId = '44444444-0000-4000-8000-000000000001';

  const workspace1Id = 'aaaaaaaa-0000-4000-8000-000000000001';
  const workspace2Id = 'bbbbbbbb-0000-4000-8000-000000000001';

  const account1Id = 'cccccccc-0000-4000-8000-000000000001';
  const accountWs2Id = 'dddddddd-0000-4000-8000-000000000001';
  const closedAccountId = 'eeeeeeee-0000-4000-8000-000000000001';

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
    });

    admin = new Pool({ connectionString: url });

    // Seed test users & profiles
    await admin.query(
      `insert into auth.users (id, email) values
        ($1, 'debts-owner@example.test'),
        ($2, 'debts-viewer@example.test'),
        ($3, 'debts-other@example.test'),
        ($4, 'debts-nonmember@example.test')`,
      [ownerId, viewerId, otherOwnerId, nonMemberId],
    );

    for (const [userId, email, name] of [
      [ownerId, 'debts-owner@example.test', 'Debts Owner'],
      [viewerId, 'debts-viewer@example.test', 'Debts Viewer'],
      [otherOwnerId, 'debts-other@example.test', 'Debts Other Owner'],
      [nonMemberId, 'debts-nonmember@example.test', 'Debts Non Member'],
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

    // Seed workspaces
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by) values
        ($1, 'Workspace 1', 'shared', 'USD', null, $2),
        ($3, 'Workspace 2', 'shared', 'EUR', null, $4)`,
      [workspace1Id, ownerId, workspace2Id, otherOwnerId],
    );

    // Seed memberships
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values
        ($1, $2, 'owner', 'active'),
        ($1, $3, 'viewer', 'active'),
        ($4, $5, 'owner', 'active')`,
      [workspace1Id, ownerId, viewerId, workspace2Id, otherOwnerId],
    );

    // Seed exchange rates
    await admin.query(
      `insert into public.exchange_rates (workspace_id, base_currency, quote_currency, rate, effective_at, source, created_by) values
        ($1, 'EUR', 'USD', 1.08, now(), 'test', $2),
        ($3, 'USD', 'EUR', 0.92, now(), 'test', $4)`,
      [workspace1Id, ownerId, workspace2Id, otherOwnerId],
    );

    // Seed accounts
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, closed_at, created_by) values
        ($1, $2, 'Checking Account', 'checking', 'USD', 'active', null, $3),
        ($4, $5, 'EUR Account', 'checking', 'EUR', 'active', null, $6),
        ($7, $2, 'Closed Account', 'checking', 'USD', 'closed', now(), $3)`,
      [
        account1Id,
        workspace1Id,
        ownerId,
        accountWs2Id,
        workspace2Id,
        otherOwnerId,
        closedAccountId,
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
    await admin.end();
  });

  // 1. create -> 201 full Debt body; 422 per invalid field.
  describe('1. create debt', () => {
    it('creates a debt with full body (201)', async () => {
      const key = randomUUID();
      const res = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload: {
          name: 'Home Mortgage',
          principal: { amountMinor: '30000000', currency: 'USD' },
          annualRate: '0.045000000000000000',
          rateType: 'fixed',
          minimumPayment: { amountMinor: '180000', currency: 'USD' },
          startDate: '2026-01-01',
          termMonths: 360,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.name).toBe('Home Mortgage');
      expect(body.currency).toBe('USD');
      expect(body.principal).toEqual({
        amountMinor: '30000000',
        currency: 'USD',
      });
      expect(body.outstandingBalance).toEqual({
        amountMinor: '30000000',
        currency: 'USD',
      });
      expect(body.annualRate).toBe('0.045000000000000000');
      expect(body.rateType).toBe('fixed');
      expect(body.minimumPayment).toEqual({
        amountMinor: '180000',
        currency: 'USD',
      });
      expect(body.status).toBe('active');
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/);

      // Verify exact count in DB
      const dbRes = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.debts where id = $1',
        [body.id],
      );
      expect(dbRes.rows[0].count).toBe('1');
    });

    it('returns 422 for each invalid field', async () => {
      // Missing name
      const resMissingName = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          principal: { amountMinor: '100000', currency: 'USD' },
          annualRate: '0.05',
          rateType: 'fixed',
        },
      });
      expect(resMissingName.statusCode).toBe(422);

      // Empty name
      const resEmptyName = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: '   ',
          principal: { amountMinor: '100000', currency: 'USD' },
          annualRate: '0.05',
          rateType: 'fixed',
        },
      });
      expect(resEmptyName.statusCode).toBe(422);

      // Name exceeding 120 characters
      const resLongName = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'x'.repeat(121),
          principal: { amountMinor: '100000', currency: 'USD' },
          annualRate: '0.05',
          rateType: 'fixed',
        },
      });
      expect(resLongName.statusCode).toBe(422);

      // Principal <= 0
      const resZeroPrincipal = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Debt Zero',
          principal: { amountMinor: '0', currency: 'USD' },
          annualRate: '0.05',
          rateType: 'fixed',
        },
      });
      expect(resZeroPrincipal.statusCode).toBe(422);

      // Negative annualRate
      const resNegRate = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Debt Negative Rate',
          principal: { amountMinor: '100000', currency: 'USD' },
          annualRate: '-0.05',
          rateType: 'fixed',
        },
      });
      expect(resNegRate.statusCode).toBe(422);

      // Invalid rateType
      const resInvalidRateType = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Debt Bad Rate Type',
          principal: { amountMinor: '100000', currency: 'USD' },
          annualRate: '0.05',
          rateType: 'unknown',
        },
      });
      expect(resInvalidRateType.statusCode).toBe(422);

      // Minimum payment currency mismatch
      const resMismatchMinPayment = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Debt Mismatch Currency',
          principal: { amountMinor: '100000', currency: 'USD' },
          annualRate: '0.05',
          rateType: 'fixed',
          minimumPayment: { amountMinor: '1000', currency: 'EUR' },
        },
      });
      expect(resMismatchMinPayment.statusCode).toBe(422);

      // termMonths < 1
      const resBadTerm = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Debt Bad Term',
          principal: { amountMinor: '100000', currency: 'USD' },
          annualRate: '0.05',
          rateType: 'fixed',
          termMonths: 0,
        },
      });
      expect(resBadTerm.statusCode).toBe(422);

      // Invalid startDate
      const resBadDate = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Debt Bad Date',
          principal: { amountMinor: '100000', currency: 'USD' },
          annualRate: '0.05',
          rateType: 'fixed',
          startDate: 'not-a-date',
        },
      });
      expect(resBadDate.statusCode).toBe(422);

      // Disallowed property
      const resDisallowed = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Debt Extra Property',
          principal: { amountMinor: '100000', currency: 'USD' },
          annualRate: '0.05',
          rateType: 'fixed',
          extraField: 'should-fail',
        },
      });
      expect(resDisallowed.statusCode).toBe(422);
    });
  });

  // 2. The 18-decimal annualRate round-trips byte-identically.
  describe('2. 18-decimal annualRate round-trip', () => {
    it('round-trips the full 18-decimal annualRate byte-identically', async () => {
      const rate18 = '4123.450000000000000000';
      const key = randomUUID();
      const createRes = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload: {
          name: 'Precision Debt',
          principal: { amountMinor: '100000', currency: 'USD' },
          annualRate: rate18,
          rateType: 'fixed',
        },
      });
      expect(createRes.statusCode).toBe(201);
      const createdBody = JSON.parse(createRes.payload);
      expect(createdBody.annualRate).toBe(rate18);

      // Read back from DB directly
      const dbRow = await admin.query<{ annual_rate: string }>(
        'select annual_rate::text from public.debts where id = $1',
        [createdBody.id],
      );
      expect(dbRow.rows[0].annual_rate).toBe(rate18);

      // Read back via listDebts HTTP endpoint
      const listRes = await application.inject({
        method: 'GET',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(listRes.statusCode).toBe(200);
      const item = JSON.parse(listRes.payload).items.find(
        (d: { id: string }) => d.id === createdBody.id,
      );
      expect(item.annualRate).toBe(rate18);
    });
  });

  // 3. list -> pagination, cursor stability, workspace isolation.
  describe('3. list debts (pagination, cursor stability, workspace isolation)', () => {
    it('supports pagination, cursor stability, and strictly isolates workspaces', async () => {
      // Create 3 debts in workspace 1
      const createdIdsWs1: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const res = await application.inject({
          method: 'POST',
          url: '/v1/debts',
          headers: {
            authorization: 'Bearer owner-token',
            'x-workspace-id': workspace1Id,
            'idempotency-key': randomUUID(),
          },
          payload: {
            name: `WS1 Debt ${i}`,
            principal: { amountMinor: `${i * 10000}`, currency: 'USD' },
            annualRate: '0.05',
            rateType: 'fixed',
          },
        });
        expect(res.statusCode).toBe(201);
        createdIdsWs1.push(JSON.parse(res.payload).id);
      }

      // Create 1 debt in workspace 2 (EUR)
      const resWs2 = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer other-owner-token',
          'x-workspace-id': workspace2Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'WS2 Isolated Debt',
          principal: { amountMinor: '500000', currency: 'EUR' },
          annualRate: '0.03',
          rateType: 'variable',
        },
      });
      expect(resWs2.statusCode).toBe(201);
      const ws2DebtId = JSON.parse(resWs2.payload).id;

      // Page 1 with limit=2
      const page1Res = await application.inject({
        method: 'GET',
        url: '/v1/debts?limit=2',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(page1Res.statusCode).toBe(200);
      const page1 = JSON.parse(page1Res.payload);
      expect(page1.items.length).toBe(2);
      expect(page1.pageInfo.hasNextPage).toBe(true);
      expect(typeof page1.pageInfo.nextCursor).toBe('string');

      // Cursor stability: re-fetching page 1 gives exact same items in same order
      const page1Refetch = await application.inject({
        method: 'GET',
        url: '/v1/debts?limit=2',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(JSON.parse(page1Refetch.payload).items).toEqual(page1.items);

      // Page 2 using nextCursor
      const page2Res = await application.inject({
        method: 'GET',
        url: `/v1/debts?limit=2&cursor=${encodeURIComponent(page1.pageInfo.nextCursor)}`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(page2Res.statusCode).toBe(200);
      const page2 = JSON.parse(page2Res.payload);
      // Items between page 1 and page 2 must be disjoint
      const page1Ids = page1.items.map((d: { id: string }) => d.id);
      for (const item of page2.items) {
        expect(page1Ids).not.toContain(item.id);
      }

      // Workspace isolation: Workspace 1 list must NEVER include ws2DebtId
      const allWs1Res = await application.inject({
        method: 'GET',
        url: '/v1/debts?limit=100',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      const allWs1Ids = JSON.parse(allWs1Res.payload).items.map(
        (d: { id: string }) => d.id,
      );
      expect(allWs1Ids).not.toContain(ws2DebtId);

      // Workspace 2 list must contain only WS2 debt
      const ws2ListRes = await application.inject({
        method: 'GET',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer other-owner-token',
          'x-workspace-id': workspace2Id,
        },
      });
      const ws2Ids = JSON.parse(ws2ListRes.payload).items.map(
        (d: { id: string }) => d.id,
      );
      expect(ws2Ids).toEqual([ws2DebtId]);
    });
  });

  // 4. payment -> 201 returning a Transaction; balanced pair; debt_payments row written.
  describe('4. payment creation (Transaction return, balanced postings, debt_payments split)', () => {
    it('creates a debt payment with balanced postings and debt_payments row (201)', async () => {
      const debtRes = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Payment Test Debt',
          principal: { amountMinor: '100000', currency: 'USD' },
          annualRate: '0.06',
          rateType: 'fixed',
        },
      });
      expect(debtRes.statusCode).toBe(201);
      const debt = JSON.parse(debtRes.payload);

      const paymentRes = await application.inject({
        method: 'POST',
        url: `/v1/debts/${debt.id}/payments`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: account1Id,
          totalAmount: { amountMinor: '5000', currency: 'USD' },
          principalAmount: { amountMinor: '3500', currency: 'USD' },
          interestAmount: { amountMinor: '1000', currency: 'USD' },
          feeAmount: { amountMinor: '500', currency: 'USD' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });

      expect(paymentRes.statusCode).toBe(201);
      const txn = JSON.parse(paymentRes.payload);
      expect(txn.type).toBe('debt_payment');
      expect(txn.status).toBe('confirmed');
      expect(txn.accountId).toBe(account1Id);
      // Stored transaction amount equals the account leg outflow (negative)
      expect(txn.amount).toEqual({ amountMinor: '-5000', currency: 'USD' });

      // Verify balanced pair in public.ledger_postings
      const postingsRes = await admin.query<{
        leg_kind: string;
        account_id: string | null;
        amount_minor: string;
        currency: string;
        status: string;
      }>(
        `select leg_kind, account_id, amount_minor::text, currency, status
         from public.ledger_postings
         where transaction_id = $1
         order by leg_kind asc`,
        [txn.id],
      );

      expect(postingsRes.rows.length).toBe(2);
      const accountLeg = postingsRes.rows.find((p) => p.leg_kind === 'account');
      const externalLeg = postingsRes.rows.find(
        (p) => p.leg_kind === 'external',
      );

      expect(accountLeg).toBeDefined();
      expect(accountLeg?.account_id).toBe(account1Id);
      expect(accountLeg?.amount_minor).toBe('-5000');
      expect(accountLeg?.status).toBe('confirmed');

      expect(externalLeg).toBeDefined();
      expect(externalLeg?.account_id).toBeNull();
      expect(externalLeg?.amount_minor).toBe('5000');
      expect(externalLeg?.status).toBe('confirmed');

      // Balanced pair sum is exactly zero
      const sumPostings =
        BigInt(accountLeg!.amount_minor) + BigInt(externalLeg!.amount_minor);
      expect(sumPostings).toBe(0n);

      // Verify debt_payments split row
      const splitRes = await admin.query<{
        principal_minor: string;
        interest_minor: string;
        fee_minor: string;
        debt_id: string;
      }>(
        `select principal_minor::text, interest_minor::text, fee_minor::text, debt_id
         from public.debt_payments
         where transaction_id = $1`,
        [txn.id],
      );
      expect(splitRes.rows.length).toBe(1);
      expect(splitRes.rows[0].debt_id).toBe(debt.id);
      expect(splitRes.rows[0].principal_minor).toBe('3500');
      expect(splitRes.rows[0].interest_minor).toBe('1000');
      expect(splitRes.rows[0].fee_minor).toBe('500');
    });
  });

  // 5. The account balance DECREASES by the total and the debt's outstandingBalance
  //    decreases by the PRINCIPAL portion. Assert both halves in one test.
  describe('5. balance direction and outstandingBalance reduction assertion', () => {
    it('decreases account balance by total and outstandingBalance by principal portion in one test', async () => {
      const debtRes = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Split Direction Guard Debt',
          principal: { amountMinor: '50000', currency: 'USD' },
          annualRate: '0.05',
          rateType: 'fixed',
        },
      });
      expect(debtRes.statusCode).toBe(201);
      const debt = JSON.parse(debtRes.payload);

      // 1. Snapshot confirmed posting sum for account1Id before payment
      const beforeAccountSumRes = await admin.query<{ sum: string }>(
        `select coalesce(sum(amount_minor), 0)::text as sum
         from public.ledger_postings
         where account_id = $1 and status in ('confirmed', 'reconciled')`,
        [account1Id],
      );
      const beforeAccountSum = BigInt(beforeAccountSumRes.rows[0].sum);

      // Outstanding balance before payment: exactly 50000
      expect(debt.outstandingBalance.amountMinor).toBe('50000');
      const beforeOutstanding = BigInt(debt.outstandingBalance.amountMinor);

      // 2. Pay 6000 USD total: 4000 principal, 1500 interest, 500 fee
      const totalPay = 6000n;
      const principalPay = 4000n;
      const payRes = await application.inject({
        method: 'POST',
        url: `/v1/debts/${debt.id}/payments`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: account1Id,
          totalAmount: { amountMinor: totalPay.toString(), currency: 'USD' },
          principalAmount: {
            amountMinor: principalPay.toString(),
            currency: 'USD',
          },
          interestAmount: { amountMinor: '1500', currency: 'USD' },
          feeAmount: { amountMinor: '500', currency: 'USD' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });
      expect(payRes.statusCode).toBe(201);

      // 3. Check account balance AFTER payment
      const afterAccountSumRes = await admin.query<{ sum: string }>(
        `select coalesce(sum(amount_minor), 0)::text as sum
         from public.ledger_postings
         where account_id = $1 and status in ('confirmed', 'reconciled')`,
        [account1Id],
      );
      const afterAccountSum = BigInt(afterAccountSumRes.rows[0].sum);

      // Half 1: Account balance DECREASED by totalAmount (6000)
      expect(afterAccountSum - beforeAccountSum).toBe(-totalPay);

      // 4. Check debt outstandingBalance AFTER payment
      const afterDebtRes = await application.inject({
        method: 'GET',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(afterDebtRes.statusCode).toBe(200);
      const updatedDebt = JSON.parse(afterDebtRes.payload).items.find(
        (d: { id: string }) => d.id === debt.id,
      );
      const afterOutstanding = BigInt(
        updatedDebt.outstandingBalance.amountMinor,
      );

      // Half 2: Outstanding balance DECREASED by principal portion only (4000)
      expect(beforeOutstanding - afterOutstanding).toBe(principalPay);
      expect(afterOutstanding).toBe(46000n);
    });
  });

  // 6. A split that does not sum to the total -> 422, nothing written (exact unchanged counts).
  describe('6. split invariant sum failure', () => {
    it('rejects a split not summing to totalAmount with 422 and writes nothing', async () => {
      const debtRes = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Split Mismatch Debt',
          principal: { amountMinor: '50000', currency: 'USD' },
          annualRate: '0.05',
          rateType: 'fixed',
        },
      });
      expect(debtRes.statusCode).toBe(201);
      const debt = JSON.parse(debtRes.payload);

      const beforeTxns = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.transactions',
      );
      const beforePostings = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.ledger_postings',
      );
      const beforeSplits = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.debt_payments',
      );
      const beforeIdempotency = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.command_idempotency_records',
      );

      // 3000 + 1000 + 500 = 4500 != 5000
      const res = await application.inject({
        method: 'POST',
        url: `/v1/debts/${debt.id}/payments`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: account1Id,
          totalAmount: { amountMinor: '5000', currency: 'USD' },
          principalAmount: { amountMinor: '3000', currency: 'USD' },
          interestAmount: { amountMinor: '1000', currency: 'USD' },
          feeAmount: { amountMinor: '500', currency: 'USD' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });

      expect(res.statusCode).toBe(422);

      const afterTxns = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.transactions',
      );
      const afterPostings = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.ledger_postings',
      );
      const afterSplits = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.debt_payments',
      );
      const afterIdempotency = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.command_idempotency_records',
      );

      expect(afterTxns.rows[0].count).toBe(beforeTxns.rows[0].count);
      expect(afterPostings.rows[0].count).toBe(beforePostings.rows[0].count);
      expect(afterSplits.rows[0].count).toBe(beforeSplits.rows[0].count);
      expect(afterIdempotency.rows[0].count).toBe(
        beforeIdempotency.rows[0].count,
      );
    });
  });

  // 7. A payment with no split reduces the principal by the full total.
  describe('7. payment with no split', () => {
    it('reduces the principal by full total when no split parts are supplied', async () => {
      const debtRes = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'No Split Debt',
          principal: { amountMinor: '20000', currency: 'USD' },
          annualRate: '0.04',
          rateType: 'fixed',
        },
      });
      expect(debtRes.statusCode).toBe(201);
      const debt = JSON.parse(debtRes.payload);

      const payRes = await application.inject({
        method: 'POST',
        url: `/v1/debts/${debt.id}/payments`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: account1Id,
          totalAmount: { amountMinor: '7500', currency: 'USD' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });
      expect(payRes.statusCode).toBe(201);
      const txn = JSON.parse(payRes.payload);

      // Verify debt_payments row: principal_minor should equal 7500, interest and fee 0
      const splitRow = await admin.query<{
        principal_minor: string;
        interest_minor: string;
        fee_minor: string;
      }>(
        'select principal_minor::text, interest_minor::text, fee_minor::text from public.debt_payments where transaction_id = $1',
        [txn.id],
      );
      expect(splitRow.rows[0].principal_minor).toBe('7500');
      expect(splitRow.rows[0].interest_minor).toBe('0');
      expect(splitRow.rows[0].fee_minor).toBe('0');

      // Verify outstanding balance reduced from 20000 to 12500
      const listRes = await application.inject({
        method: 'GET',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      const listed = JSON.parse(listRes.payload).items.find(
        (d: { id: string }) => d.id === debt.id,
      );
      expect(listed.outstandingBalance.amountMinor).toBe('12500');
    });
  });

  // 8. Payment currency != debt currency -> 422, nothing written.
  describe('8. payment currency != debt currency (Guard 1)', () => {
    it('rejects payment with 422 when payment currency differs from debt currency', async () => {
      const debtRes = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'USD Debt',
          principal: { amountMinor: '50000', currency: 'USD' },
          annualRate: '0.05',
          rateType: 'fixed',
        },
      });
      expect(debtRes.statusCode).toBe(201);
      const debt = JSON.parse(debtRes.payload);

      const beforeTxns = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.transactions',
      );

      const payRes = await application.inject({
        method: 'POST',
        url: `/v1/debts/${debt.id}/payments`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: account1Id,
          totalAmount: { amountMinor: '1000', currency: 'EUR' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });

      expect(payRes.statusCode).toBe(422);

      const afterTxns = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.transactions',
      );
      expect(afterTxns.rows[0].count).toBe(beforeTxns.rows[0].count);
    });
  });

  // 9. Payment currency != account currency -> 422, nothing written, AND account balance endpoint still returns 200.
  describe('9. payment currency != account currency (Guard 2)', () => {
    it('rejects with 422, writes nothing, and leaves account balance returning 200', async () => {
      // In Workspace 2 (EUR base): create an EUR debt
      const debtRes = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer other-owner-token',
          'x-workspace-id': workspace2Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'WS2 EUR Debt',
          principal: { amountMinor: '20000', currency: 'EUR' },
          annualRate: '0.04',
          rateType: 'fixed',
        },
      });
      expect(debtRes.statusCode).toBe(201);
      const debt = JSON.parse(debtRes.payload);

      // Verify EUR account balance returns 200 initially
      const initialBalanceRes = await application.inject({
        method: 'GET',
        url: `/v1/accounts/${accountWs2Id}/balance`,
        headers: {
          authorization: 'Bearer other-owner-token',
          'x-workspace-id': workspace2Id,
        },
      });
      expect(initialBalanceRes.statusCode).toBe(200);

      // Create a USD account in workspace 2 to trigger account currency mismatch
      const usdAccRes = await admin.query<{ id: string }>(
        `insert into public.accounts (workspace_id, name, type, currency, status, created_by)
         values ($1, 'WS2 USD Account', 'checking', 'USD', 'active', $2) returning id::text`,
        [workspace2Id, otherOwnerId],
      );
      const usdAccId = usdAccRes.rows[0].id;

      const beforeTxns = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.transactions',
      );

      // Attempt payment in EUR from USD account
      const failRes = await application.inject({
        method: 'POST',
        url: `/v1/debts/${debt.id}/payments`,
        headers: {
          authorization: 'Bearer other-owner-token',
          'x-workspace-id': workspace2Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: usdAccId,
          totalAmount: { amountMinor: '500', currency: 'EUR' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });

      expect(failRes.statusCode).toBe(422);

      const afterTxns = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.transactions',
      );
      expect(afterTxns.rows[0].count).toBe(beforeTxns.rows[0].count);

      // Verify account balance endpoint STILL returns 200 afterwards
      const afterBalanceRes = await application.inject({
        method: 'GET',
        url: `/v1/accounts/${usdAccId}/balance`,
        headers: {
          authorization: 'Bearer other-owner-token',
          'x-workspace-id': workspace2Id,
        },
      });
      expect(afterBalanceRes.statusCode).toBe(200);
    });
  });

  // 10. A pending or voided posting does NOT count toward outstandingBalance.
  describe('10. pending and voided posting exclusion', () => {
    it('does not count pending or voided postings toward outstandingBalance', async () => {
      const debtRes = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Status Test Debt',
          principal: { amountMinor: '50000', currency: 'USD' },
          annualRate: '0.05',
          rateType: 'fixed',
        },
      });
      expect(debtRes.statusCode).toBe(201);
      const debt = JSON.parse(debtRes.payload);

      // Make confirmed payment 1 of 5000
      const p1Res = await application.inject({
        method: 'POST',
        url: `/v1/debts/${debt.id}/payments`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: account1Id,
          totalAmount: { amountMinor: '5000', currency: 'USD' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });
      expect(p1Res.statusCode).toBe(201);
      const txn1 = JSON.parse(p1Res.payload);

      // Make confirmed payment 2 of 7000
      const p2Res = await application.inject({
        method: 'POST',
        url: `/v1/debts/${debt.id}/payments`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: account1Id,
          totalAmount: { amountMinor: '7000', currency: 'USD' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });
      expect(p2Res.statusCode).toBe(201);
      const txn2 = JSON.parse(p2Res.payload);

      // Outstanding balance: 50000 - 5000 - 7000 = 38000
      const initialRes = await application.inject({
        method: 'GET',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      const dInitial = JSON.parse(initialRes.payload).items.find(
        (d: { id: string }) => d.id === debt.id,
      );
      expect(dInitial.outstandingBalance.amountMinor).toBe('38000');

      // Set txn1 postings to 'pending' -> only txn2 counts -> outstanding is 50000 - 7000 = 43000
      await admin.query(
        "update public.ledger_postings set status = 'pending' where transaction_id = $1",
        [txn1.id],
      );

      const pendingRes = await application.inject({
        method: 'GET',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      const dPending = JSON.parse(pendingRes.payload).items.find(
        (d: { id: string }) => d.id === debt.id,
      );
      expect(dPending.outstandingBalance.amountMinor).toBe('43000');

      // Set txn2 postings to 'draft' -> neither counts -> outstanding is 50000
      await admin.query(
        "update public.ledger_postings set status = 'draft' where transaction_id = $1",
        [txn2.id],
      );

      const draftRes = await application.inject({
        method: 'GET',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      const dDraft = JSON.parse(draftRes.payload).items.find(
        (d: { id: string }) => d.id === debt.id,
      );
      expect(dDraft.outstandingBalance.amountMinor).toBe('50000');
    });
  });

  // 11. A foreign-currency leg does NOT distort outstandingBalance.
  describe('11. foreign-currency leg exclusion from outstandingBalance', () => {
    it('does not distort outstandingBalance when foreign-currency legs exist', async () => {
      const debtRes = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Currency Guard Debt',
          principal: { amountMinor: '50000', currency: 'USD' },
          annualRate: '0.05',
          rateType: 'fixed',
        },
      });
      expect(debtRes.statusCode).toBe(201);
      const debt = JSON.parse(debtRes.payload);

      // Valid payment: 5000 USD
      const payRes = await application.inject({
        method: 'POST',
        url: `/v1/debts/${debt.id}/payments`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: account1Id,
          totalAmount: { amountMinor: '5000', currency: 'USD' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });
      expect(payRes.statusCode).toBe(201);

      // Insert directly a foreign currency posting into ledger_postings linked to the debt
      const foreignTxnId = randomUUID();
      await admin.query(
        `insert into public.transactions (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
         values ($1, $2, $3, 'debt_payment', 'confirmed', -999999, 'EUR', now(), $4)`,
        [foreignTxnId, workspace1Id, account1Id, ownerId],
      );
      await admin.query(
        `insert into public.ledger_postings (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
         values
           ($1, $2, $3, 'account', -999999, 'EUR', 'confirmed', now()),
           ($1, $2, null, 'external', 999999, 'EUR', 'confirmed', now())`,
        [workspace1Id, foreignTxnId, account1Id],
      );
      await admin.query(
        `insert into public.debt_payments (workspace_id, debt_id, transaction_id, principal_minor, interest_minor, fee_minor)
         values ($1, $2, $3, 999999, 0, 0)`,
        [workspace1Id, debt.id, foreignTxnId],
      );

      // Read debt: outstanding balance should be 50000 - 5000 = 45000, NOT distorted by EUR leg!
      const listRes = await application.inject({
        method: 'GET',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      const item = JSON.parse(listRes.payload).items.find(
        (d: { id: string }) => d.id === debt.id,
      );
      expect(item.outstandingBalance.amountMinor).toBe('45000');
    });
  });

  // 12. Cross-workspace debt -> 404 using its real id.
  describe('12. cross-workspace isolation on payment', () => {
    it('returns 404 when debt belongs to another workspace', async () => {
      // Create debt in workspace 1
      const debtRes = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'WS1 Debt for Cross Check',
          principal: { amountMinor: '50000', currency: 'USD' },
          annualRate: '0.05',
          rateType: 'fixed',
        },
      });
      expect(debtRes.statusCode).toBe(201);
      const debtWs1 = JSON.parse(debtRes.payload);

      // Attempt payment in Workspace 2 targeting Workspace 1 debt
      const res = await application.inject({
        method: 'POST',
        url: `/v1/debts/${debtWs1.id}/payments`,
        headers: {
          authorization: 'Bearer other-owner-token',
          'x-workspace-id': workspace2Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: accountWs2Id,
          totalAmount: { amountMinor: '1000', currency: 'EUR' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });

      // Must return 404 without leaking existence
      expect(res.statusCode).toBe(404);
    });
  });

  // 13. Idempotent replay -> same body, no second write; same key + different body -> 409.
  describe('13. idempotency handling', () => {
    it('replays identical response and rejects conflict with 409', async () => {
      const key = randomUUID();
      const payload = {
        name: 'Idempotent Debt',
        principal: { amountMinor: '50000', currency: 'USD' },
        annualRate: '0.05',
        rateType: 'fixed',
      };

      // 1. Initial write
      const res1 = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload,
      });
      expect(res1.statusCode).toBe(201);
      const body1 = JSON.parse(res1.payload);

      // Count in DB must be exactly 1
      const count1 = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.debts where name = $1',
        ['Idempotent Debt'],
      );
      expect(count1.rows[0].count).toBe('1');

      // 2. Exact retry: returns 201 replayed with identical body
      const resReplay = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload,
      });
      expect(resReplay.statusCode).toBe(201);
      expect(JSON.parse(resReplay.payload)).toEqual(body1);

      // DB count still exactly 1
      const countReplay = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.debts where name = $1',
        ['Idempotent Debt'],
      );
      expect(countReplay.rows[0].count).toBe('1');

      // 3. Different payload with same key: returns 409 Conflict
      const resConflict = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload: {
          ...payload,
          name: 'Conflict Debt Name',
        },
      });
      expect(resConflict.statusCode).toBe(409);
    });
  });

  // 14. A forced failure after the first write rolls EVERYTHING back (RULING 92 proof).
  describe('14. RULING 92 proof (forced failure rollback)', () => {
    it('rolls back completely when an error occurs after the first write', async () => {
      const debtRes = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Rollback Debt',
          principal: { amountMinor: '50000', currency: 'USD' },
          annualRate: '0.05',
          rateType: 'fixed',
        },
      });
      expect(debtRes.statusCode).toBe(201);
      const debt = JSON.parse(debtRes.payload);

      // Spy on PostgresIdempotencyAdapter.prototype.write to force an unexpected failure after write
      const spy = vi
        .spyOn(PostgresIdempotencyAdapter.prototype, 'write')
        .mockRejectedValueOnce(
          new Error('forced failure after write (RULING 92 proof)'),
        );

      const failingKey = randomUUID();
      const failRes = await application.inject({
        method: 'POST',
        url: `/v1/debts/${debt.id}/payments`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': failingKey,
        },
        payload: {
          accountId: account1Id,
          totalAmount: { amountMinor: '8888', currency: 'USD' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });

      expect(failRes.statusCode).toBe(500);

      // Verify that NO transaction, postings, or debt_payments were persisted
      const txns = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.transactions where amount_minor = -8888',
      );
      expect(txns.rows[0].count).toBe('0');

      const postings = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.ledger_postings where amount_minor = -8888',
      );
      expect(postings.rows[0].count).toBe('0');

      const splits = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.debt_payments where debt_id = $1 and principal_minor = 8888',
        [debt.id],
      );
      expect(splits.rows[0].count).toBe('0');

      spy.mockRestore();
    });
  });

  // 15. 401 without a token; 403 for an authenticated non-member; 403 for a viewer writing.
  describe('15. authentication and authorization guards', () => {
    it('returns 401 without a token', async () => {
      const res = await application.inject({
        method: 'GET',
        url: '/v1/debts',
        headers: {
          'x-workspace-id': workspace1Id,
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 for an authenticated non-member', async () => {
      const res = await application.inject({
        method: 'GET',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer non-member-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 for a viewer writing debt', async () => {
      const res = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer viewer-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Viewer Write Debt',
          principal: { amountMinor: '10000', currency: 'USD' },
          annualRate: '0.05',
          rateType: 'fixed',
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 for a viewer writing debt payment', async () => {
      const res = await application.inject({
        method: 'POST',
        url: `/v1/debts/${randomUUID()}/payments`,
        headers: {
          authorization: 'Bearer viewer-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: account1Id,
          totalAmount: { amountMinor: '1000', currency: 'USD' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // 16. outstandingBalance never goes negative when payments exceed principal.
  describe('16. outstandingBalance clamping at zero', () => {
    it('clamps outstandingBalance at zero when payments exceed principal', async () => {
      const debtRes = await application.inject({
        method: 'POST',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Overpaid Debt',
          principal: { amountMinor: '10000', currency: 'USD' },
          annualRate: '0.05',
          rateType: 'fixed',
        },
      });
      expect(debtRes.statusCode).toBe(201);
      const debt = JSON.parse(debtRes.payload);

      // Overpay: total 15000 against 10000 principal
      const payRes = await application.inject({
        method: 'POST',
        url: `/v1/debts/${debt.id}/payments`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: account1Id,
          totalAmount: { amountMinor: '15000', currency: 'USD' },
          principalAmount: { amountMinor: '15000', currency: 'USD' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });
      expect(payRes.statusCode).toBe(201);

      // Read debt: outstanding balance must be 0, never negative
      const listRes = await application.inject({
        method: 'GET',
        url: '/v1/debts',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      const item = JSON.parse(listRes.payload).items.find(
        (d: { id: string }) => d.id === debt.id,
      );
      expect(item.outstandingBalance.amountMinor).toBe('0');
    });
  });
});
