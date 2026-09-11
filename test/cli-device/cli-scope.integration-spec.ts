import { createHash, randomUUID } from 'node:crypto';
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

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

describe('CLI scope policy HTTP boundary', () => {
  let admin: Pool;
  let application: NestFastifyApplication;
  const ownerId = '11111111-0000-4000-8000-000000000901';
  const viewerId = '22222222-0000-4000-8000-000000000901';
  const workspaceId = 'aaaaaaaa-0000-4000-8000-000000000901';
  const accountId = 'cccccccc-0000-4000-8000-000000000901';
  const debtId = 'dddddddd-0000-4000-8000-000000000901';
  const tokens = {
    accountsRead: 'svt_cli_scope_accounts_read',
    accountsWrite: 'svt_cli_scope_accounts_write',
    transactionWrite: 'svt_cli_scope_transaction_write',
    transactionAndBudgetWrite: 'svt_cli_scope_transaction_budget_write',
    any: 'svt_cli_scope_any',
  } as const;

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
      SAVIA_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
    });
    admin = new Pool({ connectionString: url });
    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4)`,
      [
        ownerId,
        'cli-scope-owner@example.test',
        viewerId,
        'cli-scope-viewer@example.test',
      ],
    );
    for (const [id, email, name] of [
      [ownerId, 'cli-scope-owner@example.test', 'CLI Scope Owner'],
      [viewerId, 'cli-scope-viewer@example.test', 'CLI Scope Viewer'],
    ] as const) {
      await admin.query(
        `insert into public.profiles
         (id, email, display_name, locale, country_code, timezone, date_format,
          week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }
    await admin.query(
      `insert into public.workspaces
       (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'CLI Scope Workspace', 'shared', 'USD', null, $2)`,
      [workspaceId, ownerId],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active'), ($1, $3, 'viewer', 'active')`,
      [workspaceId, ownerId, viewerId],
    );
    await admin.query(
      `insert into public.accounts
       (id, workspace_id, name, type, currency, status, created_by)
       values ($1, $2, 'CLI Scope Account', 'checking', 'USD', 'active', $3)`,
      [accountId, workspaceId, ownerId],
    );
    await admin.query(
      `insert into public.debts
       (id, workspace_id, name, currency, principal_minor, annual_rate, rate_type,
        minimum_payment_minor, start_date, term_months)
       values ($1, $2, 'CLI Scope Debt', 'USD', 100000, 0.05, 'fixed', 1000, '2026-01-01', 12)`,
      [debtId, workspaceId],
    );
    const scopeSets = [
      [tokens.accountsRead, ownerId, ['accounts:read']],
      [tokens.accountsWrite, ownerId, ['accounts:write']],
      [tokens.transactionWrite, ownerId, ['transactions:write']],
      [
        tokens.transactionAndBudgetWrite,
        ownerId,
        ['transactions:write', 'budgets:write'],
      ],
      [tokens.any, ownerId, ['accounts:read']],
      ['svt_cli_scope_viewer_write', viewerId, ['accounts:write']],
    ] as const;
    for (const [index, [token, subjectId, scopes]] of scopeSets.entries()) {
      const deviceCodeHash = createHash('sha256')
        .update(`device-${token}`)
        .digest('hex');
      await admin.query(
        `insert into public.cli_device_authorizations
         (device_code_hash, user_code, client_id, scopes, expires_at)
         values ($1, $2, $3, $4, now() + interval '10 minutes')`,
        [
          deviceCodeHash,
          `ABCD234${['5', '6', '7', '8', '9', 'A'][index]}`,
          token,
          scopes,
        ],
      );
      await admin.query(
        `insert into public.cli_device_tokens
         (token_hash, subject_id, device_code_hash, scopes, expires_at)
         values ($1, $2, $3, $4, now() + interval '10 minutes')`,
        [
          createHash('sha256').update(token).digest('hex'),
          subjectId,
          deviceCodeHash,
          scopes,
        ],
      );
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: async (token: string) => {
          if (token === 'session-owner') return { subject: ownerId };
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

  function headers(token: string, idempotency = false): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      'x-workspace-id': workspaceId,
      ...(idempotency ? { 'idempotency-key': randomUUID() } : {}),
    };
  }

  it('enforces the read/write account matrix over HTTP', async () => {
    const readable = await application.inject({
      method: 'GET',
      url: '/v1/accounts',
      headers: headers(tokens.accountsRead),
    });
    expect(readable.statusCode).toBe(200);

    const deniedWrite = await application.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: headers(tokens.accountsRead, true),
      payload: { name: 'Denied', type: 'checking', currency: 'USD' },
    });
    expect(deniedWrite.statusCode).toBe(403);
  });

  it('requires both scopes for debt payment and allows the complete scope set', async () => {
    const missingBudget = await application.inject({
      method: 'POST',
      url: `/v1/debts/${debtId}/payments`,
      headers: headers(tokens.transactionWrite, true),
      payload: {},
    });
    expect(missingBudget.statusCode).toBe(403);

    const allowed = await application.inject({
      method: 'POST',
      url: `/v1/debts/${debtId}/payments`,
      headers: headers(tokens.transactionAndBudgetWrite, true),
      payload: {
        accountId,
        totalAmount: { amountMinor: '1000', currency: 'USD' },
        occurredAt: '2026-09-10T00:00:00Z',
      },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it('denies session-only operations to CLI tokens and allows empty-scope getCurrentUser', async () => {
    for (const [method, path] of [
      ['POST', '/v1/mcp/grants'],
      ['POST', '/v1/cli/device/approve'],
    ] as const) {
      const response = await application.inject({
        method,
        url: path,
        headers: headers(tokens.any),
        payload: {},
      });
      expect(response.statusCode).toBe(403);
    }
    const profile = await application.inject({
      method: 'GET',
      url: '/v1/me',
      headers: headers(tokens.any),
    });
    expect(profile.statusCode).toBe(200);
  });

  it('leaves JWT sessions unaffected and never widens a viewer role', async () => {
    const session = await application.inject({
      method: 'GET',
      url: '/v1/accounts',
      headers: headers('session-owner'),
    });
    expect(session.statusCode).toBe(200);
    const viewerWrite = await application.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { ...headers('svt_cli_scope_viewer_write', true) },
      payload: {
        name: 'Viewer Cannot Write',
        type: 'checking',
        currency: 'USD',
      },
    });
    expect([403, 404]).toContain(viewerWrite.statusCode);
  });
});
