// Migrations under test: 202609050001_report_definitions.sql, 202609050002_report_runs.sql
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import {
  ARTIFACT_STORAGE,
  type ArtifactStorage,
} from '../../src/platform/artifact-storage.port.js';
import {
  createReportRunCommand,
  ReportRunCommandValidationError,
} from '../../src/reports/report-run-command.js';
import type { ReportGrid } from '../../src/reports/report-engine.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

class InMemoryArtifactStorage implements ArtifactStorage {
  public readonly uploaded = new Map<
    string,
    { content: Buffer; contentType: string }
  >();
  public uploadCallCount = 0;
  public removeCallCount = 0;
  public failRemove = false;

  public async upload(
    path: string,
    content: Buffer,
    contentType: string,
  ): Promise<void> {
    this.uploadCallCount++;
    this.uploaded.set(path, { content, contentType });
  }

  public async sign(
    path: string,
    expiresAt: Date,
  ): Promise<{ url: string; expiresAt: Date }> {
    return { url: `https://storage.example.test/${path}`, expiresAt };
  }

  public async remove(path: string): Promise<void> {
    this.removeCallCount++;
    if (this.failRemove) {
      throw new Error('cleanup failed');
    }
    this.uploaded.delete(path);
  }
}

describe('Report runs integration contract and endpoint suite', () => {
  let admin: Pool;
  let application: NestFastifyApplication;
  let inMemoryStorage: InMemoryArtifactStorage;

  const ownerId = '11111111-0000-4000-8000-000000000001';
  const editorId = '22222222-0000-4000-8000-000000000001';
  const viewerId = '33333333-0000-4000-8000-000000000001';
  const otherOwnerId = '44444444-0000-4000-8000-000000000001';
  const nonMemberId = '55555555-0000-4000-8000-000000000001';
  const dualMemberId = '66666666-0000-4000-8000-000000000001';
  const adminId = '77777777-0000-4000-8000-000000000001';

  const workspace1Id = 'aaaaaaaa-0000-4000-8000-000000000001';
  const workspace2Id = 'bbbbbbbb-0000-4000-8000-000000000001';

  const acct1Usd = 'cccccccc-0000-4000-8000-000000000001';
  const acct1Eur = 'cccccccc-0000-4000-8000-000000000002';
  const acct2Usd = 'cccccccc-0000-4000-8000-000000000003';

  const catExpenseId = 'dddddddd-0000-4000-8000-000000000001';
  const catIncomeId = 'dddddddd-0000-4000-8000-000000000002';
  const catExpense2Id = 'dddddddd-0000-4000-8000-000000000003';

  const txEurId = 'eeeeeeee-0000-4000-8000-000000000001';
  const txEur2Id = 'eeeeeeee-0000-4000-8000-000000000002';
  const txJulyId = 'eeeeeeee-0000-4000-8000-000000000003';
  const budgetJuneId = 'ffffffff-0000-4000-8000-000000000001';
  const customDefId = 'aaaaaaaa-1111-4000-8000-000000000001';

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
    });

    admin = new Pool({ connectionString: url });
    inMemoryStorage = new InMemoryArtifactStorage();

    // 1. Seed auth users & profiles
    await admin.query(
      `insert into auth.users (id, email) values
        ($1, 'reports-owner@example.test'),
        ($2, 'reports-editor@example.test'),
        ($3, 'reports-viewer@example.test'),
        ($4, 'reports-other@example.test'),
        ($5, 'reports-nonmember@example.test'),
        ($6, 'reports-dual@example.test'),
        ($7, 'reports-admin@example.test')`,
      [
        ownerId,
        editorId,
        viewerId,
        otherOwnerId,
        nonMemberId,
        dualMemberId,
        adminId,
      ],
    );

    for (const [userId, email, name] of [
      [ownerId, 'reports-owner@example.test', 'Reports Owner'],
      [editorId, 'reports-editor@example.test', 'Reports Editor'],
      [viewerId, 'reports-viewer@example.test', 'Reports Viewer'],
      [otherOwnerId, 'reports-other@example.test', 'Reports Other Owner'],
      [nonMemberId, 'reports-nonmember@example.test', 'Reports Non Member'],
      [dualMemberId, 'reports-dual@example.test', 'Reports Dual Member'],
      [adminId, 'reports-admin@example.test', 'Reports Administrator'],
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

    // 2. Seed workspaces
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by) values
        ($1, 'Workspace 1', 'shared', 'USD', null, $2),
        ($3, 'Workspace 2', 'shared', 'USD', null, $4)`,
      [workspace1Id, ownerId, workspace2Id, otherOwnerId],
    );

    // 3. Seed memberships
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values
        ($1, $2, 'owner', 'active'),
        ($1, $3, 'editor', 'active'),
        ($1, $4, 'viewer', 'active'),
        ($1, $5, 'administrator', 'active'),
        ($1, $6, 'editor', 'active'),
        ($7, $8, 'owner', 'active'),
        ($7, $6, 'editor', 'active')`,
      [
        workspace1Id,
        ownerId,
        editorId,
        viewerId,
        adminId,
        dualMemberId,
        workspace2Id,
        otherOwnerId,
      ],
    );

    // 4. Seed exchange rate: EUR -> USD = 1.10 in workspace1Id
    await admin.query(
      `insert into public.exchange_rates (workspace_id, base_currency, quote_currency, rate, effective_at, source, created_by) values
        ($1, 'EUR', 'USD', 1.10, now() - interval '1 day', 'manual', $2)`,
      [workspace1Id, ownerId],
    );

    // 5. Seed accounts
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, created_by) values
        ($1, $2, 'USD Checking', 'checking', 'USD', $3),
        ($4, $2, 'EUR Checking', 'checking', 'EUR', $3),
        ($5, $6, 'W2 USD Checking', 'checking', 'USD', $7)`,
      [
        acct1Usd,
        workspace1Id,
        ownerId,
        acct1Eur,
        acct2Usd,
        workspace2Id,
        otherOwnerId,
      ],
    );

    // 6. Seed categories
    await admin.query(
      `insert into public.categories (id, workspace_id, name, kind, created_by) values
        ($1, $2, 'Expenses', 'expense', $3),
        ($4, $2, 'Income', 'income', $3),
        ($5, $2, 'Utilities', 'expense', $3)`,
      [catExpenseId, workspace1Id, ownerId, catIncomeId, catExpense2Id],
    );

    // 7. Seed confirmed EUR transaction with confirmed ledger posting (transfer_id is null)
    await admin.query(
      `insert into public.transactions (
        id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, category_id, created_by
      ) values (
        $1, $2, $3, 'expense', 'confirmed', 10000, 'EUR', '2026-06-15 12:00:00+00', $4, $5
      )`,
      [txEurId, workspace1Id, acct1Eur, catExpenseId, ownerId],
    );
    await admin.query(
      `insert into public.ledger_postings (
        id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at
      ) values
        (gen_random_uuid(), $1, $2, $3, 'account', 10000, 'EUR', 'confirmed', '2026-06-15 12:00:00+00'),
        (gen_random_uuid(), $1, $2, null, 'external', -10000, 'EUR', 'confirmed', '2026-06-15 12:00:00+00')`,
      [workspace1Id, txEurId, acct1Eur],
    );

    // Seed second EUR transaction with catExpense2Id (for partial budget warning test)
    await admin.query(
      `insert into public.transactions (
        id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, category_id, created_by
      ) values (
        $1, $2, $3, 'expense', 'confirmed', 5000, 'EUR', '2026-06-16 12:00:00+00', $4, $5
      )`,
      [txEur2Id, workspace1Id, acct1Eur, catExpense2Id, ownerId],
    );
    await admin.query(
      `insert into public.ledger_postings (
        id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at
      ) values
        (gen_random_uuid(), $1, $2, $3, 'account', 5000, 'EUR', 'confirmed', '2026-06-16 12:00:00+00'),
        (gen_random_uuid(), $1, $2, null, 'external', -5000, 'EUR', 'confirmed', '2026-06-16 12:00:00+00')`,
      [workspace1Id, txEur2Id, acct1Eur],
    );

    // Seed July transaction in USD
    await admin.query(
      `insert into public.transactions (
        id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, category_id, created_by
      ) values (
        $1, $2, $3, 'expense', 'confirmed', 3000, 'USD', '2026-07-15 12:00:00+00', $4, $5
      )`,
      [txJulyId, workspace1Id, acct1Usd, catExpenseId, ownerId],
    );
    await admin.query(
      `insert into public.ledger_postings (
        id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at
      ) values
        (gen_random_uuid(), $1, $2, $3, 'account', 3000, 'USD', 'confirmed', '2026-07-15 12:00:00+00'),
        (gen_random_uuid(), $1, $2, null, 'external', -3000, 'USD', 'confirmed', '2026-07-15 12:00:00+00')`,
      [workspace1Id, txJulyId, acct1Usd],
    );

    // 8. Seed June budget with allocation only for catExpenseId
    await admin.query(
      `insert into public.budgets (id, workspace_id, name, method, period_start, period_end, currency, created_by) values
        ($1, $2, 'June Budget', 'envelope', '2026-06-01', '2026-06-30', 'USD', $3)`,
      [budgetJuneId, workspace1Id, ownerId],
    );
    await admin.query(
      `insert into public.budget_allocations (id, workspace_id, budget_id, category_id, planned_minor) values
        (gen_random_uuid(), $1, $2, $3, 50000)`,
      [workspace1Id, budgetJuneId, catExpenseId],
    );

    // 9. Seed custom report definition with budget measure
    await admin.query(
      `insert into public.report_definitions (id, workspace_id, name, dimensions, measures, visualization, filters, created_by) values
        ($1, $2, 'Custom Budget Def', '["month", "category"]'::jsonb, '["budget", "converted_value"]'::jsonb, 'table', '{}'::jsonb, $3)`,
      [customDefId, workspace1Id, ownerId],
    );

    // Bootstrap Nest application
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: async (token: string) => {
          if (token === 'owner-token') return { subject: ownerId };
          if (token === 'editor-token') return { subject: editorId };
          if (token === 'viewer-token') return { subject: viewerId };
          if (token === 'other-owner-token') return { subject: otherOwnerId };
          if (token === 'non-member-token') return { subject: nonMemberId };
          if (token === 'dual-member-token') return { subject: dualMemberId };
          if (token === 'admin-token') return { subject: adminId };
          throw new Error('token rejected');
        },
      })
      .overrideProvider(ARTIFACT_STORAGE)
      .useValue(inMemoryStorage)
      .compile();

    application = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(application);
    await application.init();
    await application.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (application) {
      await application.close();
    }
    if (admin) {
      await admin.end();
    }
  });

  describe('Database schema and constraints', () => {
    it('has the report runs table and terminal status constraint installed', async () => {
      const result = await admin.query<{
        tableName: string;
        constraintName: string;
      }>(
        `select c.relname as "tableName", con.conname as "constraintName"
           from pg_class c join pg_constraint con on con.conrelid = c.oid
          where c.relname = 'report_runs' and con.conname = 'report_runs_status_check'`,
      );
      expect(result.rows).toEqual([
        {
          tableName: 'report_runs',
          constraintName: 'report_runs_status_check',
        },
      ]);
    });

    it('rejects a request that does not select exactly one report shape', () => {
      expect(() => createReportRunCommand({ format: 'json' })).toThrow(
        ReportRunCommandValidationError,
      );
      expect(() =>
        createReportRunCommand({
          preset: 'expenses',
          definitionId: 'aaaaaaaa-0000-4000-8000-000000000001',
          format: 'json',
        }),
      ).toThrow(ReportRunCommandValidationError);
    });
  });

  describe('FIX 1: Exchange rate conversion direction', () => {
    it('converts EUR to USD using the available EUR/USD rate', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: {
            from: '2026-06-01',
            to: '2026-06-30',
          },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as {
        id: string;
        status: string;
        downloadUrl: string;
      };
      expect(body.status).toBe('completed');

      // Verify artifact content
      const artifactPath = `${workspace1Id}/${body.id}.json`;
      const uploaded = inMemoryStorage.uploaded.get(artifactPath);
      expect(uploaded).toBeDefined();

      const grid = JSON.parse(uploaded!.content.toString('utf8')) as ReportGrid;
      const eurRow = grid.rows.find((r) => r.key.includes(catExpenseId));
      expect(eurRow).toBeDefined();
      // 100.00 EUR (10000 minor) * 1.10 = 11000 USD minor
      const convertedCell = eurRow?.cells.find(
        (c) => c.measure === 'converted_value',
      );
      expect(convertedCell?.value).toBe('11000');
    });
  });

  describe('FIX 2: Budget join and empty budget policy', () => {
    it('returns 422 with problem-details when budget preset has no applicable budget in period', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'budget',
          format: 'json',
          filters: {
            from: '2026-07-01',
            to: '2026-07-31',
          },
        },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body) as {
        detail?: string;
        errors?: readonly { field: string; message: string }[];
      };
      const message = body.detail ?? body.errors?.[0]?.message;
      expect(message).toContain('No budget exists for the requested period.');
    });

    it('returns 202 and warnings when budget preset has some unbudgeted buckets', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'budget',
          format: 'json',
          filters: {
            from: '2026-06-01',
            to: '2026-06-30',
          },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string };
      const uploaded = inMemoryStorage.uploaded.get(
        `${workspace1Id}/${body.id}.json`,
      );
      expect(uploaded).toBeDefined();
      const grid = JSON.parse(uploaded!.content.toString('utf8')) as ReportGrid;
      expect(
        grid.warnings.some((w) => w.includes('bucket had no budget.')),
      ).toBe(true);
    });

    it('returns 202 with null cells and no error for custom definition with budget measure and no budget', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          definitionId: customDefId,
          format: 'json',
          filters: {
            from: '2026-07-01',
            to: '2026-07-31',
          },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string };
      const uploaded = inMemoryStorage.uploaded.get(
        `${workspace1Id}/${body.id}.json`,
      );
      expect(uploaded).toBeDefined();
      const grid = JSON.parse(uploaded!.content.toString('utf8')) as ReportGrid;
      expect(grid.warnings).toEqual([]);
      const budgetCell = grid.rows[0]?.cells.find(
        (c) => c.measure === 'budget',
      );
      expect(budgetCell?.value).toBeNull();
    });
  });
});
