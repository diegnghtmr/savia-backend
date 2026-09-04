// Migrations under test: 202609030001_funds.sql
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

describe('Funds integration suite against disposable PostgreSQL', () => {
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
        ($1, 'funds-owner@example.test'),
        ($2, 'funds-viewer@example.test'),
        ($3, 'funds-other@example.test'),
        ($4, 'funds-nonmember@example.test')`,
      [ownerId, viewerId, otherOwnerId, nonMemberId],
    );

    for (const [userId, email, name] of [
      [ownerId, 'funds-owner@example.test', 'Funds Owner'],
      [viewerId, 'funds-viewer@example.test', 'Funds Viewer'],
      [otherOwnerId, 'funds-other@example.test', 'Funds Other Owner'],
      [nonMemberId, 'funds-nonmember@example.test', 'Funds Non Member'],
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

    // Seed accounts
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, created_by) values
        ($1, $2, 'Checking Account', 'checking', 'USD', 'active', $3),
        ($4, $5, 'EUR Account', 'checking', 'EUR', 'active', $6)`,
      [
        account1Id,
        workspace1Id,
        ownerId,
        accountWs2Id,
        workspace2Id,
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
    await admin.end();
  });

  // 1. create -> 201 with the full Fund body; 422 for each invalid field.
  describe('1. create fund', () => {
    it('creates a fund with full body (201)', async () => {
      const key = randomUUID();
      const res = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload: {
          name: 'Emergency Savings',
          currency: 'USD',
          targetAmount: { amountMinor: '100000', currency: 'USD' },
          targetDate: '2026-12-31',
          linkedAccountId: account1Id,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.name).toBe('Emergency Savings');
      expect(body.currency).toBe('USD');
      expect(body.targetAmount).toEqual({
        amountMinor: '100000',
        currency: 'USD',
      });
      expect(body.currentAmount).toEqual({ amountMinor: '0', currency: 'USD' });
      expect(body.targetDate).toBe('2026-12-31');
      expect(body.linkedAccountId).toBe(account1Id);
      expect(body.status).toBe('active');
      expect(body.version).toBe(1);
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/);

      // Verify exact count in DB
      const dbRes = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.funds where id = $1',
        [body.id],
      );
      expect(dbRes.rows[0].count).toBe('1');
    });

    it('returns 422 for each invalid field', async () => {
      // Missing name
      const resMissingName = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          currency: 'USD',
          targetAmount: { amountMinor: '100000', currency: 'USD' },
        },
      });
      expect(resMissingName.statusCode).toBe(422);

      // Empty name
      const resEmptyName = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: '   ',
          currency: 'USD',
          targetAmount: { amountMinor: '100000', currency: 'USD' },
        },
      });
      expect(resEmptyName.statusCode).toBe(422);

      // Name exceeding 120 characters
      const resLongName = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'x'.repeat(121),
          currency: 'USD',
          targetAmount: { amountMinor: '100000', currency: 'USD' },
        },
      });
      expect(resLongName.statusCode).toBe(422);

      // Invalid currency
      const resInvalidCurr = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Fund',
          currency: 'XYZ',
          targetAmount: { amountMinor: '100000', currency: 'XYZ' },
        },
      });
      expect(resInvalidCurr.statusCode).toBe(422);

      // targetAmount <= 0
      const resZeroTarget = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Fund',
          currency: 'USD',
          targetAmount: { amountMinor: '0', currency: 'USD' },
        },
      });
      expect(resZeroTarget.statusCode).toBe(422);

      // targetAmount.currency mismatch with fund currency
      const resCurrMismatch = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Fund',
          currency: 'USD',
          targetAmount: { amountMinor: '10000', currency: 'EUR' },
        },
      });
      expect(resCurrMismatch.statusCode).toBe(422);

      // Invalid targetDate (non-existent calendar day)
      const resInvalidDate = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Fund',
          currency: 'USD',
          targetAmount: { amountMinor: '10000', currency: 'USD' },
          targetDate: '2026-02-30',
        },
      });
      expect(resInvalidDate.statusCode).toBe(422);

      // Foreign or non-existent linkedAccountId
      const resForeignAccount = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Fund',
          currency: 'USD',
          targetAmount: { amountMinor: '10000', currency: 'USD' },
          linkedAccountId: accountWs2Id, // from workspace 2
        },
      });
      expect(resForeignAccount.statusCode).toBe(422);
    });
  });

  // 2. list -> pagination, cursor stability, workspace isolation.
  describe('2. list funds', () => {
    it('respects workspace isolation, pagination, and cursor stability', async () => {
      // Create 3 funds in workspace 1
      const fundIdsWs1: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const res = await application.inject({
          method: 'POST',
          url: '/v1/funds',
          headers: {
            authorization: 'Bearer owner-token',
            'x-workspace-id': workspace1Id,
            'idempotency-key': randomUUID(),
          },
          payload: {
            name: `Fund WS1 ${i}`,
            currency: 'USD',
            targetAmount: { amountMinor: '100000', currency: 'USD' },
          },
        });
        expect(res.statusCode).toBe(201);
        fundIdsWs1.push(JSON.parse(res.payload).id);
      }

      // Create 1 fund in workspace 2
      const resWs2 = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer other-owner-token',
          'x-workspace-id': workspace2Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Fund WS2',
          currency: 'EUR',
          targetAmount: { amountMinor: '50000', currency: 'EUR' },
        },
      });
      expect(resWs2.statusCode).toBe(201);
      const fundIdWs2 = JSON.parse(resWs2.payload).id;

      // List page 1 with limit 2 in workspace 1
      const page1Res = await application.inject({
        method: 'GET',
        url: '/v1/funds?limit=2',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(page1Res.statusCode).toBe(200);
      const page1 = JSON.parse(page1Res.payload);
      expect(page1.items).toHaveLength(2);
      expect(page1.pageInfo.hasNextPage).toBe(true);
      expect(page1.pageInfo.nextCursor).toBeDefined();

      // Workspace isolation: fund from WS2 must not be in WS1 list
      const allItemIds = page1.items.map((f: { id: string }) => f.id);
      expect(allItemIds).not.toContain(fundIdWs2);

      // List page 2 using nextCursor
      const page2Res = await application.inject({
        method: 'GET',
        url: `/v1/funds?limit=2&cursor=${encodeURIComponent(page1.pageInfo.nextCursor)}`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(page2Res.statusCode).toBe(200);
      const page2 = JSON.parse(page2Res.payload);
      expect(page2.items.length).toBeGreaterThan(0);
      // Ensure cursor stability: page 2 does not duplicate page 1 items
      const page2Ids = page2.items.map((f: { id: string }) => f.id);
      for (const id of page2Ids) {
        expect(allItemIds).not.toContain(id);
      }
    });
  });

  // 3. contribute -> 201 returning a Transaction; the balanced posting pair exists;
  //    fund_contributions links it; currentAmount advances by exactly the amount.
  describe('3. contribute to fund', () => {
    it('creates contribution with balanced postings and advances currentAmount', async () => {
      // Create fund
      const fundRes = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Vacation Fund',
          currency: 'USD',
          targetAmount: { amountMinor: '50000', currency: 'USD' },
        },
      });
      expect(fundRes.statusCode).toBe(201);
      const fund = JSON.parse(fundRes.payload);
      expect(fund.currentAmount.amountMinor).toBe('0');

      // Contribute 1200 USD
      const contribKey = randomUUID();
      const contribRes = await application.inject({
        method: 'POST',
        url: `/v1/funds/${fund.id}/contributions`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': contribKey,
        },
        payload: {
          accountId: account1Id,
          amount: { amountMinor: '1200', currency: 'USD' },
          occurredAt: '2026-09-03T12:00:00Z',
          notes: 'First contribution',
        },
      });

      expect(contribRes.statusCode).toBe(201);
      const txn = JSON.parse(contribRes.payload);
      expect(txn.type).toBe('fund_contribution');
      expect(txn.status).toBe('confirmed');
      expect(txn.amount).toEqual({ amountMinor: '-1200', currency: 'USD' });
      expect(txn.accountId).toBe(account1Id);

      // Verify DB postings
      const postings = await admin.query<{
        leg_kind: string;
        account_id: string | null;
        amount_minor: string;
        currency: string;
        status: string;
      }>(
        `select leg_kind, account_id::text, amount_minor::text, currency, status
         from public.ledger_postings
         where transaction_id = $1
         order by leg_kind`,
        [txn.id],
      );
      expect(postings.rows).toHaveLength(2);

      const accountLeg = postings.rows.find((p) => p.leg_kind === 'account');
      expect(accountLeg).toBeDefined();
      expect(accountLeg?.account_id).toBe(account1Id);
      expect(accountLeg?.amount_minor).toBe('-1200');
      expect(accountLeg?.currency).toBe('USD');
      expect(accountLeg?.status).toBe('confirmed');

      const externalLeg = postings.rows.find((p) => p.leg_kind === 'external');
      expect(externalLeg).toBeDefined();
      expect(externalLeg?.account_id).toBeNull();
      expect(externalLeg?.amount_minor).toBe('1200');
      expect(externalLeg?.currency).toBe('USD');
      expect(externalLeg?.status).toBe('confirmed');

      // Balanced check: sum of minor units is 0
      const sum =
        BigInt(accountLeg!.amount_minor) + BigInt(externalLeg!.amount_minor);
      expect(sum).toBe(0n);

      // Verify link in fund_contributions
      const links = await admin.query<{
        fund_id: string;
        transaction_id: string;
      }>(
        'select fund_id::text, transaction_id::text from public.fund_contributions where transaction_id = $1',
        [txn.id],
      );
      expect(links.rows).toHaveLength(1);
      expect(links.rows[0].fund_id).toBe(fund.id);

      // Verify currentAmount advanced by exactly 1200
      const listRes = await application.inject({
        method: 'GET',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(listRes.statusCode).toBe(200);
      const updatedFund = JSON.parse(listRes.payload).items.find(
        (f: { id: string }) => f.id === fund.id,
      );
      expect(updatedFund).toBeDefined();
      expect(updatedFund.currentAmount).toEqual({
        amountMinor: '1200',
        currency: 'USD',
      });
    });

    it('decreases source account balance and increases fund currentAmount by contribution amount', async () => {
      const fundRes = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Direction Guard Fund',
          currency: 'USD',
          targetAmount: { amountMinor: '50000', currency: 'USD' },
        },
      });
      expect(fundRes.statusCode).toBe(201);
      const fund = JSON.parse(fundRes.payload);

      // 1. Read source account confirmed posting sum BEFORE contribution
      const beforeAccountSumRes = await admin.query<{ sum: string }>(
        `select coalesce(sum(amount_minor), 0)::text as sum
         from public.ledger_postings
         where account_id = $1 and status in ('confirmed', 'reconciled')`,
        [account1Id],
      );
      const beforeAccountSum = BigInt(beforeAccountSumRes.rows[0].sum);

      const beforeFundRes = await application.inject({
        method: 'GET',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      const fundBefore = JSON.parse(beforeFundRes.payload).items.find(
        (f: { id: string }) => f.id === fund.id,
      );
      const beforeFundAmount = BigInt(fundBefore.currentAmount.amountMinor);

      // 2. Contribute a known amount
      const contributionAmount = 2500n;
      const contribRes = await application.inject({
        method: 'POST',
        url: `/v1/funds/${fund.id}/contributions`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: account1Id,
          amount: {
            amountMinor: contributionAmount.toString(),
            currency: 'USD',
          },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });
      expect(contribRes.statusCode).toBe(201);

      // Read source account confirmed posting sum AFTER contribution
      const afterAccountSumRes = await admin.query<{ sum: string }>(
        `select coalesce(sum(amount_minor), 0)::text as sum
         from public.ledger_postings
         where account_id = $1 and status in ('confirmed', 'reconciled')`,
        [account1Id],
      );
      const afterAccountSum = BigInt(afterAccountSumRes.rows[0].sum);

      // 3. Assert the sum DECREASED by exactly that amount
      expect(afterAccountSum - beforeAccountSum).toBe(-contributionAmount);

      // Read fund currentAmount AFTER contribution
      const afterFundRes = await application.inject({
        method: 'GET',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      const fundAfter = JSON.parse(afterFundRes.payload).items.find(
        (f: { id: string }) => f.id === fund.id,
      );
      const afterFundAmount = BigInt(fundAfter.currentAmount.amountMinor);

      // 4. Assert in the same test that the fund's currentAmount INCREASED by exactly that amount
      expect(afterFundAmount - beforeFundAmount).toBe(contributionAmount);
    });

    it('pins the section 2 invariant: transactions.amount_minor equals the account leg and is negative', async () => {
      const fundRes = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Invariant Pin Fund',
          currency: 'USD',
          targetAmount: { amountMinor: '50000', currency: 'USD' },
        },
      });
      expect(fundRes.statusCode).toBe(201);
      const fund = JSON.parse(fundRes.payload);

      const contribRes = await application.inject({
        method: 'POST',
        url: `/v1/funds/${fund.id}/contributions`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: account1Id,
          amount: { amountMinor: '1500', currency: 'USD' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });
      expect(contribRes.statusCode).toBe(201);
      const txn = JSON.parse(contribRes.payload);

      const txnRow = await admin.query<{ amount_minor: string }>(
        'select amount_minor::text from public.transactions where id = $1',
        [txn.id],
      );
      const accountPostingRow = await admin.query<{ amount_minor: string }>(
        `select amount_minor::text from public.ledger_postings
         where transaction_id = $1 and leg_kind = 'account'`,
        [txn.id],
      );

      expect(txnRow.rows).toHaveLength(1);
      expect(accountPostingRow.rows).toHaveLength(1);
      expect(txnRow.rows[0].amount_minor).toBe('-1500');
      expect(accountPostingRow.rows[0].amount_minor).toBe('-1500');
      expect(txnRow.rows[0].amount_minor).toBe(
        accountPostingRow.rows[0].amount_minor,
      );
    });
  });

  // 4. contribute in the wrong currency -> 422, and NOTHING is written.
  describe('4. contribute wrong currency', () => {
    it('rejects wrong currency with 422 and writes nothing to the database', async () => {
      const fundRes = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'USD Fund',
          currency: 'USD',
          targetAmount: { amountMinor: '50000', currency: 'USD' },
        },
      });
      expect(fundRes.statusCode).toBe(201);
      const fund = JSON.parse(fundRes.payload);

      const beforeTxnCount = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.transactions',
      );
      const beforePostingsCount = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.ledger_postings',
      );
      const beforeLinksCount = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.fund_contributions',
      );

      const contribRes = await application.inject({
        method: 'POST',
        url: `/v1/funds/${fund.id}/contributions`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: account1Id,
          amount: { amountMinor: '1000', currency: 'EUR' }, // wrong currency
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });

      expect(contribRes.statusCode).toBe(422);

      const afterTxnCount = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.transactions',
      );
      const afterPostingsCount = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.ledger_postings',
      );
      const afterLinksCount = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.fund_contributions',
      );

      expect(afterTxnCount.rows[0].count).toBe(beforeTxnCount.rows[0].count);
      expect(afterPostingsCount.rows[0].count).toBe(
        beforePostingsCount.rows[0].count,
      );
      expect(afterLinksCount.rows[0].count).toBe(
        beforeLinksCount.rows[0].count,
      );
    });
  });

  // 5. A pending/voided contribution does NOT count toward currentAmount.
  describe('5. pending and voided contributions exclusion', () => {
    it('does not count pending or voided postings toward currentAmount', async () => {
      const fundRes = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Status Test Fund',
          currency: 'USD',
          targetAmount: { amountMinor: '50000', currency: 'USD' },
        },
      });
      expect(fundRes.statusCode).toBe(201);
      const fund = JSON.parse(fundRes.payload);

      // Make confirmed contribution of 2000
      const c1Res = await application.inject({
        method: 'POST',
        url: `/v1/funds/${fund.id}/contributions`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: account1Id,
          amount: { amountMinor: '2000', currency: 'USD' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });
      expect(c1Res.statusCode).toBe(201);
      const txn1 = JSON.parse(c1Res.payload);

      // Make second contribution of 3000
      const c2Res = await application.inject({
        method: 'POST',
        url: `/v1/funds/${fund.id}/contributions`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: account1Id,
          amount: { amountMinor: '3000', currency: 'USD' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });
      expect(c2Res.statusCode).toBe(201);
      const txn2 = JSON.parse(c2Res.payload);

      // Initial total: 2000 + 3000 = 5000 USD
      const initialListRes = await application.inject({
        method: 'GET',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(initialListRes.statusCode).toBe(200);
      const initialFund = JSON.parse(initialListRes.payload).items.find(
        (item: { id: string }) => item.id === fund.id,
      );
      expect(initialFund.currentAmount).toEqual({
        amountMinor: '5000',
        currency: 'USD',
      });

      // 1. Set txn1 postings to 'pending' in DB (proves pending is excluded)
      await admin.query(
        "update public.ledger_postings set status = 'pending' where transaction_id = $1",
        [txn1.id],
      );

      const pendingListRes = await application.inject({
        method: 'GET',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(pendingListRes.statusCode).toBe(200);
      const pendingFund = JSON.parse(pendingListRes.payload).items.find(
        (item: { id: string }) => item.id === fund.id,
      );
      expect(pendingFund.currentAmount).toEqual({
        amountMinor: '3000',
        currency: 'USD',
      });

      // 2. Void txn2 via the API (appends reversing leg, netting to 0)
      const voidRes = await application.inject({
        method: 'POST',
        url: `/v1/transactions/${txn2.id}/void`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          reason: 'Accidental contribution',
        },
      });
      expect(voidRes.statusCode).toBe(200);

      // Check currentAmount: pending txn1 (0) + voided txn2 (3000 - 3000 = 0) = 0
      const finalListRes = await application.inject({
        method: 'GET',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(finalListRes.statusCode).toBe(200);
      const finalFund = JSON.parse(finalListRes.payload).items.find(
        (item: { id: string }) => item.id === fund.id,
      );
      expect(finalFund.currentAmount).toEqual({
        amountMinor: '0',
        currency: 'USD',
      });
    });
  });

  // 6. A foreign-currency leg does NOT inflate currentAmount.
  describe('6. foreign currency leg exclusion', () => {
    it('does not inflate currentAmount when a foreign currency leg exists', async () => {
      const fundRes = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Currency Filter Fund',
          currency: 'USD',
          targetAmount: { amountMinor: '50000', currency: 'USD' },
        },
      });
      expect(fundRes.statusCode).toBe(201);
      const fund = JSON.parse(fundRes.payload);

      // Valid contribution 1000 USD
      const cRes = await application.inject({
        method: 'POST',
        url: `/v1/funds/${fund.id}/contributions`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: account1Id,
          amount: { amountMinor: '1000', currency: 'USD' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });
      expect(cRes.statusCode).toBe(201);

      // Insert directly a foreign currency posting into ledger_postings linked to the fund
      const foreignTxnId = randomUUID();
      await admin.query(
        `insert into public.transactions (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
         values ($1, $2, $3, 'fund_contribution', 'confirmed', 999999, 'EUR', now(), $4)`,
        [foreignTxnId, workspace1Id, account1Id, ownerId],
      );
      await admin.query(
        `insert into public.ledger_postings (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
         values ($1, $2, $3, 'account', 999999, 'EUR', 'confirmed', now()),
                ($1, $2, null, 'external', -999999, 'EUR', 'confirmed', now())`,
        [workspace1Id, foreignTxnId, account1Id],
      );
      await admin.query(
        `insert into public.fund_contributions (workspace_id, fund_id, transaction_id)
         values ($1, $2, $3)`,
        [workspace1Id, fund.id, foreignTxnId],
      );

      // Read fund
      const listRes = await application.inject({
        method: 'GET',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(listRes.statusCode).toBe(200);
      const f = JSON.parse(listRes.payload).items.find(
        (item: { id: string }) => item.id === fund.id,
      );
      // Must only be the USD 1000, NOT inflated by the EUR 999999 leg
      expect(f.currentAmount).toEqual({ amountMinor: '1000', currency: 'USD' });
    });
  });

  // 7. Cross-workspace fund -> 404, with its real id.
  describe('7. cross-workspace isolation', () => {
    it('returns 404 when contributing to a fund in another workspace', async () => {
      // Create fund in WS2
      const fundWs2Res = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer other-owner-token',
          'x-workspace-id': workspace2Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'WS2 Only Fund',
          currency: 'EUR',
          targetAmount: { amountMinor: '50000', currency: 'EUR' },
        },
      });
      expect(fundWs2Res.statusCode).toBe(201);
      const fundWs2 = JSON.parse(fundWs2Res.payload);

      // Try to contribute to WS2 fund using WS1 header
      const crossRes = await application.inject({
        method: 'POST',
        url: `/v1/funds/${fundWs2.id}/contributions`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          accountId: account1Id,
          amount: { amountMinor: '1000', currency: 'EUR' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });

      expect(crossRes.statusCode).toBe(404);
    });
  });

  // 8. Idempotent replay -> same body, no second write; different body, same key -> 409.
  describe('8. idempotency', () => {
    it('replays createFund with same body without second write, and 409 for different body', async () => {
      const key = randomUUID();
      const payload1 = {
        name: 'Idempotency Fund',
        currency: 'USD',
        targetAmount: { amountMinor: '50000', currency: 'USD' },
      };

      const res1 = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload: payload1,
      });
      expect(res1.statusCode).toBe(201);
      const fund1 = JSON.parse(res1.payload);

      // Exact replay
      const resReplay = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload: payload1,
      });
      expect(resReplay.statusCode).toBe(201);
      expect(JSON.parse(resReplay.payload).id).toBe(fund1.id);

      // Count in DB must still be exactly 1
      const countRes = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.funds where name = $1',
        [payload1.name],
      );
      expect(countRes.rows[0].count).toBe('1');

      // Conflict: same key, different body
      const resConflict = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload: {
          ...payload1,
          name: 'Different Name Conflict',
        },
      });
      expect(resConflict.statusCode).toBe(409);
    });

    it('replays contributeToFund with same body without second write, and 409 for different body', async () => {
      const fundRes = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Contrib Idempotency Fund',
          currency: 'USD',
          targetAmount: { amountMinor: '50000', currency: 'USD' },
        },
      });
      expect(fundRes.statusCode).toBe(201);
      const fund = JSON.parse(fundRes.payload);

      const contribKey = randomUUID();
      const contribPayload = {
        accountId: account1Id,
        amount: { amountMinor: '3000', currency: 'USD' },
        occurredAt: '2026-09-03T12:00:00Z',
      };

      const res1 = await application.inject({
        method: 'POST',
        url: `/v1/funds/${fund.id}/contributions`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': contribKey,
        },
        payload: contribPayload,
      });
      expect(res1.statusCode).toBe(201);
      const txn1 = JSON.parse(res1.payload);

      // Replay
      const resReplay = await application.inject({
        method: 'POST',
        url: `/v1/funds/${fund.id}/contributions`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': contribKey,
        },
        payload: contribPayload,
      });
      expect(resReplay.statusCode).toBe(201);
      expect(JSON.parse(resReplay.payload).id).toBe(txn1.id);

      // Verify exact count of transactions in DB
      const countRes = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.fund_contributions where fund_id = $1',
        [fund.id],
      );
      expect(countRes.rows[0].count).toBe('1');

      // Conflict: same key, different amount
      const resConflict = await application.inject({
        method: 'POST',
        url: `/v1/funds/${fund.id}/contributions`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': contribKey,
        },
        payload: {
          ...contribPayload,
          amount: { amountMinor: '9000', currency: 'USD' },
        },
      });
      expect(resConflict.statusCode).toBe(409);
    });
  });

  // 9. A forced failure after the first write rolls EVERYTHING back (RULING 92 proof).
  describe('9. RULING 92 proof (forced failure rollback)', () => {
    it('rolls back completely when an error occurs after the first write', async () => {
      const fundRes = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Rollback Fund',
          currency: 'USD',
          targetAmount: { amountMinor: '50000', currency: 'USD' },
        },
      });
      expect(fundRes.statusCode).toBe(201);
      const fund = JSON.parse(fundRes.payload);

      // Spy on PostgresIdempotencyAdapter.prototype.write to force an unexpected failure after the write
      const spy = vi
        .spyOn(PostgresIdempotencyAdapter.prototype, 'write')
        .mockRejectedValueOnce(
          new Error('forced failure after write (RULING 92 proof)'),
        );

      const failingKey = randomUUID();
      const failRes = await application.inject({
        method: 'POST',
        url: `/v1/funds/${fund.id}/contributions`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': failingKey,
        },
        payload: {
          accountId: account1Id,
          amount: { amountMinor: '7777', currency: 'USD' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
      });

      // Status should be 500 because the unexpected error was thrown to roll back
      expect(failRes.statusCode).toBe(500);

      // Verify that NO transaction, postings, or fund_contributions were persisted!
      const txns = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.transactions where amount_minor = 7777',
      );
      expect(txns.rows[0].count).toBe('0');

      const postings = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.ledger_postings where amount_minor = 7777',
      );
      expect(postings.rows[0].count).toBe('0');

      const links = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.fund_contributions where fund_id = $1',
        [fund.id],
      );
      expect(links.rows[0].count).toBe('0');

      spy.mockRestore();
    });
  });

  // 10. 401 without a token, 403 for an authenticated non-member.
  describe('10. auth & access control', () => {
    it('returns 401 without a token', async () => {
      const getRes = await application.inject({
        method: 'GET',
        url: '/v1/funds',
        headers: { 'x-workspace-id': workspace1Id },
      });
      expect(getRes.statusCode).toBe(401);

      const postRes = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'No Auth Fund',
          currency: 'USD',
          targetAmount: { amountMinor: '10000', currency: 'USD' },
        },
      });
      expect(postRes.statusCode).toBe(401);
    });

    it('returns 403 for an authenticated non-member', async () => {
      const getRes = await application.inject({
        method: 'GET',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer non-member-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(getRes.statusCode).toBe(403);

      const postRes = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer non-member-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Non Member Fund',
          currency: 'USD',
          targetAmount: { amountMinor: '10000', currency: 'USD' },
        },
      });
      expect(postRes.statusCode).toBe(403);
    });

    it('returns 403 for viewer attempting to write', async () => {
      const postRes = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer viewer-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Viewer Fund',
          currency: 'USD',
          targetAmount: { amountMinor: '10000', currency: 'USD' },
        },
      });
      expect(postRes.statusCode).toBe(403);
    });
  });

  // 11. recommendedMonthlyContribution absent when targetDate is null, and correct (ceiling) when set.
  describe('11. recommended monthly contribution derivation', () => {
    it('omits recommendedMonthlyContribution when targetDate is null', async () => {
      const res = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'No Target Date Fund',
          currency: 'USD',
          targetAmount: { amountMinor: '100000', currency: 'USD' },
        },
      });
      expect(res.statusCode).toBe(201);
      const fund = JSON.parse(res.payload);
      expect('recommendedMonthlyContribution' in fund).toBe(false);

      const listRes = await application.inject({
        method: 'GET',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(listRes.statusCode).toBe(200);
      const fetched = JSON.parse(listRes.payload).items.find(
        (f: { id: string }) => f.id === fund.id,
      );
      expect('recommendedMonthlyContribution' in fetched).toBe(false);
    });

    it('computes ceiling for recommendedMonthlyContribution when targetDate is set', async () => {
      // Create fund targeting 100 minor units
      // Target date: 2 months from now
      const now = new Date();
      const targetYear = now.getUTCFullYear();
      const targetMonth = now.getUTCMonth() + 1 + 2; // 2 months in future
      const adjustedYear = targetMonth > 12 ? targetYear + 1 : targetYear;
      const adjustedMonth = targetMonth > 12 ? targetMonth - 12 : targetMonth;
      const targetDate = `${adjustedYear}-${String(adjustedMonth).padStart(2, '0')}-15`;

      const res = await application.inject({
        method: 'POST',
        url: '/v1/funds',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Ceiling Calc Fund',
          currency: 'USD',
          targetAmount: { amountMinor: '101', currency: 'USD' },
          targetDate,
        },
      });
      expect(res.statusCode).toBe(201);
      const fund = JSON.parse(res.payload);
      // ceil(101 / 2) = 51 (distinguishes ceiling from floor)
      expect(fund.recommendedMonthlyContribution).toEqual({
        amountMinor: '51',
        currency: 'USD',
      });
    });
  });
});
