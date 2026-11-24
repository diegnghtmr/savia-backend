// Migrations under test: 202609060001_approvals.sql, 202609170004_approval_execution.sql, 202609170010_agent_approval_creator.sql
import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AGENT_TOOL_PORTS,
  agentToolDefinitions,
  agentToolRegistry,
  type AgentToolPorts,
} from '../../src/agent/agent-tools.js';
import { AppModule } from '../../src/app.module.js';
import {
  APPROVALS_PORT,
  type ApprovalAction,
  type ApprovalsPort,
} from '../../src/approvals/approval.port.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { createTransactionCommand } from '../../src/ledger/transaction-command.js';
import { createTransferCommand } from '../../src/ledger/transfer-command.js';
import { CliTokenVerifier } from '../../src/platform/cli-token-verifier.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { SAVIA_SCOPES } from '../../src/platform/savia-scopes.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import { mcpTokens } from '../helpers/mcp-jwt.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

describe('Approvals integration contract and endpoint suite', () => {
  let admin: Pool;
  let application: NestFastifyApplication;
  let signed: Awaited<ReturnType<typeof mcpTokens>>;

  const ownerId = '11111111-0000-4000-8000-000000000001';
  const adminId = '77777777-0000-4000-8000-000000000001';
  const editorId = '22222222-0000-4000-8000-000000000001';
  const viewerId = '33333333-0000-4000-8000-000000000001';
  const otherOwnerId = '44444444-0000-4000-8000-000000000001';
  const nonMemberId = '55555555-0000-4000-8000-000000000001';
  const dualMemberId = '66666666-0000-4000-8000-000000000001';

  const workspace1Id = 'aaaaaaaa-0000-4000-8000-000000000001';
  const workspace2Id = 'bbbbbbbb-0000-4000-8000-000000000001';

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
    });

    admin = new Pool({ connectionString: url });

    // 1. Seed auth users & profiles
    await admin.query(
      `insert into auth.users (id, email) values
        ($1, 'approvals-owner@example.test'),
        ($2, 'approvals-admin@example.test'),
        ($3, 'approvals-editor@example.test'),
        ($4, 'approvals-viewer@example.test'),
        ($5, 'approvals-other@example.test'),
        ($6, 'approvals-nonmember@example.test'),
        ($7, 'approvals-dual@example.test')`,
      [
        ownerId,
        adminId,
        editorId,
        viewerId,
        otherOwnerId,
        nonMemberId,
        dualMemberId,
      ],
    );

    for (const [userId, email, name] of [
      [ownerId, 'approvals-owner@example.test', 'Approvals Owner'],
      [adminId, 'approvals-admin@example.test', 'Approvals Administrator'],
      [editorId, 'approvals-editor@example.test', 'Approvals Editor'],
      [viewerId, 'approvals-viewer@example.test', 'Approvals Viewer'],
      [otherOwnerId, 'approvals-other@example.test', 'Approvals Other Owner'],
      [nonMemberId, 'approvals-nonmember@example.test', 'Approvals Non Member'],
      [dualMemberId, 'approvals-dual@example.test', 'Approvals Dual Member'],
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
        ($1, $3, 'administrator', 'active'),
        ($1, $4, 'editor', 'active'),
        ($1, $5, 'viewer', 'active'),
        ($1, $6, 'administrator', 'active'),
        ($7, $8, 'owner', 'active'),
        ($7, $6, 'administrator', 'active'),
        ($7, $4, 'editor', 'active')`,
      [
        workspace1Id,
        ownerId,
        adminId,
        editorId,
        viewerId,
        dualMemberId,
        workspace2Id,
        otherOwnerId,
      ],
    );

    // Bootstrap Nest application
    signed = await mcpTokens();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verifyProposal: (token: string) =>
          signed.verifier.verifyProposal(token),
        verify: async (token: string) => {
          if (token === 'owner-token') return { subject: ownerId };
          if (token === 'admin-token') return { subject: adminId };
          if (token === 'editor-token') return { subject: editorId };
          if (token === 'viewer-token') return { subject: viewerId };
          if (token === 'other-owner-token') return { subject: otherOwnerId };
          if (token === 'non-member-token') return { subject: nonMemberId };
          if (token === 'dual-member-token') return { subject: dualMemberId };
          throw new Error('token rejected');
        },
      })
      .overrideProvider(CliTokenVerifier)
      .useValue({
        verify: async () => ({
          subject: dualMemberId,
          authMethod: 'cli_token',
          scopes: Object.values(SAVIA_SCOPES),
        }),
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
    if (application) {
      await application.close();
    }
    if (admin) {
      await admin.end();
    }
  });

  describe('GET /v1/approvals', () => {
    const list = (
      query = '',
      token = 'dual-member-token',
      workspace = workspace1Id,
    ) =>
      application.inject({
        method: 'GET',
        url: `/v1/approvals${query}`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-workspace-id': workspace,
        },
      });

    it('lists only the session creator’s approvals, filters effective status, and pages without duplicates', async () => {
      const closes = '2099-01-01T00:00:00.000Z';
      const past = '2000-01-02T00:00:00.000Z';
      const insert = async (
        channel: 'agent' | 'mcp',
        status: string,
        expiresAt: string,
        workspace: string,
        subject: string,
        fraction: string,
      ) => {
        const id = randomUUID();
        await admin.query(
          `insert into public.approvals
             (id, workspace_id, tool_name, risk_class, arguments_hash, preview, status,
              expires_at, created_by, channel, created_at, decided_by, decided_at)
           values ($1, $2, 'create_transaction', 'financial_write', 'test-hash', $3, $4, $5, $6, $7,
                   $8, case when $4 in ('approved', 'rejected', 'consumed') then $6::uuid end,
                   case when $4 in ('approved', 'rejected', 'consumed') then now() end)`,
          [
            id,
            workspace,
            { channel },
            status,
            expiresAt,
            subject,
            channel,
            `2000-01-01T00:00:00.${fraction}Z`,
          ],
        );
        return {
          id,
          createdBy: subject,
          toolName: 'create_transaction',
          riskClass: 'financial_write',
          argumentsHash: 'test-hash',
          preview: { channel },
          status,
          expiresAt,
          createdAt: '2000-01-01T00:00:00.000Z',
        };
      };
      const own = (
        channel: 'agent' | 'mcp',
        status: string,
        expiresAt: string,
        microsecond: number,
      ) =>
        insert(
          channel,
          status,
          expiresAt,
          workspace1Id,
          dualMemberId,
          String(microsecond).padStart(6, '0'),
        );
      const first = await own('agent', 'pending', closes, 1);
      const second = await own('mcp', 'pending', closes, 2);
      const elapsed = await own('mcp', 'pending', past, 3);
      const rejected = await own('mcp', 'rejected', past, 4);
      const approved = await own('mcp', 'approved', closes, 5);
      const expired = await own('mcp', 'expired', past, 6);
      const consumed = await own('mcp', 'consumed', closes, 7);
      await insert('agent', 'pending', closes, workspace1Id, ownerId, '000000');
      await insert(
        'mcp',
        'pending',
        closes,
        workspace2Id,
        dualMemberId,
        '000000',
      );

      const firstPage = await list('?limit=1');
      expect(firstPage.statusCode).toBe(200);
      const { pageInfo } = firstPage.json<{
        pageInfo: { nextCursor: string };
      }>();
      expect(pageInfo.nextCursor).toEqual(expect.any(String));
      expect(firstPage.json()).toEqual({
        items: [first],
        pageInfo: { hasNextPage: true, nextCursor: pageInfo.nextCursor },
      });
      const cursor = encodeURIComponent(pageInfo.nextCursor);
      const next = await list(`?limit=1&status=pending&cursor=${cursor}`);
      expect(next.statusCode).toBe(200);
      const end = { hasNextPage: false, nextCursor: null };
      expect(next.json()).toEqual({ items: [second], pageInfo: end });
      for (const [status, items] of [
        ['expired', [{ ...elapsed, status: 'expired' }, expired]],
        ['approved', [approved]],
        ['rejected', [rejected]],
        ['consumed', [consumed]],
      ] as const) {
        const filtered = await list(`?status=${status}`);
        expect(filtered.statusCode).toBe(200);
        expect(filtered.json()).toEqual({ items, pageInfo: end });
      }
      for (const invalid of [
        await list(`?status=expired&cursor=${cursor}`),
        await list(`?cursor=${cursor}`, 'dual-member-token', workspace2Id),
      ]) {
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json()).toMatchObject({
          title: 'Invalid approval list query',
        });
      }
      expect((await list()).json()).toEqual({
        items: [first, second],
        pageInfo: end,
      });
    });

    it.each([
      ['invalid-token', 401],
      ['svt_approvals_cli', 403],
      ['non-member-token', 403],
    ])('denies %s without exposing a preview', async (token, status) => {
      const response = await list('', token);
      expect(response.statusCode).toBe(status);
      expect(response.json()).not.toHaveProperty('items');
    });
  });

  // Exercises the snapshot and creator-only decision policy in 202609170019_mcp_proposals.sql.
  describe('MCP proposals through session confirmation', () => {
    const route = '/v1/mcp/proposals';
    const headers = {
      'x-workspace-id': workspace1Id,
      authorization: 'Bearer editor-token',
    };
    const fullWeek = Array.from({ length: 7 }, (_, day) => ({
      dayOfWeek: day + 1,
      startTime: '00:00',
      endTime: '24:00',
    }));
    const request = (
      method: 'GET' | 'POST' | 'PATCH' | 'PUT',
      url: string,
      payload?: Record<string, unknown>,
      token = 'editor-token',
      key = randomUUID(),
    ) =>
      application.inject({
        method,
        url,
        headers: {
          ...headers,
          authorization: `Bearer ${token}`,
          'idempotency-key': key,
        },
        ...(payload ? { payload } : {}),
      });
    async function account() {
      const result = await request(
        'POST',
        '/v1/accounts',
        { name: 'MCP proposal account', type: 'cash', currency: 'USD' },
        'owner-token',
      );
      expect(result.statusCode).toBe(201);
      return result.json<{ id: string }>().id;
    }
    async function grant(
      accountIds: string[],
      subject = editorId,
      amount: string | null = '25',
      extraTools: string[] = [],
      scopes = ['transactions:write'],
    ) {
      const id = randomUUID();
      const schedule = JSON.stringify(fullWeek);
      await admin.query(
        `insert into public.mcp_grants (id, subject_id, client_name, scopes, workspace_ids, account_ids, tool_allowlist, schedule, max_write_amount_minor, max_write_currency)
         values ($1, $2, 'MCP test client', $8::text[], array[$3::uuid], $4::uuid[], $7::text[], $5::jsonb, $6::bigint, case when $6::bigint is not null then 'USD' end)`,
        [
          id,
          subject,
          workspace1Id,
          accountIds,
          schedule,
          amount,
          ['create_transaction', 'create_transfer', ...extraTools],
          scopes,
        ],
      );
      return { id, token: await signed.sign(editorId, id) };
    }
    const occurredAt = '2026-01-02T00:00:00Z';
    const transaction = (
      accountId: string,
      amountMinor = '25',
      currency = 'USD',
    ) => ({
      toolName: 'create_transaction',
      arguments: {
        accountId,
        type: 'expense',
        amount: { amountMinor, currency },
        occurredAt,
      },
    });
    const transfer = (
      sourceAccountId: string,
      destinationAccountId: string,
      extra = {},
    ) => ({
      toolName: 'create_transfer',
      arguments: {
        sourceAccountId,
        destinationAccountId,
        amount: { amountMinor: '25', currency: 'USD' },
        occurredAt,
        ...extra,
      },
    });
    const get = async (id: string, token = 'editor-token') => {
      const result = await request(
        'GET',
        `/v1/approvals/${id}`,
        undefined,
        token,
      );
      expect(result.statusCode).toBe(200);
      return result.json<{
        id: string;
        argumentsHash: string;
        status: string;
        preview: unknown;
        expiresAt: string;
      }>();
    };
    const list = async (session = 'editor-token') =>
      (await request('GET', '/v1/approvals', undefined, session)).json();
    async function balance(id: string) {
      const result = await request(
        'GET',
        `/v1/accounts/${id}/balance`,
        undefined,
        'owner-token',
      );
      expect(result.statusCode).toBe(200);
      const { nativeBalance } = result.json<{
        nativeBalance: { amountMinor: string };
      }>();
      return nativeBalance.amountMinor;
    }
    async function proposal(
      token: string,
      body: Record<string, unknown>,
      key = randomUUID(),
      session = 'editor-token',
    ) {
      const result = await request('POST', route, body, token, key);
      expect(result.statusCode).toBe(201);
      const created = result.json<{ id: string }>();
      const details = await get(created.id, session);
      expect(result.json()).toEqual({
        id: details.id,
        preview: details.preview,
        expiresAt: details.expiresAt,
        status: 'pending',
      });
      expect(details).toMatchObject({
        riskClass:
          body.toolName === 'void_transaction'
            ? 'destructive'
            : body.toolName === 'create_account'
              ? 'administrative'
              : [
                    'create_budget',
                    'update_budget',
                    'update_budget_allocations',
                    'create_sinking_fund',
                    'update_sinking_fund',
                    'create_report_definition',
                  ].includes(String(body.toolName))
                ? 'low_risk_write'
                : 'financial_write',
        status: 'pending',
        argumentsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      return details;
    }
    const confirm = (
      id: string,
      argumentsHash: string,
      key = randomUUID(),
      token = 'editor-token',
    ) =>
      request(
        'POST',
        `/v1/approvals/${id}/confirm`,
        { argumentsHash },
        token,
        key,
      );

    it.each(['transaction', 'transfer'])(
      'proposes a %s with no ledger effect, then executes exactly once as creator',
      async (tool) => {
        const source = await account();
        const destination = await account();
        const { token } = await grant([source, destination]);
        const isTransfer = tool === 'transfer';
        const body = isTransfer
          ? transfer(source, destination)
          : transaction(source, '-025');
        const key = randomUUID();
        const [pending, replay] = await Promise.all([
          proposal(token, body, key),
          proposal(token, body, key),
        ]);
        expect(replay).toEqual(pending);
        expect(pending.preview).toMatchObject({
          action: body.toolName,
          amount: { amountMinor: isTransfer ? '25' : '-25', currency: 'USD' },
        });
        expect(pending.preview).not.toHaveProperty('grantId');
        const conflict = await request(
          'POST',
          route,
          transaction(source, '24'),
          token,
          key,
        );
        expect(conflict.statusCode).toBe(409);
        expect(await balance(source)).toBe('0');
        expect(await balance(destination)).toBe('0');
        const { id, argumentsHash } = pending;
        const otherActor = await confirm(
          id,
          argumentsHash,
          randomUUID(),
          'admin-token',
        );
        expect(otherActor.statusCode).toBe(403);
        expect((await confirm(id, '0'.repeat(64))).statusCode).toBe(409);
        expect(await get(id)).toEqual(pending);
        const confirmKey = randomUUID();
        const outcomes = await Promise.all([
          confirm(id, argumentsHash, confirmKey),
          confirm(id, argumentsHash, confirmKey),
        ]);
        for (const outcome of outcomes) {
          expect(outcome.statusCode).toBe(200);
          expect(outcome.json()).toEqual({ ...pending, status: 'consumed' });
        }
        expect((await confirm(id, argumentsHash)).statusCode).toBe(409);
        expect(await balance(source)).toBe('-25');
        expect(await balance(destination)).toBe(isTransfer ? '25' : '0');
        expect(await get(id)).toEqual({ ...pending, status: 'consumed' });
      },
    );

    it('denies forged context, invalid tools/arguments and out-of-grant ledger footprints without reserving a key', async () => {
      const source = await account();
      const destination = await account();
      const original = await grant([source]);
      const other = await grant([source], ownerId);
      const revoked = await grant([source]);
      await admin.query(
        "update public.mcp_grants set status = 'revoked', revoked_at = now() where id = $1",
        [revoked.id],
      );
      const before = await list();
      const key = randomUUID();
      for (const [status, token, body] of [
        [403, other.token, transaction(source)],
        [403, revoked.token, transaction(source)],
        [403, original.token, transaction(source, '26')],
        [403, original.token, transaction(source, '25', 'EUR')],
        [403, original.token, transfer(source, destination)],
        [422, original.token, { ...transaction(source), grantId: original.id }],
        [422, original.token, { toolName: 'not_a_tool', arguments: {} }],
        [422, original.token, { toolName: 'list_accounts', arguments: {} }],
        [
          422,
          original.token,
          { toolName: 'update_transaction', arguments: {} },
        ],
        [
          422,
          original.token,
          transfer(source, destination, {
            fee: { amountMinor: '0', currency: 'USD' },
          }),
        ],
        [
          422,
          original.token,
          transfer(source, destination, { description: 'a'.repeat(501) }),
        ],
        [422, original.token, transaction(source, '1.5')],
      ] as const) {
        const response = await request('POST', route, body, token, key);
        expect(response.statusCode).toBe(status);
        expect(response.headers['content-type']).toContain(
          'application/problem+json',
        );
        expect(response.json()).toMatchObject({ status });
      }
      expect(await list()).toEqual(before);
      expect(await balance(source)).toBe('0');
      expect(await balance(destination)).toBe('0');
      await proposal(original.token, transaction(source), key);
    });

    it.each(['update_transaction', 'void_transaction'])(
      '%s binds the current ETag and the stored ledger footprint before reserving an approval',
      async (toolName) => {
        const source = await account();
        const create = await request(
          'POST',
          '/v1/transactions',
          transaction(source, '-25').arguments,
        );
        expect(create.statusCode).toBe(201);
        const { id: transactionId } = create.json<{ id: string }>();
        const url = `/v1/transactions/${transactionId}`;
        const body =
          toolName === 'update_transaction'
            ? { description: 'Approved edit' }
            : { reason: 'Approved void' };
        const { token } = await grant([source], editorId, '25', [toolName]);
        const denied = await grant([source], editorId, '24', [toolName]);
        const before = await list();
        const key = randomUUID();
        const args = { transactionId, ifMatch: create.headers.etag, body };
        const invalid = [
          { transactionId, body },
          { ...args, ifMatch: '"999"' },
          ...(toolName === 'update_transaction'
            ? [{ ...args, body: { categoryId: randomUUID() } }]
            : []),
        ];
        for (const arguments_ of invalid) {
          const response = await request(
            'POST',
            route,
            { toolName, arguments: arguments_ },
            token,
            key,
          );
          expect(response.statusCode).toBe(422);
          expect(response.json()).toMatchObject({
            status: 422,
            title: 'Invalid MCP proposal tool or arguments',
          });
        }
        const blocked = await request(
          'POST',
          route,
          { toolName, arguments: args },
          denied.token,
          key,
        );
        expect(blocked.statusCode).toBe(403);
        expect(blocked.json()).toMatchObject({
          status: 403,
          title: 'MCP grant does not authorize the proposal',
        });
        expect(await list()).toEqual(before);
        expect(await balance(source)).toBe('-25');

        const pending = await proposal(
          token,
          { toolName, arguments: args },
          key,
        );
        expect(pending.preview).toMatchObject({
          transactionId,
          accountId: source,
          ifMatch: create.headers.etag,
          amount: { amountMinor: '-25', currency: 'USD' },
        });
        expect((await request('GET', url)).headers.etag).toBe(
          create.headers.etag,
        );
        const changed = await request('PATCH', url, {
          notes: 'Concurrent change',
        });
        expect(changed.statusCode).toBe(200);
        expect(
          await proposal(token, { toolName, arguments: args }, key),
        ).toEqual(pending);
        const confirmKey = randomUUID();
        const stale = await confirm(
          pending.id,
          pending.argumentsHash,
          confirmKey,
        );
        expect(stale.statusCode).toBe(412);
        expect(stale.json()).toMatchObject({
          status: 412,
          title: 'Precondition failed',
        });
        expect(await get(pending.id)).toEqual(pending);
        expect((await request('GET', url)).json()).toEqual(changed.json());
        expect(await balance(source)).toBe('-25');

        const fresh = await proposal(token, {
          toolName,
          arguments: { ...args, ifMatch: changed.headers.etag },
        });
        const results = await Promise.all([
          confirm(fresh.id, fresh.argumentsHash, confirmKey),
          confirm(fresh.id, fresh.argumentsHash, confirmKey),
        ]);
        for (const response of results) {
          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual({ ...fresh, status: 'consumed' });
        }
        const final = await request('GET', url);
        expect(final.json()).toMatchObject(
          toolName === 'update_transaction' ? body : { status: 'voided' },
        );
        expect(await balance(source)).toBe(
          toolName === 'update_transaction' ? '-25' : '0',
        );
      },
    );

    it('sets, preserves, and clears extraordinary just like HTTP PATCH', async () => {
      const toolName = 'update_transaction';
      const source = await account();
      const create = async () => {
        const response = await request(
          'POST',
          '/v1/transactions',
          transaction(source, '-25').arguments,
        );
        expect(response.statusCode).toBe(201);
        return response.json<{ id: string }>().id;
      };
      const transactionId = await create();
      const path = `/v1/transactions/${transactionId}`;
      const control = `/v1/transactions/${await create()}`;
      const { token } = await grant([source], editorId, '25', [toolName]);
      const initial = await request('GET', path);
      const key = randomUUID();
      const before = await list();
      expectProblem(
        await request(
          'POST',
          route,
          {
            toolName,
            arguments: {
              transactionId,
              ifMatch: initial.headers.etag,
              body: { extraordinary: 'true' },
            },
          },
          token,
          key,
        ),
        422,
        'Invalid MCP proposal tool or arguments',
      );
      expect(await list()).toEqual(before);
      expect((await request('GET', path)).body).toBe(initial.body);
      for (const [body, expected] of [
        [{ extraordinary: true }, true],
        [{ notes: 'Leave extraordinary unchanged' }, true],
        [{ extraordinary: false }, undefined],
      ] as const) {
        const previous = await request('GET', path);
        const pending = await proposal(
          token,
          {
            toolName,
            arguments: {
              transactionId,
              ifMatch: previous.headers.etag,
              body,
            },
          },
          'extraordinary' in body && body.extraordinary ? key : undefined,
        );
        expect(pending.preview).toMatchObject({ body });
        expect((await request('GET', path)).body).toBe(previous.body);
        const done = await confirm(pending.id, pending.argumentsHash);
        expect(done.statusCode).toBe(200);
        expect(done.json()).toEqual({ ...pending, status: 'consumed' });
        expect((await request('PATCH', control, body)).statusCode).toBe(200);
        const actual = await request('GET', path);
        const direct = await request('GET', control);
        expect(actual.statusCode).toBe(200);
        expect(direct.statusCode).toBe(200);
        expect(actual.headers.etag).not.toBe(previous.headers.etag);
        expect(actual.json().extraordinary).toBe(expected);
        expect(actual.json().extraordinary).toBe(direct.json().extraordinary);
        expect(actual.json().notes).toBe(direct.json().notes);
        expect(await balance(source)).toBe('-50');
      }
    });

    it('counts and books a transfer fee once and persists the description like HTTP POST', async () => {
      const source = await account();
      const destination = await account();
      const fee = { amountMinor: '2', currency: 'USD' };
      const description = 'Transfer with a source fee';
      const input = transfer(source, destination, { fee, description });
      const allowed = await grant([source, destination], editorId, '27');
      const capped = await grant([source, destination]);
      const key = randomUUID();
      const before = await list();
      const balances = () =>
        Promise.all([balance(source), balance(destination)]);
      const expenses = async (id: string) => {
        const path = `/v1/transactions?accountId=${id}`;
        const response = await request('GET', path);
        expect(response.statusCode).toBe(200);
        return response.json<{ items: unknown[] }>().items;
      };
      const economicEffect = (accountId: string) => ({
        accountId,
        amount: { ...fee, amountMinor: '-2' },
        type: 'expense',
        status: 'confirmed',
        description,
      });
      expectProblem(
        await request('POST', route, input, capped.token, key),
        403,
        grantDenied,
      );
      expect(await list()).toEqual(before);
      expect(await balances()).toEqual(['0', '0']);
      expect(await expenses(source)).toEqual([]);
      const pending = await proposal(allowed.token, input, key);
      expect(pending.preview).toMatchObject({ fee, description });
      expect(await proposal(allowed.token, input, key)).toEqual(pending);
      expect(await balances()).toEqual(['0', '0']);
      expect(await expenses(source)).toEqual([]);

      const confirmKey = randomUUID();
      const setLimit = (limit: string) =>
        admin.query(
          'update public.mcp_grants set max_write_amount_minor = $2 where id = $1',
          [allowed.id, limit],
        );
      await setLimit('26');
      expectProblem(
        await confirm(pending.id, pending.argumentsHash, confirmKey),
        403,
        decisionDenied,
      );
      expect(await get(pending.id)).toEqual(pending);
      expect(await balances()).toEqual(['0', '0']);
      expect(await expenses(source)).toEqual([]);
      await setLimit('27');
      const done = await confirm(pending.id, pending.argumentsHash, confirmKey);
      expect(done.statusCode).toBe(200);
      expect(done.json()).toEqual({ ...pending, status: 'consumed' });
      const posted = await expenses(source);
      expect(posted).toMatchObject([economicEffect(source)]);
      expect(await balances()).toEqual(['-27', '25']);
      expect(
        (await confirm(pending.id, pending.argumentsHash, confirmKey)).json(),
      ).toEqual(done.json());
      expect(await expenses(source)).toEqual(posted);
      expect(await balances()).toEqual(['-27', '25']);

      const directSource = await account();
      const directDestination = await account();
      const command = transfer(directSource, directDestination, {
        fee,
        description,
      });
      const direct = await request('POST', '/v1/transfers', command.arguments);
      expect(direct.statusCode).toBe(201);
      const directTransfer = direct.json<{ transactionId: string }>();
      expect(directTransfer).toMatchObject({
        fee,
        transactionId: expect.any(String),
      });
      const directExpense = await request(
        'GET',
        `/v1/transactions/${directTransfer.transactionId}`,
      );
      expect(directExpense.statusCode).toBe(200);
      expect(directExpense.json()).toMatchObject(economicEffect(directSource));
      expect(await balance(directSource)).toBe('-27');
      expect(await balance(directDestination)).toBe('25');
    });

    it('checks the create_account grant and currency before reserving a proposal, then posts the approved opening balance once', async () => {
      const toolName = 'create_account';
      const allowed = await grant(
        [],
        ownerId,
        null,
        [toolName],
        ['accounts:write'],
      );
      const denied = await grant(
        [],
        ownerId,
        '24',
        [toolName],
        ['accounts:write'],
      );
      const token = await signed.sign(ownerId, allowed.id);
      const capped = await signed.sign(ownerId, denied.id);
      const session = 'owner-token';
      const accounts = async () =>
        (await request('GET', '/v1/accounts', undefined, session)).json<{
          items: { id: string; name: string }[];
        }>();
      const name = randomUUID();
      const payload = (currency: string) => ({
        toolName,
        arguments: {
          name,
          type: 'cash',
          currency,
          openingBalance: { amountMinor: '25', currency },
        },
      });
      const before = await list(session);
      const accountPage = await accounts();
      const key = randomUUID();
      const blocked = await request('POST', route, payload('USD'), capped, key);
      expect(blocked.json()).toMatchObject({
        status: 403,
        title: 'MCP grant does not authorize the proposal',
      });
      const invalid = await request('POST', route, payload('JPY'), token, key);
      expect(invalid.json()).toMatchObject({
        status: 422,
        title: 'Invalid MCP proposal tool or arguments',
      });
      expect(await list(session)).toEqual(before);
      expect(await accounts()).toEqual(accountPage);
      const pending = await proposal(token, payload('USD'), key, session);
      expect(await accounts()).toEqual(accountPage);
      const confirmKey = randomUUID();
      const done = await confirm(
        pending.id,
        pending.argumentsHash,
        confirmKey,
        session,
      );
      expect(done.statusCode).toBe(200);
      expect(done.json()).toEqual({ ...pending, status: 'consumed' });
      const replay = await confirm(
        pending.id,
        pending.argumentsHash,
        confirmKey,
        session,
      );
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(done.json());
      const created = (await accounts()).items.filter(
        (item) => item.name === name,
      );
      expect(created).toHaveLength(1);
      expect(await balance(created[0].id)).toBe('25');
    });

    it('checks both native legs before creating a currency-exchange proposal and posts both only once', async () => {
      await admin.query(
        `insert into public.exchange_rates (workspace_id, base_currency, quote_currency, rate, effective_at, source, created_by)
         values ($1, 'EUR', 'USD', 1.2, now(), 'manual', $2) on conflict do nothing`,
        [workspace1Id, ownerId],
      );
      const source = await account();
      const eur = await request(
        'POST',
        '/v1/accounts',
        { name: 'FX destination', type: 'cash', currency: 'EUR' },
        'owner-token',
      );
      expect(eur.statusCode).toBe(201);
      const destination = eur.json<{ id: string }>().id;
      const toolName = 'create_cross_currency_transfer';
      const { token } = await grant([source, destination], editorId, null, [
        toolName,
      ]);
      const capped = await grant([source, destination], editorId, '99', [
        toolName,
      ]);
      const onlySource = await grant([source], editorId, null, [toolName]);
      const args = {
        sourceAccountId: source,
        destinationAccountId: destination,
        sourceAmount: { amountMinor: '25', currency: 'USD' },
        destinationAmount: { amountMinor: '20', currency: 'EUR' },
        executedRate: '0.8',
        occurredAt: '2026-01-02T00:00:00Z',
      };
      const body = { toolName, arguments: args };
      const before = await list();
      const key = randomUUID();
      for (const denied of [capped, onlySource]) {
        const blocked = await request('POST', route, body, denied.token, key);
        expect(blocked.json()).toMatchObject({
          status: 403,
          title: 'MCP grant does not authorize the proposal',
        });
      }
      const invalid = {
        toolName,
        arguments: {
          ...args,
          destinationAmount: { ...args.destinationAmount, currency: 'USD' },
        },
      };
      const rejected = await request('POST', route, invalid, token, key);
      expect(rejected.json()).toMatchObject({
        status: 422,
        title: 'Invalid MCP proposal tool or arguments',
      });
      expect(await list()).toEqual(before);
      expect(await balance(source)).toBe('0');
      expect(await balance(destination)).toBe('0');
      const pending = await proposal(token, body, key);
      expect(await proposal(token, body, key)).toEqual(pending);
      expect(await balance(source)).toBe('0');
      expect(await balance(destination)).toBe('0');
      const confirmKey = randomUUID();
      const done = await confirm(pending.id, pending.argumentsHash, confirmKey);
      expect(done.statusCode).toBe(200);
      expect(done.json()).toEqual({ ...pending, status: 'consumed' });
      const replay = await confirm(
        pending.id,
        pending.argumentsHash,
        confirmKey,
      );
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(done.json());
      expect(await balance(source)).toBe('-25');
      expect(await balance(destination)).toBe('20');
    });

    const budgetInput = () => ({
      name: randomUUID(),
      method: 'envelope',
      periodStart: '2030-01-01',
      periodEnd: '2030-01-31',
    });
    async function budgetCategory() {
      const category = await request('POST', '/v1/categories', {
        name: randomUUID(),
        kind: 'expense',
      });
      expect(category.statusCode).toBe(201);
      return category.json<{ id: string }>().id;
    }
    const planned = (categoryId: string, amountMinor = '25') => ({
      categoryId,
      planned: { amountMinor, currency: 'USD' },
      rolloverPolicy: 'none',
    });

    const replaySnapshot = () =>
      Promise.all(
        [
          'mcp_grants',
          'approvals',
          'command_idempotency_records',
          'accounts',
          'transactions',
          'transfers',
          'ledger_postings',
          'budgets',
          'budget_allocations',
          'funds',
          'fund_contributions',
          'report_definitions',
        ].map(async (table) => {
          const { rows } = await admin.query<{ hash: string }>(
            `select md5(coalesce(string_agg(to_jsonb(t)::text, chr(10)
               order by to_jsonb(t)::text), '')) as hash from public.${table} t`,
          );
          return rows[0].hash;
        }),
      );

    const expectReplayProblem = (
      response: Awaited<ReturnType<typeof request>>,
      status: 403 | 409,
    ) => {
      const code = status === 409 ? 'conflict' : 'forbidden';
      expect.soft(response.statusCode).toBe(status);
      expect
        .soft(response.headers['content-type'])
        .toContain('application/problem+json');
      expect.soft(response.json()).toEqual({
        type: `https://savia.app/problems/${code}`,
        title:
          status === 409
            ? 'MCP proposal conflict'
            : 'MCP grant does not authorize the proposal',
        status,
        code,
        instance: route,
        traceId: expect.any(String),
      });
    };

    it.each([
      'create_transaction',
      'create_transfer',
      'update_transaction',
      'void_transaction',
      'create_account',
      'create_cross_currency_transfer',
      'create_budget',
      'update_budget',
      'update_budget_allocations',
      'create_sinking_fund',
      'contribute_to_fund',
      'create_report_definition',
    ])(
      'S12: %s replay requires live grant policy without recalculating amounts',
      async (toolName) => {
        const money = { amountMinor: '25', currency: 'USD' };
        const source = await account();
        let accounts = [source];
        let scopes = ['transactions:write'];
        let actor = editorId;
        let cap: string | null = '25';
        let args: Record<string, unknown> = transaction(
          source,
          '-25',
        ).arguments;
        let drift: (() => ReturnType<typeof request>) | undefined;
        const create = async (
          path: string,
          body: Record<string, unknown>,
          session?: string,
        ) => {
          const response = await request('POST', path, body, session);
          expect(response.statusCode, response.payload).toBe(201);
          return {
            id: response.json<{ id: string }>().id,
            etag: response.headers.etag,
          };
        };
        if (toolName === 'create_transfer') {
          accounts = [source, await account()];
          args = transfer(source, accounts[1]).arguments;
        } else if (
          toolName === 'update_transaction' ||
          toolName === 'void_transaction'
        ) {
          const tx = await create('/v1/transactions', args);
          args = {
            transactionId: tx.id,
            ifMatch: tx.etag,
            body:
              toolName === 'update_transaction'
                ? { description: 'Replay probe' }
                : { reason: 'Replay probe' },
          };
          if (toolName === 'update_transaction') {
            drift = () =>
              request('PATCH', `/v1/transactions/${tx.id}`, {
                notes: 'Changed after proposal',
              });
          }
        } else if (toolName === 'create_account') {
          actor = ownerId;
          scopes = ['accounts:write'];
          accounts = [];
          args = {
            name: randomUUID(),
            type: 'cash',
            currency: 'USD',
            openingBalance: money,
          };
        } else if (toolName === 'create_cross_currency_transfer') {
          await admin.query(
            `insert into public.exchange_rates
             (workspace_id, base_currency, quote_currency, rate, effective_at, source, created_by)
           values ($1, 'EUR', 'USD', 1.2, now(), 'manual', $2) on conflict do nothing`,
            [workspace1Id, ownerId],
          );
          const eur = await create(
            '/v1/accounts',
            {
              name: 'Replay EUR',
              type: 'cash',
              currency: 'EUR',
            },
            'owner-token',
          );
          accounts = [source, eur.id];
          cap = null;
          args = {
            sourceAccountId: source,
            destinationAccountId: eur.id,
            sourceAmount: money,
            destinationAmount: { amountMinor: '20', currency: 'EUR' },
            executedRate: '0.8',
            occurredAt,
          };
        } else if (toolName.includes('budget')) {
          scopes = ['budgets:write'];
          accounts = [];
          const budget = await create('/v1/budgets', budgetInput());
          const category = await budgetCategory();
          const path = `/v1/budgets/${budget.id}`;
          if (toolName === 'create_budget') {
            const allocate = (amount: string) =>
              request('PUT', `${path}/allocations`, {
                allocations: [planned(category, amount)],
              });
            expect((await allocate('25')).statusCode).toBe(200);
            drift = () => allocate('26');
            args = { ...budgetInput(), copyFromBudgetId: budget.id };
          } else {
            args = {
              budgetId: budget.id,
              ifMatch: (await request('GET', path)).headers.etag,
              body:
                toolName === 'update_budget'
                  ? { name: randomUUID() }
                  : { allocations: [planned(category)] },
            };
          }
        } else if (
          toolName === 'create_sinking_fund' ||
          toolName === 'contribute_to_fund'
        ) {
          scopes =
            toolName === 'create_sinking_fund'
              ? ['budgets:write']
              : ['transactions:write', 'budgets:write'];
          args = {
            name: randomUUID(),
            currency: 'USD',
            targetAmount: money,
            linkedAccountId: source,
          };
          if (toolName === 'contribute_to_fund') {
            const fund = await create('/v1/funds', args);
            args = {
              fundId: fund.id,
              body: { accountId: source, amount: money, occurredAt },
            };
          }
        } else if (toolName === 'create_report_definition') {
          scopes = ['reports:write'];
          accounts = [];
          cap = null;
          args = {
            name: randomUUID(),
            dimensions: ['category'],
            measures: ['sum'],
            visualization: 'table',
          };
        }
        scopes.push('accounts:read');
        const extra = ['create_transaction', 'create_transfer'].includes(
          toolName,
        )
          ? []
          : [toolName];
        const { id, token: editorJwt } = await grant(
          accounts,
          actor,
          cap,
          extra,
          scopes,
        );
        const token =
          actor === ownerId ? await signed.sign(actor, id) : editorJwt;
        const key = randomUUID();
        const send = (jwt = token, requestKey = key) =>
          request(
            'POST',
            route,
            { toolName, arguments: args },
            jwt,
            requestKey,
          );
        const first = await send();
        expect(first.statusCode, first.payload).toBe(201);
        const beforeReplay = await replaySnapshot();
        const authorized = await send();
        expect(authorized.statusCode).toBe(201);
        expect(authorized.json()).toEqual(first.json());
        expect(await replaySnapshot()).toEqual(beforeReplay);

        for (const [reason, change, parameters] of [
          ['revoked', "status = 'revoked', revoked_at = now()", [id]],
          ['expired', "expires_at = now() - interval '1 second'", [id]],
          [
            'missing scope',
            'scopes = array_remove(scopes, $2)',
            [id, scopes[0]],
          ],
          [
            'missing tool',
            'tool_allowlist = array_remove(tool_allowlist, $2)',
            [id, toolName],
          ],
        ] as const) {
          await admin.query(
            `update public.mcp_grants set ${change} where id = $1`,
            [...parameters],
          );
          const before = await replaySnapshot();
          expectReplayProblem(await send(), 403);
          expectReplayProblem(await send(token, randomUUID()), 403);
          expect(await replaySnapshot(), reason).toEqual(before);
          await admin.query(
            `update public.mcp_grants set status = 'active', revoked_at = null,
             expires_at = null, scopes = $2, tool_allowlist = $3 where id = $1`,
            [id, scopes, ['create_transaction', 'create_transfer', ...extra]],
          );
        }
        if (toolName === 'create_transaction') {
          const other = await grant(accounts);
          const refreshed = await signed.sign(actor, id, { jti: randomUUID() });
          const replay = await send(refreshed);
          expect(replay.statusCode).toBe(201);
          expect(replay.json()).toEqual(first.json());
          const before = await replaySnapshot();
          expectReplayProblem(await send(other.token), 409);
          const absent = await signed.sign(actor, randomUUID());
          expectReplayProblem(await send(absent, randomUUID()), 403);
          expect(await replaySnapshot()).toEqual(before);
        }
        if (drift) {
          expect((await drift()).statusCode).toBe(200);
          const { id: approvalId } = first.json<{ id: string }>();
          const approval = await get(approvalId);
          const before = await replaySnapshot();
          const replay = await send();
          expect(replay.statusCode).toBe(201);
          expect(replay.json()).toEqual(first.json());
          if (toolName === 'create_budget') {
            expectReplayProblem(await send(token, randomUUID()), 403);
          }
          const stale = await confirm(approvalId, approval.argumentsHash);
          expect(stale.statusCode).toBe(412);
          expect(stale.json().title).toBe('Precondition failed');
          expect(await get(approvalId)).toEqual(approval);
          expect(await replaySnapshot()).toEqual(before);
        }
      },
    );

    it('proposes a normal empty budget without a copy source', async () => {
      const toolName = 'create_budget';
      const { token } = await grant(
        [],
        editorId,
        '25',
        [toolName],
        ['budgets:write'],
      );
      const pending = await proposal(token, {
        toolName,
        arguments: budgetInput(),
      });

      const done = await confirm(pending.id, pending.argumentsHash);
      expect(done.statusCode).toBe(200);
      expect(done.json()).toEqual({ ...pending, status: 'consumed' });
    });

    it('replays the original copy proposal after the source grows above the grant cap', async () => {
      const toolName = 'create_budget';
      const { token } = await grant(
        [],
        editorId,
        '25',
        [toolName],
        ['budgets:write'],
      );
      const source = await request('POST', '/v1/budgets', budgetInput());
      expect(source.statusCode).toBe(201);
      const { id } = source.json<{ id: string }>();
      const category = await budgetCategory();
      const setAmount = (amount: string) =>
        request('PUT', `/v1/budgets/${id}/allocations`, {
          allocations: [planned(category, amount)],
        });

      expect((await setAmount('25')).statusCode).toBe(200);
      const payload = {
        toolName,
        arguments: { ...budgetInput(), copyFromBudgetId: id },
      };
      const key = randomUUID();
      const first = await request('POST', route, payload, token, key);
      expect(first.statusCode).toBe(201);

      expect((await setAmount('26')).statusCode).toBe(200);
      const before = await list();
      const replay = await request('POST', route, payload, token, key);
      expect.soft(replay.statusCode).toBe(201);
      expect.soft(replay.json()).toEqual(first.json());
      expect(await list()).toEqual(before);

      const pending = await get(first.json<{ id: string }>().id);
      const stale = await confirm(pending.id, pending.argumentsHash);
      expect(stale.statusCode).toBe(412);
      expect(stale.json().title).toBe('Precondition failed');
      expect(await get(pending.id)).toEqual(pending);
    });

    it('does not replay a budget proposal preview after its grant is revoked', async () => {
      const toolName = 'create_budget';
      const { id: grantId, token } = await grant(
        [],
        editorId,
        '25',
        [toolName],
        ['budgets:write'],
      );
      const source = await request('POST', '/v1/budgets', budgetInput());
      expect(source.statusCode).toBe(201);
      const { id } = source.json<{ id: string }>();
      const category = await budgetCategory();
      const allocations = await request(
        'PUT',
        `/v1/budgets/${id}/allocations`,
        {
          allocations: [planned(category)],
        },
      );
      expect(allocations.statusCode).toBe(200);

      const payload = {
        toolName,
        arguments: { ...budgetInput(), copyFromBudgetId: id },
      };
      const key = randomUUID();
      const first = await request('POST', route, payload, token, key);
      expect(first.statusCode).toBe(201);
      expect(first.json().preview.allocations).toMatchObject([
        planned(category),
      ]);

      const revoked = await application.inject({
        method: 'DELETE',
        url: `/v1/mcp/grants/${grantId}`,
        headers: { ...headers, 'idempotency-key': randomUUID() },
      });
      expect(revoked.statusCode).toBe(204);

      const before = await list();
      expect((await request('POST', route, payload, token)).statusCode).toBe(
        403,
      );
      const replay = await request('POST', route, payload, token, key);
      expect.soft(replay.statusCode).toBe(403);
      expect.soft(replay.json()).toMatchObject({
        status: 403,
        title: 'MCP grant does not authorize the proposal',
      });
      expect.soft(replay.json()).not.toHaveProperty('preview');
      expect(await list()).toEqual(before);
    });

    it('previews copy-from-budget allocations and rejects a changed source at confirmation', async () => {
      const toolName = 'create_budget';
      const { token } = await grant(
        [],
        editorId,
        '25',
        [toolName],
        ['budgets:write'],
      );
      const denied = await grant(
        [],
        editorId,
        '24',
        [toolName],
        ['budgets:write'],
      );
      const created = await request('POST', '/v1/budgets', budgetInput());
      expect(created.statusCode).toBe(201);
      const sourceId = created.json<{ id: string }>().id;
      const source = `/v1/budgets/${sourceId}`;
      const category = await budgetCategory();
      const initial = await request('PUT', `${source}/allocations`, {
        allocations: [planned(category)],
      });
      expect(initial.statusCode).toBe(200);
      const args = { ...budgetInput(), copyFromBudgetId: sourceId };
      const body = { toolName, arguments: args };
      const before = await list();
      const budgets = async () =>
        (await request('GET', '/v1/budgets')).json<{
          items: { name: string; allocations: unknown }[];
        }>();
      const page = await budgets();
      const key = randomUUID();
      expect(
        (await request('POST', route, body, denied.token, key)).statusCode,
      ).toBe(403);
      const invalid = {
        toolName,
        arguments: { ...args, copyFromBudgetId: randomUUID() },
      };
      expect(
        (await request('POST', route, invalid, token, key)).statusCode,
      ).toBe(422);
      expect(await list()).toEqual(before);
      expect(await budgets()).toEqual(page);
      const pending = await proposal(token, body, key);
      expect(await budgets()).toEqual(page);
      const changed = await request('PUT', `${source}/allocations`, {
        allocations: [planned(category, '99')],
      });
      expect(changed.statusCode).toBe(200);
      const confirmKey = randomUUID();
      expect(
        (await confirm(pending.id, pending.argumentsHash, confirmKey))
          .statusCode,
      ).toBe(412);
      expect(await get(pending.id)).toEqual(pending);
      expect(
        (await budgets()).items.some((item) => item.name === args.name),
      ).toBe(false);
      const reduced = await request('PUT', `${source}/allocations`, {
        allocations: [planned(category, '20')],
      });
      expect(reduced.statusCode).toBe(200);
      const fresh = await proposal(token, body);
      const done = await confirm(fresh.id, fresh.argumentsHash, confirmKey);
      expect(done.statusCode).toBe(200);
      expect(done.json()).toEqual({ ...fresh, status: 'consumed' });
      expect(
        (await confirm(fresh.id, fresh.argumentsHash, confirmKey)).json(),
      ).toEqual(done.json());
      const copies = (await budgets()).items.filter(
        (item) => item.name === args.name,
      );
      expect(copies).toHaveLength(1);
      expect(copies[0].allocations).toMatchObject([planned(category, '20')]);
    });

    it.each(['update_budget', 'update_budget_allocations'])(
      '%s requires If-Match before reserving and never consumes a stale approval',
      async (toolName) => {
        const { token } = await grant(
          [],
          editorId,
          '25',
          [toolName],
          ['budgets:write'],
        );
        const denied = await grant([], editorId, '24', [], ['budgets:write']);
        const created = await request('POST', '/v1/budgets', budgetInput());
        expect(created.statusCode).toBe(201);
        const { id: budgetId } = created.json<{ id: string }>();
        const url = `/v1/budgets/${budgetId}`;
        const read = () => request('GET', url);
        const category = await budgetCategory();
        const body =
          toolName === 'update_budget'
            ? { name: 'Approved budget edit' }
            : { allocations: [planned(category)] };
        const baseline = await read();
        const args = { budgetId, ifMatch: baseline.headers.etag, body };
        const before = await list();
        const key = randomUUID();
        for (const invalid of [
          { budgetId, body },
          { ...args, ifMatch: '"999"' },
        ]) {
          expect(
            (
              await request(
                'POST',
                route,
                { toolName, arguments: invalid },
                token,
                key,
              )
            ).statusCode,
          ).toBe(422);
        }
        if (toolName === 'update_budget_allocations') {
          const invalid = {
            ...args,
            body: { allocations: [planned(randomUUID())] },
          };
          expect(
            (
              await request(
                'POST',
                route,
                { toolName, arguments: invalid },
                token,
                key,
              )
            ).statusCode,
          ).toBe(422);
        }
        expect(
          (
            await request(
              'POST',
              route,
              { toolName, arguments: args },
              denied.token,
              key,
            )
          ).statusCode,
        ).toBe(403);
        expect(await list()).toEqual(before);
        expect((await read()).json()).toEqual(baseline.json());
        const pending = await proposal(
          token,
          { toolName, arguments: args },
          key,
        );
        expect((await read()).headers.etag).toBe(baseline.headers.etag);
        const changed =
          toolName === 'update_budget'
            ? await request('PATCH', url, { name: 'Other budget edit' })
            : await request('PUT', `${url}/allocations`, {
                allocations: [planned(category, '99')],
              });
        expect(changed.statusCode).toBe(200);
        const confirmKey = randomUUID();
        expect(
          (await confirm(pending.id, pending.argumentsHash, confirmKey))
            .statusCode,
        ).toBe(412);
        expect(await get(pending.id)).toEqual(pending);
        expect((await read()).json()).toEqual(changed.json());
        if (toolName === 'update_budget_allocations') {
          const reset = await request('PUT', `${url}/allocations`, {
            allocations: [],
          });
          expect(reset.statusCode).toBe(200);
        }
        const current = await read();
        const fresh = await proposal(token, {
          toolName,
          arguments: { ...args, ifMatch: current.headers.etag },
        });
        const done = await confirm(fresh.id, fresh.argumentsHash, confirmKey);
        expect(done.statusCode).toBe(200);
        expect(done.json()).toEqual({ ...fresh, status: 'consumed' });
        expect(
          (await confirm(fresh.id, fresh.argumentsHash, confirmKey)).json(),
        ).toEqual(done.json());
        expect((await read()).json()).toMatchObject(body);
      },
    );

    it.each([
      {
        toolName: 'create_sinking_fund',
        path: '/v1/funds',
        scope: 'budgets:write',
      },
      {
        toolName: 'create_report_definition',
        path: '/v1/report-definitions',
        scope: 'reports:write',
      },
    ])(
      'validates $toolName before reservation and inserts only on confirmation',
      async ({ toolName, path, scope }) => {
        const isFund = toolName === 'create_sinking_fund';
        const linkedAccountId = isFund ? await account() : undefined;
        const accounts = linkedAccountId ? [linkedAccountId] : [];
        const { token } = await grant(
          accounts,
          editorId,
          null,
          [toolName],
          [scope],
        );
        const denied = await grant(accounts, editorId, null, [], [scope]);
        const name = randomUUID();
        const body = isFund
          ? {
              name,
              currency: 'USD',
              targetAmount: { amountMinor: '25', currency: 'USD' },
              linkedAccountId,
            }
          : {
              name,
              dimensions: ['category'],
              measures: ['sum'],
              visualization: 'table',
            };
        const payload = { toolName, arguments: body };
        const invalid = {
          toolName,
          arguments: isFund
            ? { ...body, targetDate: '0000-01-01' }
            : { ...body, filters: { label: '\u0000' } },
        };
        const before = await list();
        const resources = async () =>
          (await request('GET', path)).json<{ items: { name: string }[] }>();
        const page = await resources();
        const key = randomUUID();
        const blocked = await request(
          'POST',
          route,
          invalid,
          denied.token,
          key,
        );
        expect(blocked.json()).toMatchObject({
          status: 403,
          title: 'MCP grant does not authorize the proposal',
        });
        const rejected = await request('POST', route, invalid, token, key);
        expect(rejected.json()).toMatchObject({
          status: 422,
          title: 'Invalid MCP proposal tool or arguments',
        });
        expect(await list()).toEqual(before);
        expect(await resources()).toEqual(page);
        const pending = await proposal(token, payload, key);
        expect(await resources()).toEqual(page);
        const confirmKey = randomUUID();
        const result = await confirm(
          pending.id,
          pending.argumentsHash,
          confirmKey,
        );
        expect(result.statusCode).toBe(200);
        expect(result.json()).toEqual({ ...pending, status: 'consumed' });
        expect(
          (await confirm(pending.id, pending.argumentsHash, confirmKey)).json(),
        ).toEqual(result.json());
        expect(
          (await resources()).items.filter((item) => item.name === name),
        ).toMatchObject([body]);
        if (linkedAccountId) expect(await balance(linkedAccountId)).toBe('0');
      },
    );

    it('rechecks the fund contribution account at confirmation and posts the approved debit once', async () => {
      const toolName = 'contribute_to_fund';
      const source = await account();
      const other = await account();
      const created = await request('POST', '/v1/funds', {
        name: randomUUID(),
        currency: 'USD',
        targetAmount: { amountMinor: '25', currency: 'USD' },
      });
      expect(created.statusCode).toBe(201);
      const { id: fundId } = created.json<{ id: string }>();
      const scopes = ['transactions:write', 'budgets:write'];
      const { token } = await grant(
        [source, other],
        editorId,
        '25',
        [toolName],
        scopes,
      );
      const denied = await grant([other], editorId, '25', [toolName], scopes);
      const data = (accountId: string, currency = 'USD') => ({
        toolName,
        arguments: {
          fundId,
          body: {
            accountId,
            amount: { amountMinor: '25', currency },
            occurredAt: '2026-01-02T00:00:00Z',
          },
        },
      });
      const fund = async () =>
        (await request('GET', '/v1/funds'))
          .json<{
            items: { id: string; currentAmount: { amountMinor: string } }[];
          }>()
          .items.find(({ id }) => id === fundId);
      const before = await list();
      const key = randomUUID();
      const blocked = await request(
        'POST',
        route,
        data(source),
        denied.token,
        key,
      );
      expect(blocked.json()).toMatchObject({
        status: 403,
        title: 'MCP grant does not authorize the proposal',
      });
      const invalid = await request(
        'POST',
        route,
        {
          toolName,
          arguments: { ...data(source).arguments, fundId: randomUUID() },
        },
        token,
        key,
      );
      expect(invalid.json()).toMatchObject({
        status: 422,
        title: 'Invalid MCP proposal tool or arguments',
      });
      expect(await list()).toEqual(before);
      expect(await balance(source)).toBe('0');
      expect((await fund())?.currentAmount.amountMinor).toBe('0');
      const pending = await proposal(token, data(source), key);
      expect((await fund())?.currentAmount.amountMinor).toBe('0');
      expect(
        (
          await request(
            'POST',
            `/v1/accounts/${source}/close`,
            {},
            'owner-token',
          )
        ).statusCode,
      ).toBe(200);
      const confirmKey = randomUUID();
      expect(
        (await confirm(pending.id, pending.argumentsHash, confirmKey))
          .statusCode,
      ).toBe(422);
      expect(await get(pending.id)).toEqual(pending);
      expect(await balance(source)).toBe('0');
      expect((await fund())?.currentAmount.amountMinor).toBe('0');
      const fresh = await proposal(token, data(other));
      const done = await confirm(fresh.id, fresh.argumentsHash, confirmKey);
      expect(done.statusCode).toBe(200);
      expect(done.json()).toEqual({ ...fresh, status: 'consumed' });
      expect(
        (await confirm(fresh.id, fresh.argumentsHash, confirmKey)).json(),
      ).toEqual(done.json());
      expect(await balance(other)).toBe('-25');
      expect((await fund())?.currentAmount.amountMinor).toBe('25');
    });

    async function createFund() {
      const result = await request('POST', '/v1/funds', {
        name: 'Original fund',
        currency: 'USD',
        targetAmount: { amountMinor: '100', currency: 'USD' },
      });
      expect(result.statusCode).toBe(201);
      return result.json<{ id: string }>().id;
    }

    function expectProblem(
      response: Awaited<ReturnType<typeof request>>,
      status: number,
      title: string,
    ) {
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ status, title });
    }

    const grantDenied = 'MCP grant does not authorize the proposal';
    const decisionDenied = 'Workspace access forbidden';
    const proposalConflict = 'MCP proposal conflict';
    const actionFailed = 'Approved tool action could not be applied';

    it('binds fund updates to a strong ETag and the authorized creator and grant', async () => {
      const toolName = 'update_sinking_fund';
      const scopes = ['budgets:write'];
      const linkedAccountId = await account();
      const other = await account();
      const fundId = await createFund();
      const path = `/v1/funds/${fundId}`;
      const read = () => request('GET', path);
      const original = await read();
      expect(original.statusCode).toBe(200);
      const ifMatch = original.headers.etag;
      const body = { name: 'Approved name', linkedAccountId };
      const input = { toolName, arguments: { fundId, ifMatch, body } };
      const allowed = await grant(
        [linkedAccountId],
        editorId,
        '25',
        [toolName],
        scopes,
      );
      const another = await grant(
        [linkedAccountId],
        editorId,
        '25',
        [toolName],
        scopes,
      );
      const key = randomUUID();
      const before = await list();
      for (const denied of [
        await grant([other], editorId, null, [toolName], scopes),
        await grant([linkedAccountId], editorId, null, [], scopes),
        await grant([linkedAccountId], editorId, null, [toolName]),
      ]) {
        expectProblem(
          await request('POST', route, input, denied.token, key),
          403,
          grantDenied,
        );
      }
      const wrongWorkspace = await application.inject({
        method: 'POST',
        url: route,
        headers: {
          authorization: `Bearer ${allowed.token}`,
          'x-workspace-id': workspace2Id,
          'idempotency-key': key,
        },
        payload: input,
      });
      expectProblem(wrongWorkspace, 403, grantDenied);
      const invalid = await request(
        'POST',
        route,
        {
          ...input,
          arguments: { ...input.arguments, ifMatch: '"stale"' },
        },
        allowed.token,
        key,
      );
      expectProblem(invalid, 422, 'Invalid MCP proposal tool or arguments');
      expect(await list()).toEqual(before);
      expect((await read()).body).toBe(original.body);

      const pending = await proposal(allowed.token, input, key);
      expect(pending.argumentsHash).toBe(
        createHash('sha256')
          .update(
            JSON.stringify({
              body: { linkedAccountId, name: body.name },
              fundId,
              ifMatch,
            }),
          )
          .digest('hex'),
      );
      expect(pending.preview).toEqual({
        ...input.arguments,
        action: toolName,
        workspaceId: workspace1Id,
      });
      expectProblem(
        await request('POST', route, input, another.token, key),
        409,
        proposalConflict,
      );

      const confirmationKey = randomUUID();
      expectProblem(
        await confirm(
          pending.id,
          pending.argumentsHash,
          confirmationKey,
          'owner-token',
        ),
        403,
        decisionDenied,
      );
      expectProblem(
        await request(
          'POST',
          `/v1/approvals/${pending.id}/reject`,
          { argumentsHash: pending.argumentsHash },
          'owner-token',
          confirmationKey,
        ),
        403,
        decisionDenied,
      );
      const wrong = await confirm(pending.id, 'wrong hash', confirmationKey);
      expect(wrong.statusCode).toBe(409);
      expect(wrong.json()).toMatchObject({ detail: 'Arguments hash mismatch' });
      expect(await get(pending.id)).toEqual(pending);
      expect((await read()).body).toBe(original.body);

      const direct = await application.inject({
        method: 'PATCH',
        url: path,
        headers: {
          ...headers,
          'if-match': ifMatch,
          'idempotency-key': randomUUID(),
        },
        payload: { objective: 'Changed by the HTTP route' },
      });
      expect(direct.statusCode).toBe(200);
      expect(direct.headers.etag).not.toBe(ifMatch);
      expect(await proposal(allowed.token, input, key)).toEqual(pending);
      expectProblem(
        await confirm(pending.id, pending.argumentsHash, confirmationKey),
        412,
        'Precondition failed',
      );
      expect(await get(pending.id)).toEqual(pending);
      expect((await read()).body).toBe(direct.body);

      const fresh = await proposal(allowed.token, {
        ...input,
        arguments: { ...input.arguments, ifMatch: direct.headers.etag },
      });
      const setGrantAccount = (id: string) =>
        admin.query(
          'update public.mcp_grants set account_ids = array[$2::uuid] where id = $1',
          [allowed.id, id],
        );
      await setGrantAccount(other);
      expectProblem(
        await confirm(fresh.id, fresh.argumentsHash, confirmationKey),
        403,
        decisionDenied,
      );
      expect(await get(fresh.id)).toEqual(fresh);
      expect((await read()).body).toBe(direct.body);
      await setGrantAccount(linkedAccountId);
      const done = await confirm(
        fresh.id,
        fresh.argumentsHash,
        confirmationKey,
      );
      expect(done.statusCode).toBe(200);
      expect(done.json()).toEqual({ ...fresh, status: 'consumed' });
      const updated = await read();
      expect(updated.headers.etag).not.toBe(direct.headers.etag);
      expect(updated.json()).toMatchObject({
        ...body,
        objective: 'Changed by the HTTP route',
        currentAmount: { amountMinor: '0', currency: 'USD' },
      });
      expect(
        (await confirm(fresh.id, fresh.argumentsHash, confirmationKey)).json(),
      ).toEqual(done.json());
      expect((await read()).body).toBe(updated.body);
      expect(await balance(linkedAccountId)).toBe('0');
    });

    it('rechecks withdrawal grants and rolls back a withdrawal that would overdraw', async () => {
      const toolName = 'withdraw_from_fund';
      const scopes = ['transactions:write', 'budgets:write'];
      const source = await account();
      const destination = await account();
      const fundId = await createFund();
      const path = `/v1/funds/${fundId}`;
      const amount = { amountMinor: '25', currency: 'USD' };
      const body = {
        accountId: destination,
        amount,
        reason: 'Replace a broken appliance.',
      };
      const input = { toolName, arguments: { fundId, body } };
      const fund = async () => (await request('GET', path)).json();
      const transactions = async () => {
        const result = await request(
          'GET',
          `/v1/transactions?accountId=${destination}`,
        );
        expect(result.statusCode).toBe(200);
        return result.json<{ items: unknown[] }>();
      };
      const save = async (occurredAt: string) => {
        const response = await request('POST', `${path}/contributions`, {
          accountId: source,
          amount,
          occurredAt,
        });
        expect(response.statusCode).toBe(201);
      };
      await save('2099-01-01T00:00:00Z');
      const initialFund = await fund();
      const emptyFund = {
        currentAmount: { amountMinor: '0', currency: 'USD' },
      };
      expect(initialFund).toMatchObject(emptyFund);
      const initialTransactions = await transactions();
      expect(initialTransactions.items).toEqual([]);
      const before = await list();
      const key = randomUUID();
      const mint = (accountId = destination, limit = '25', writes = scopes) =>
        grant([accountId], editorId, limit, [toolName], writes);
      const allowed = await mint();
      for (const denied of [
        await mint(source),
        await mint(destination, '25', ['transactions:write']),
        await mint(destination, '25', ['budgets:write']),
        await mint(destination, '24'),
      ]) {
        expectProblem(
          await request('POST', route, input, denied.token, key),
          403,
          grantDenied,
        );
      }
      expect(await list()).toEqual(before);
      const pending = await proposal(allowed.token, input, key);
      const second = await proposal(allowed.token, input);
      expect(pending.preview).toEqual({
        ...input.arguments,
        action: toolName,
        workspaceId: workspace1Id,
      });
      const another = await mint();
      expectProblem(
        await request('POST', route, input, another.token, key),
        409,
        proposalConflict,
      );
      const confirmationKey = randomUUID();
      const setLimit = (limit: string) =>
        admin.query(
          'update public.mcp_grants set max_write_amount_minor = $2 where id = $1',
          [allowed.id, limit],
        );
      await setLimit('24');
      expectProblem(
        await confirm(pending.id, pending.argumentsHash, confirmationKey),
        403,
        decisionDenied,
      );
      await setLimit('25');
      expectProblem(
        await confirm(pending.id, pending.argumentsHash, confirmationKey),
        422,
        actionFailed,
      );
      expect(await get(pending.id)).toEqual(pending);
      expect(await fund()).toEqual(initialFund);
      expect(await balance(destination)).toBe('0');
      expect(await transactions()).toEqual(initialTransactions);

      await save(occurredAt);
      const done = await confirm(
        pending.id,
        pending.argumentsHash,
        confirmationKey,
      );
      expect(done.statusCode).toBe(200);
      expect(done.json()).toEqual({ ...pending, status: 'consumed' });
      expect(await fund()).toMatchObject(emptyFund);
      expect(await balance(destination)).toBe('25');
      const posted = await transactions();
      expect(posted.items).toMatchObject([
        {
          accountId: destination,
          type: 'adjustment',
          status: 'confirmed',
          amount,
          notes: body.reason,
        },
      ]);
      expectProblem(
        await confirm(second.id, second.argumentsHash),
        422,
        actionFailed,
      );
      expect(await get(second.id)).toEqual(second);
      expect(
        (
          await confirm(pending.id, pending.argumentsHash, confirmationKey)
        ).json(),
      ).toEqual(done.json());
      expect(await fund()).toMatchObject(emptyFund);
      expect(await balance(destination)).toBe('25');
      expect(await transactions()).toEqual(posted);
    });

    it('returns the explicit deferred receipt problem without reserving the proposal key', async () => {
      const { token } = await grant([], editorId, null, ['scan_receipt']);
      const key = randomUUID();
      const before = await list();
      const rejected = await request(
        'POST',
        route,
        { toolName: 'scan_receipt', arguments: { file: 'receipt.pdf' } },
        token,
        key,
      );
      expect(rejected.statusCode).toBe(422);
      expect(rejected.json()).toEqual({
        code: 'unprocessable',
        instance: route,
        status: 422,
        title: 'Tool not available for proposals',
        traceId: expect.any(String),
        type: 'https://savia.app/problems/unprocessable',
      });
      expect(await list()).toEqual(before);
      const id = await account();
      const allowed = await grant([id]);
      const pending = await proposal(allowed.token, transaction(id), key);
      expect(pending.status).toBe('pending');
      expect(await balance(id)).toBe('0');
    });

    it('checks the grant before disclosing workspace-dependent proposal validation', async () => {
      const source = await account();
      const closed = await account();
      const open = await account();
      const denied = await grant([source, closed], editorId, '24');
      const allowed = await grant([source, closed, open]);

      const closure = await request(
        'POST',
        `/v1/accounts/${closed}/close`,
        {},
        'owner-token',
      );
      expect(closure.statusCode).toBe(200);

      const before = await list();
      const invalid = transfer(source, closed);
      const key = randomUUID();

      const blocked = await request('POST', route, invalid, denied.token, key);
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().title).toBe(
        'MCP grant does not authorize the proposal',
      );

      const checked = await request('POST', route, invalid, allowed.token, key);
      expect(checked.statusCode).toBe(422);
      expect(checked.json().title).toBe(
        'Invalid MCP proposal tool or arguments',
      );

      expect(await list()).toEqual(before);
      expect(await balance(source)).toBe('0');
      expect(await balance(closed)).toBe('0');
      await proposal(allowed.token, transfer(source, open), key);
    });

    it('rejects a USD-to-EUR transfer with or without a fee without reserving the key', async () => {
      const source = await account();
      await admin.query(
        `insert into public.exchange_rates
           (workspace_id, base_currency, quote_currency, rate, effective_at, source, created_by)
         values ($1, 'EUR', 'USD', 1.08, '2025-01-01T00:00:00Z', 'manual', $2)`,
        [workspace1Id, ownerId],
      );
      const eur = await request(
        'POST',
        '/v1/accounts',
        { name: 'MCP EUR account', type: 'cash', currency: 'EUR' },
        'owner-token',
      );
      expect(eur.statusCode).toBe(201);
      const destination = eur.json<{ id: string }>().id;
      const usdDestination = await account();
      const { token } = await grant(
        [source, destination, usdDestination],
        editorId,
        '27',
      );
      const key = randomUUID();
      const before = await list();

      const fee = { amountMinor: '2', currency: 'USD' };
      for (const extra of [{}, { fee }]) {
        const invalid = transfer(source, destination, extra);
        expectProblem(
          await request('POST', route, invalid, token, key),
          422,
          'Invalid MCP proposal tool or arguments',
        );
        expectProblem(
          await request('POST', '/v1/transfers', invalid.arguments),
          422,
          'Transfer currency mismatch',
        );
      }
      expect(await list()).toEqual(before);
      expect(await balance(source)).toBe('0');
      expect(await balance(destination)).toBe('0');

      const corrected = await request(
        'POST',
        route,
        transfer(source, usdDestination),
        token,
        key,
      );
      expect(corrected.statusCode).toBe(201);
    });

    it.each(['transaction', 'transfer'])(
      'rejects non-native amounts and closed accounts before reserving a %s',
      async (tool) => {
        const source = await account();
        const destination = await account();
        const openDestination = await account();
        const { id, token } = await grant([
          source,
          destination,
          openDestination,
        ]);
        // A grant without an amount cap allows both currencies on its own.
        await admin.query(
          'update public.mcp_grants set max_write_amount_minor = null, max_write_currency = null where id = $1',
          [id],
        );
        const closed = await request(
          'POST',
          `/v1/accounts/${destination}/close`,
          {},
          'owner-token',
        );
        expect(closed.statusCode).toBe(200);
        const [wrongCurrency, closedAccount, valid] =
          tool === 'transfer'
            ? [
                transfer(source, openDestination, {
                  amount: { amountMinor: '25', currency: 'EUR' },
                }),
                transfer(source, destination),
                transfer(source, openDestination),
              ]
            : [
                transaction(source, '25', 'EUR'),
                transaction(destination),
                transaction(source),
              ];
        const key = randomUUID();
        const before = await list();
        for (const invalid of [wrongCurrency, closedAccount]) {
          const response = await request('POST', route, invalid, token, key);
          expect.soft(response.json()).toMatchObject({
            status: 422,
            title: 'Invalid MCP proposal tool or arguments',
          });
        }
        expect.soft(await list()).toEqual(before);
        expect(await balance(source)).toBe('0');
        expect(await balance(destination)).toBe('0');
        await proposal(token, valid, key);
      },
    );

    it('does not reserve a key for invalid transaction references, dates, or an already-linked receipt', async () => {
      const source = await account();
      const receiptId = randomUUID();
      const body = transaction(source);
      const existing = await request('POST', '/v1/transactions', {
        ...body.arguments,
        receiptId,
      });
      expect(existing.statusCode).toBe(201);
      const startingBalance = await balance(source);
      const { token } = await grant([source]);
      const before = await list();
      const key = randomUUID();
      const invalidTitle = 'Invalid MCP proposal tool or arguments';
      for (const [status, title, fields] of [
        [422, invalidTitle, { categoryId: randomUUID() }],
        [422, invalidTitle, { payeeId: randomUUID() }],
        [422, invalidTitle, { occurredAt: '2026-02-30T00:00:00Z' }],
        [409, 'MCP proposal conflict', { receiptId }],
      ] as const) {
        const payload = {
          ...body,
          arguments: { ...body.arguments, ...fields },
        };
        const response = await request('POST', route, payload, token, key);
        expect.soft(response.json()).toMatchObject({ status, title });
      }
      expect.soft(await list()).toEqual(before);
      expect(await balance(source)).toBe(startingBalance);
      await proposal(token, body, key);
    });

    it.each(['revocation', 'expiry', 'schedule', 'role', 'ledger validation'])(
      'rolls back confirmation after %s',
      async (restriction) => {
        const source = await account();
        const { id: grantId, token } = await grant([source]);
        const body = transaction(source);
        const ledgerFailure = restriction === 'ledger validation';
        const pending = await proposal(token, body);
        if (ledgerFailure) {
          const closed = await request(
            'POST',
            `/v1/accounts/${source}/close`,
            {},
            'owner-token',
          );
          expect(closed.statusCode).toBe(200);
        }
        const setRole = (role: string) =>
          admin.query(
            'update public.workspace_memberships set role = $1 where workspace_id = $2 and profile_id = $3',
            [role, workspace1Id, editorId],
          );
        const setGrant = (clause: string) => {
          const sql = `update public.mcp_grants set ${clause} where id = $1`;
          return admin.query(sql, [grantId]);
        };
        if (restriction === 'revocation')
          await setGrant("status = 'revoked', revoked_at = now()");
        if (restriction === 'expiry')
          await setGrant("expires_at = now() - interval '1 second'");
        if (restriction === 'schedule')
          await setGrant("schedule = '[]'::jsonb");
        if (restriction === 'role') await setRole('viewer');
        try {
          const response = await confirm(pending.id, pending.argumentsHash);
          expect(response.statusCode).toBe(ledgerFailure ? 422 : 403);
          expect(await get(pending.id, 'owner-token')).toEqual(pending);
          expect(await balance(source)).toBe('0');
        } finally {
          if (restriction === 'role') await setRole('editor');
        }
      },
    );
  });

  describe('Approval execution foundation', () => {
    const action = {
      toolName: 'create_transaction',
      arguments: { amount: 5, currency: 'USD' },
    };
    const port = () => application.get<ApprovalsPort>(APPROVALS_PORT);
    const conflict = { kind: 'conflict' };
    async function createPending(
      channel: 'agent' | 'mcp' = 'mcp',
      workspace = workspace1Id,
    ) {
      const expiresAt = new Date(Date.now() + 60_000);
      const result = await port().createApproval(editorId, workspace, {
        ...action,
        channel,
        riskClass: 'financial_write',
        preview: action.arguments,
        expiresAt,
      });
      if (result.kind !== 'ok') throw new Error('Expected pending approval');
      expect(result.approval).toMatchObject({
        toolName: action.toolName,
        riskClass: 'financial_write',
        status: 'pending',
        preview: action.arguments,
        expiresAt: expiresAt.toISOString(),
      });
      return result.approval;
    }

    async function approved(workspace = workspace1Id, approver = ownerId) {
      const approval = await createPending('mcp', workspace);
      const result = await port().confirmApproval(
        approver,
        workspace,
        approval.id,
        { argumentsHash: approval.argumentsHash },
        randomUUID(),
      );
      if (result.kind !== 'ok') throw new Error('Expected confirmed approval');
      return result.approval;
    }

    it.each([
      { mode: 'valid', currency: 'USD', status: 200 },
      { mode: 'transfer', currency: 'USD', status: 200 },
      { mode: 'other admin', currency: 'USD', status: 403 },
      { mode: 'expired', currency: 'USD', status: 409 },
      { mode: 'currency mismatch', currency: 'EUR', status: 422 },
      { mode: 'creator lost write access', currency: 'USD', status: 403 },
    ])(
      'handles $mode agent confirmation atomically',
      async ({ mode, currency, status }) => {
        const headers = {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        };
        const account = async (name: string) => {
          const response = await application.inject({
            method: 'POST',
            url: '/v1/accounts',
            headers: { ...headers, 'idempotency-key': randomUUID() },
            payload: { name, type: 'cash', currency: 'USD' },
          });
          expect(response.statusCode).toBe(201);
          return (JSON.parse(response.payload) as { id: string }).id;
        };
        const accountId = await account('Confirmation test');
        const transfer = mode === 'transfer';
        const amount = { amountMinor: '25', currency };
        const occurredAt = '2026-01-02T00:00:00Z';
        const args = transfer
          ? createTransferCommand({
              sourceAccountId: accountId,
              destinationAccountId: await account('Destination'),
              amount,
              occurredAt,
            })
          : createTransactionCommand({
              type: 'expense',
              accountId,
              amount,
              occurredAt,
            });
        const created = await port().createApproval(editorId, workspace1Id, {
          toolName: transfer ? 'create_transfer' : 'create_transaction',
          arguments: { ...args },
          preview: { arguments: args },
          channel: 'agent',
          riskClass: 'financial_write',
          expiresAt: new Date(Date.now() + 60_000),
        });
        if (created.kind !== 'ok') throw new Error('Expected agent approval');
        const { id, argumentsHash } = created.approval;
        if (mode === 'expired')
          await admin.query(
            "update public.approvals set expires_at = now() - interval '1 second' where id = $1",
            [id],
          );
        const changeRole = (role: string) =>
          admin.query(
            'update public.workspace_memberships set role = $1 where workspace_id = $2 and profile_id = $3',
            [role, workspace1Id, editorId],
          );
        if (mode === 'creator lost write access') await changeRole('viewer');
        const confirm = () =>
          application.inject({
            method: 'POST',
            url: `/v1/approvals/${id}/confirm`,
            headers: {
              ...headers,
              authorization:
                mode === 'other admin'
                  ? 'Bearer admin-token'
                  : 'Bearer editor-token',
            },
            payload: { argumentsHash },
          });
        try {
          const result = await confirm();
          expect(result.statusCode).toBe(status);
          if (status === 200) {
            expect(JSON.parse(result.payload)).toEqual({
              ...created.approval,
              status: 'consumed',
            });
            expect((await confirm()).statusCode).toBe(409);
          } else {
            expect(result.headers['content-type']).toContain(
              'application/problem+json',
            );
            expect(JSON.parse(result.payload)).toMatchObject({ status });
          }
          const transactions = await admin.query(
            transfer
              ? 'select created_by from public.transfers where source_account_id = $1'
              : 'select created_by from public.transactions where account_id = $1',
            [accountId],
          );
          expect(transactions.rows).toEqual(
            status === 200 ? [{ created_by: editorId }] : [],
          );
          const stored = await port().getApproval(ownerId, workspace1Id, id);
          expect(stored).toMatchObject({
            kind: 'ok',
            approval: {
              status:
                status === 200
                  ? 'consumed'
                  : mode === 'expired'
                    ? 'expired'
                    : 'pending',
            },
          });
          if (mode === 'other admin') {
            expect(stored).toEqual({ kind: 'ok', approval: created.approval });
            const session = await admin.connect();
            try {
              await beginClaim(session, adminId);
              await expect(
                session.query(
                  "update public.approvals set status = 'approved', decided_by = $2, decided_at = now() where id = $1",
                  [id, adminId],
                ),
              ).rejects.toMatchObject({ code: '42501' });
            } finally {
              await session.query('rollback');
              session.release();
            }
            const reject = await application.inject({
              method: 'POST',
              url: `/v1/approvals/${id}/reject`,
              headers: { ...headers, authorization: 'Bearer admin-token' },
              payload: { argumentsHash },
            });
            expect(reject.statusCode).toBe(403);
            expect(await port().getApproval(ownerId, workspace1Id, id)).toEqual(
              stored,
            );
          }
        } finally {
          if (mode === 'creator lost write access') await changeRole('editor');
        }
      },
    );

    async function reviewAccounts() {
      async function create(name: string) {
        const response = await application.inject({
          method: 'POST',
          url: '/v1/accounts',
          headers: {
            authorization: 'Bearer owner-token',
            'x-workspace-id': workspace1Id,
            'idempotency-key': randomUUID(),
          },
          payload: { name, type: 'cash', currency: 'USD' },
        });
        expect(response.statusCode).toBe(201);
        return response.json<{ id: string }>().id;
      }
      return {
        source: await create('B3 probe source'),
        destination: await create('B3 probe destination'),
      };
    }

    function reviewPropose(
      ports: AgentToolPorts,
      source: string,
      destination: string,
      extra: Record<string, unknown> = {},
    ) {
      return agentToolRegistry.get('create_transfer')!.execute(
        ports,
        { subject: editorId, workspaceId: workspace1Id },
        {
          sourceAccountId: source,
          destinationAccountId: destination,
          amount: { amountMinor: '2000', currency: 'USD' },
          occurredAt: '2026-04-22T00:00:00Z',
          ...extra,
        },
        new AbortController().signal,
      );
    }

    function reviewConfirm(
      id: string,
      argumentsHash: string,
      token = 'editor-token',
    ) {
      return application.inject({
        method: 'POST',
        url: `/v1/approvals/${id}/confirm`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash },
      });
    }

    async function reviewPostings(source: string, destination: string) {
      return (
        await admin.query<{ amount: string; account: string }>(
          `
        select amount_minor::text as amount, account_id::text as account
        from public.ledger_postings where account_id in ($1, $2) order by amount_minor
      `,
          [source, destination],
        )
      ).rows;
    }

    it.each([
      { fee: { amountMinor: '125', currency: 'USD' } },
      { description: 'Rent reimbursement from April' },
      { fee: null },
      { description: null },
    ])(
      'B3 probe: refuses unsupported transfer arguments %j before parsing or persisting',
      async (extra) => {
        const { source, destination } = await reviewAccounts();
        const ports = application.get<AgentToolPorts>(AGENT_TOOL_PORTS);
        const parser = vi.spyOn(ports, 'validateTransfer');
        const snapshot = async () =>
          (
            await admin.query<{ snapshot: string }>(
              `
        select coalesce(jsonb_agg(to_jsonb(a) order by id), '[]')::text as snapshot
        from public.approvals a where workspace_id = $1
      `,
              [workspace1Id],
            )
          ).rows[0]?.snapshot;
        try {
          const before = await snapshot();
          expect(
            await reviewPropose(ports, source, destination, extra),
          ).toStrictEqual({
            kind: 'error',
            value: { error: 'Invalid tool arguments' },
          });
          expect(parser).not.toHaveBeenCalled();
          expect(await snapshot()).toBe(before);
          expect(await reviewPostings(source, destination)).toEqual([]);
        } finally {
          parser.mockRestore();
        }
      },
    );

    it('B3 probe: advertises a plain transfer and posts it only once under concurrent confirms', async () => {
      const definition = agentToolDefinitions.find(
        ({ name }) => name === 'create_transfer',
      );
      expect(definition?.parameters).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      expect(
        Object.keys(
          (definition!.parameters as { properties: object }).properties,
        ).sort(),
      ).toEqual([
        'amount',
        'destinationAccountId',
        'occurredAt',
        'sourceAccountId',
      ]);
      const { source, destination } = await reviewAccounts();
      const ports = application.get<AgentToolPorts>(AGENT_TOOL_PORTS);
      const result = await reviewPropose(ports, source, destination);
      if (result.kind !== 'approval') throw new Error(JSON.stringify(result));
      const id = result.approvalId;
      const fetched = await port().getApproval(editorId, workspace1Id, id);
      if (fetched.kind !== 'ok') throw new Error('Missing approval');
      const { argumentsHash, preview } = fetched.approval;
      expect(preview).toMatchObject({
        sourceAccountId: source,
        destinationAccountId: destination,
        amount: '2000',
        currency: 'USD',
        fee: null,
        consequences:
          'Moves the amount from the source to the destination after confirmation.',
      });
      expect(await reviewPostings(source, destination)).toEqual([]);
      const snapshot = async () =>
        (
          await admin.query<{ saved: string }>(
            'select row_to_json(a)::text as saved from public.approvals a where id = $1',
            [id],
          )
        ).rows[0]?.saved;
      const pending = await snapshot();
      const wrong = await reviewConfirm(id, '0'.repeat(64));
      expect(wrong.statusCode).toBe(409);
      expect(wrong.json()).toMatchObject({ detail: 'Arguments hash mismatch' });
      expect(await snapshot()).toBe(pending);
      expect(
        (await reviewConfirm(id, argumentsHash, 'admin-token')).statusCode,
      ).toBe(403);
      expect(await snapshot()).toBe(pending);
      expect(await reviewPostings(source, destination)).toEqual([]);
      const responses = await Promise.all([
        reviewConfirm(id, argumentsHash),
        reviewConfirm(id, argumentsHash),
      ]);
      expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(responses.find((r) => r.statusCode === 200)?.json()).toMatchObject(
        { status: 'consumed' },
      );
      expect(await reviewPostings(source, destination)).toEqual([
        { amount: '-2000', account: source },
        { amount: '2000', account: destination },
      ]);
      expect(
        (
          await admin.query(
            'select status, created_by, decided_by from public.approvals where id = $1 and used_at is not null',
            [id],
          )
        ).rows,
      ).toEqual([
        { status: 'consumed', created_by: editorId, decided_by: editorId },
      ]);
    });

    async function beginClaim(client: PoolClient, actor = editorId) {
      await client.query('begin');
      await client.query('set local role savia_application');
      await client.query("select set_config('app.subject_id', $1, true)", [
        actor,
      ]);
    }

    async function claim(client: PoolClient, id: string, hash: string) {
      const { rows } = await client.query<{ kind: string }>(
        'select public.claim_approval($1, $2, $3, $4) as kind',
        [workspace1Id, id, action.toolName, hash],
      );
      return rows[0]?.kind;
    }

    async function backendPid(client: PoolClient) {
      const { rows } = await client.query<{ pid: number }>(
        'select pg_backend_pid() as pid',
      );
      if (!rows[0]) throw new Error('Expected backend PID');
      return rows[0].pid;
    }

    async function expectBlocked(waiter: number, holder: number) {
      await expect
        .poll(
          async () => {
            const { rows } = await admin.query<{ blocked: boolean }>(
              'select $2::int = any(pg_blocking_pids($1::int)) as blocked',
              [waiter, holder],
            );
            return rows[0]?.blocked;
          },
          { interval: 5, timeout: 400 },
        )
        .toBe(true);
    }

    it('notifies only the agent approval requester when a pending approval is created', async () => {
      await createPending('agent');
      await createPending('mcp');
      for (const token of ['editor-token', 'owner-token']) {
        const response = await application.inject({
          method: 'GET',
          url: '/v1/notifications',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().items).toEqual(
          token === 'editor-token'
            ? [
                expect.objectContaining({
                  type: 'approval_requested',
                  title: 'Agent action pending approval',
                  read: false,
                }),
              ]
            : [],
        );
      }
    });

    it('commits a pending approval when notification insertion is blocked', async () => {
      const locker = await admin.connect();
      try {
        await locker.query('begin');
        await locker.query('lock table public.notifications in share mode');
        const approval = await createPending('agent');
        const committed = await admin.query(
          'select status from public.approvals where id = $1 and workspace_id = $2',
          [approval.id, workspace1Id],
        );
        expect(committed.rows).toEqual([{ status: 'pending' }]);
        const notifications = await admin.query(
          'select id from public.notifications where workspace_id = $1 and resource_id = $2',
          [workspace1Id, approval.id],
        );
        expect(notifications.rows).toEqual([]);
      } finally {
        await locker.query('rollback').finally(() => locker.release());
      }
    });

    it('does not consume an approval that expires while the claim waits', async () => {
      const { id, argumentsHash } = await approved();
      const locker = await admin.connect();
      const claimant = await admin.connect();
      let pending: Promise<string | undefined> | undefined;
      try {
        const holder = await backendPid(locker);
        const waiter = await backendPid(claimant);
        await beginClaim(claimant);
        await locker.query(
          "update public.approvals set expires_at = clock_timestamp() + interval '1 second' where id = $1",
          [id],
        );
        await locker.query('begin');
        await locker.query(
          'select id from public.approvals where id = $1 for update',
          [id],
        );
        pending = claim(claimant, id, argumentsHash);
        void pending.catch(() => undefined);
        await expectBlocked(waiter, holder);
        await locker.query(
          `select pg_sleep(greatest(0, extract(epoch from expires_at - clock_timestamp()))::double precision + 0.01)
             from public.approvals where id = $1`,
          [id],
        );
        await locker.query('commit');
        expect(await pending).toBe('conflict');
        await claimant.query('commit');
        const { rows } = await admin.query<{
          status: string;
          usedAt: Date | null;
        }>(
          'select status, used_at as "usedAt" from public.approvals where id = $1',
          [id],
        );
        expect(rows).toEqual([{ status: 'approved', usedAt: null }]);
      } finally {
        await locker.query('rollback');
        await pending?.catch(() => undefined);
        await claimant.query('rollback');
        locker.release();
        claimant.release();
      }
    });

    it('does not let the application role consume for another actor or update arbitrary columns', async () => {
      const approval = await approved();
      const { id, argumentsHash } = approval;
      const session = await admin.connect();
      try {
        await beginClaim(session, ownerId);
        expect(await claim(session, id, argumentsHash)).toBe('conflict');
        const update = await session.query(
          "update public.approvals set status = 'consumed' where id = $1",
          [id],
        );
        expect(update.rowCount).toBe(0);
        await expect(
          session.query(
            "update public.approvals set arguments_hash = 'changed' where id = $1",
            [id],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await session.query('rollback');
        session.release();
      }
      expect(await port().getApproval(editorId, workspace1Id, id)).toEqual({
        kind: 'ok',
        approval,
      });
    });

    it('binds every elevated approvals policy to the actor and current workspace', async () => {
      const { rows } = await admin.query<{
        cmd: string;
        qual: string | null;
        with_check: string | null;
      }>(`select cmd, qual, with_check from pg_policies
          where schemaname = 'public' and tablename = 'approvals'
            and 'savia_elevated' = any(roles)
          order by cmd`);
      expect(rows.map(({ cmd }) => cmd)).toEqual(['SELECT', 'UPDATE']);
      for (const row of rows) {
        const predicates =
          row.cmd === 'UPDATE' ? [row.qual, row.with_check] : [row.qual];
        for (const predicate of predicates) {
          expect(predicate).toMatch(/\bworkspace_id\b/);
          expect(predicate).toContain("'app.approval_workspace_id'");
          expect(predicate).toMatch(/\bcreated_by\b/);
          expect(predicate).toContain("'app.subject_id'");
        }
      }
    });

    it('restricts elevated consumption to the actor and current workspace', async () => {
      const other = await approved(workspace2Id, otherOwnerId);
      const session = await admin.connect();
      try {
        await beginClaim(session);
        await session.query('set local role savia_elevated');
        await session.query(
          "select set_config('app.approval_workspace_id', $1, true)",
          [workspace1Id],
        );
        const update = await session.query(
          "update public.approvals set status = 'consumed', used_at = clock_timestamp() where id = $1",
          [other.id],
        );
        expect(update.rowCount).toBe(0);
      } finally {
        await session.query('rollback');
        session.release();
      }
      const stored = await port().getApproval(editorId, workspace2Id, other.id);
      expect(stored).toEqual({ kind: 'ok', approval: other });
    });

    it('commits exactly one concurrent claim and holds the membership lock through the action', async () => {
      const { id, argumentsHash } = await approved();
      const rival = await admin.connect();
      const remover = await admin.connect();
      const entered = Promise.withResolvers<number>();
      const finish = Promise.withResolvers<void>();
      const execute = vi.fn(async (client: TransactionClient) => {
        const { rows } = await client.query<{ pid: number }>(
          'select pg_backend_pid() as pid',
        );
        if (!rows[0]) throw new Error('Expected action transaction PID');
        entered.resolve(rows[0].pid);
        await finish.promise;
        return 'written';
      });
      let competing: Promise<string | undefined> | undefined;
      let removing: Promise<unknown> | undefined;
      const winner = port().executeApprovedAction(
        editorId,
        workspace1Id,
        id,
        action,
        execute,
      );
      void winner.catch(entered.reject);
      try {
        const holder = await entered.promise;
        const rivalPid = await backendPid(rival);
        const removerPid = await backendPid(remover);
        await beginClaim(rival);
        await remover.query('begin');
        competing = claim(rival, id, argumentsHash);
        void competing.catch(() => undefined);
        await expectBlocked(rivalPid, holder);
        removing = remover.query(
          'delete from public.workspace_memberships where workspace_id = $1 and profile_id = $2',
          [workspace1Id, editorId],
        );
        void removing.catch(() => undefined);
        await expectBlocked(removerPid, holder);
        finish.resolve();
        expect(await winner).toEqual({ kind: 'ok', result: 'written' });
        expect(await competing).toBe('conflict');
        await rival.query('commit');
        await removing;
        expect(execute).toHaveBeenCalledTimes(1);
      } finally {
        finish.resolve();
        await winner.catch(() => undefined);
        await competing?.catch(() => undefined);
        await rival.query('rollback');
        await removing?.catch(() => undefined);
        await remover.query('rollback');
        rival.release();
        remover.release();
      }
      const stored = await port().getApproval(editorId, workspace1Id, id);
      expect(stored).toMatchObject({
        kind: 'ok',
        approval: { status: 'consumed' },
      });
    });

    it('binds a confirmed preview to the actor, workspace, tool and canonical arguments for one execution', async () => {
      const approval = await createPending();
      const { id } = approval;
      const api = port();
      const key = randomUUID();
      const confirm = () =>
        application.inject({
          method: 'POST',
          url: `/v1/approvals/${approval.id}/confirm`,
          headers: {
            authorization: 'Bearer admin-token',
            'x-workspace-id': workspace1Id,
            'idempotency-key': key,
          },
          payload: { argumentsHash: approval.argumentsHash },
        });
      const execute = vi.fn().mockResolvedValue('written');
      const run = (
        tool: ApprovalAction = action,
        subject = editorId,
        workspace = workspace1Id,
      ) => {
        return api.executeApprovedAction(subject, workspace, id, tool, execute);
      };
      const read = () => api.getApproval(editorId, workspace1Id, id);
      expect(await run()).toEqual(conflict);
      expect(await read()).toEqual({ kind: 'ok', approval });
      expect((await confirm()).statusCode).toBe(200);

      expect(await run(action, adminId)).toEqual(conflict);
      expect(await run(action, editorId, workspace2Id)).toEqual(conflict);
      const otherTool = { ...action, toolName: 'create_transfer' };
      expect(await run(otherTool)).toEqual(conflict);
      const changed = { ...action, arguments: { amount: 6, currency: 'USD' } };
      expect(await run(changed)).toEqual(conflict);
      expect(execute).not.toHaveBeenCalled();
      expect(await read()).toEqual({
        kind: 'ok',
        approval: { ...approval, status: 'approved' },
      });

      const reordered = {
        ...action,
        arguments: { currency: 'USD', amount: 5 },
      };
      const results = await Promise.all([run(reordered), run(reordered)]);
      expect(results).toContainEqual(conflict);
      expect(results).toContainEqual({ kind: 'ok', result: 'written' });
      expect(execute).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        action.arguments,
      );
      expect(await read()).toEqual({
        kind: 'ok',
        approval: { ...approval, status: 'consumed' },
      });
      expect((await confirm()).statusCode).toBe(409);
    });

    it('does not consume expired approvals or approvals for actors who lost write access', async () => {
      const approval = await createPending('mcp');
      const { id, argumentsHash } = approval;
      const api = port();
      const execute = vi.fn();
      const run = () =>
        api.executeApprovedAction(editorId, workspace1Id, id, action, execute);
      const confirmed = await api.confirmApproval(
        ownerId,
        workspace1Id,
        id,
        { argumentsHash },
        randomUUID(),
      );
      expect(confirmed.kind).toBe('ok');
      const role = (value: string) =>
        admin.query(
          'update public.workspace_memberships set role = $1 where workspace_id = $2 and profile_id = $3',
          [value, workspace1Id, editorId],
        );
      await role('viewer');
      try {
        expect(await run()).toEqual({ kind: 'forbidden' });
      } finally {
        await role('editor');
      }
      const expiresAt = new Date(Date.now() - 1_000).toISOString();
      await admin.query(
        'update public.approvals set expires_at = $1 where id = $2',
        [expiresAt, id],
      );
      expect(await run()).toEqual(conflict);
      expect(execute).not.toHaveBeenCalled();
      const stored = await api.getApproval(editorId, workspace1Id, id);
      expect(stored).toEqual({
        kind: 'ok',
        approval: { ...approval, expiresAt, status: 'approved' },
      });
    });
  });

  describe('Database schema and constraints', () => {
    it('has the approvals table and constraints installed', async () => {
      const result = await admin.query<{
        constraintName: string;
      }>(
        `select con.conname as "constraintName"
           from pg_class c join pg_constraint con on con.conrelid = c.oid
          where c.relname = 'approvals'
          order by con.conname`,
      );
      const names = result.rows.map((r) => r.constraintName);
      expect(names).toContain('approvals_risk_class_check');
      expect(names).toContain('approvals_status_check');
      expect(names).toContain('approvals_preview_is_object_check');
      expect(names).toContain('approvals_decided_state_check');
      expect(names).toContain('approvals_workspace_id_id_key');
    });
  });

  describe('argumentsHash verification', () => {
    it('rejects confirmApproval with 409 Conflict when argumentsHash does not match stored hash', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', 'sha256-correct-hash', '{"symbol": "AAPL"}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          argumentsHash: 'sha256-wrong-hash',
        },
      });

      expect(res.statusCode).toBe(409);
    });

    it('rejects rejectApproval with 409 Conflict when argumentsHash does not match stored hash', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', 'sha256-correct-hash', '{"symbol": "AAPL"}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/reject`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          argumentsHash: 'sha256-wrong-hash',
        },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  describe('Non-pending status rejection', () => {
    it('rejects decision with 409 Conflict when approval status is approved', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, decided_by, decided_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', 'hash-1', '{"symbol": "AAPL"}'::jsonb, 'approved', now() + interval '1 day', $3, now(), $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-1' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('rejects decision with 409 Conflict when approval status is rejected', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, decided_by, decided_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', 'hash-1', '{"symbol": "AAPL"}'::jsonb, 'rejected', now() + interval '1 day', $3, now(), $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-1' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('rejects decision with 409 Conflict when approval status is expired', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', 'hash-1', '{"symbol": "AAPL"}'::jsonb, 'expired', now() - interval '1 hour', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-1' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('rejects decision with 409 Conflict when approval status is consumed', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', 'hash-1', '{"symbol": "AAPL"}'::jsonb, 'consumed', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-1' },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('Read-time expiry evaluation', () => {
    it('reports expired status on getApproval when pending approval expiresAt is in the past', async () => {
      const approvalId = randomUUID();
      // Status in DB column is explicitly 'pending', but expires_at is 1 hour in the past!
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', 'hash-1', '{"symbol": "AAPL"}'::jsonb, 'pending', now() - interval '1 hour', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'GET',
        url: `/v1/approvals/${approvalId}`,
        headers: {
          authorization: 'Bearer viewer-token',
          'x-workspace-id': workspace1Id,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { status: string };
      expect(body.status).toBe('expired');
    });

    it('rejects decision with 409 Conflict when pending approval expiresAt is in the past', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', 'hash-1', '{"symbol": "AAPL"}'::jsonb, 'pending', now() - interval '1 hour', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-1' },
      });

      expect(res.statusCode).toBe(409);
    });

    it('pins expiry boundary: treats expiresAt equal to insertion clock (now()) as expired on GET and confirm', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', 'hash-boundary', '{"symbol": "AAPL"}'::jsonb, 'pending', now(), $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const getRes = await application.inject({
        method: 'GET',
        url: `/v1/approvals/${approvalId}`,
        headers: {
          authorization: 'Bearer viewer-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(getRes.statusCode).toBe(200);
      const getBody = JSON.parse(getRes.body) as { status: string };
      expect(getBody.status).toBe('expired');

      const confirmRes = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-boundary' },
      });
      expect(confirmRes.statusCode).toBe(409);
    });
  });

  describe('Role gating', () => {
    it('permits getApproval for owner, administrator, editor, and viewer', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'export_audit', 'low_risk_write', 'hash-role', '{"all": true}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      for (const token of [
        'owner-token',
        'admin-token',
        'editor-token',
        'viewer-token',
      ]) {
        const res = await application.inject({
          method: 'GET',
          url: `/v1/approvals/${approvalId}`,
          headers: {
            authorization: `Bearer ${token}`,
            'x-workspace-id': workspace1Id,
          },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({
          id: approvalId,
          createdBy: ownerId,
        });
      }
    });

    it('forbids getApproval for non-member with 403 Forbidden', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'export_audit', 'low_risk_write', 'hash-role', '{"all": true}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'GET',
        url: `/v1/approvals/${approvalId}`,
        headers: {
          authorization: 'Bearer non-member-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('preserves legacy confirmation by an owner', async () => {
      const approvalId1 = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'export_audit', 'low_risk_write', 'hash-o', '{}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId1, workspace1Id, ownerId],
      );
      const resOwner = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId1}/confirm`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-o' },
      });
      expect(resOwner.statusCode).toBe(200);
    });

    // 202609170030_creator_only_rejection.sql
    describe('creator-only rejection', () => {
      const argumentsHash = 'hash-creator-reject';
      async function seed() {
        const id = randomUUID();
        await admin.query(
          `insert into public.approvals
             (id, workspace_id, tool_name, risk_class, arguments_hash, status, expires_at, created_by)
           values ($1, $2, 'export_audit', 'low_risk_write', $3, 'pending', now() + interval '1 day', $4)`,
          [id, workspace1Id, argumentsHash, editorId],
        );
        return id;
      }
      const reject = (id: string, token: string, key: string) =>
        application.inject({
          method: 'POST',
          url: `/v1/approvals/${id}/reject`,
          headers: {
            authorization: `Bearer ${token}`,
            'x-workspace-id': workspace1Id,
            'idempotency-key': key,
          },
          payload: { argumentsHash },
        });
      const digest = async (id: string, key: string) => {
        const { rows } = await admin.query<{ digest: string }>(
          `select md5(jsonb_build_array(to_jsonb(a), (
             select jsonb_agg(to_jsonb(i) order by i.subject_id, i.route)
             from public.command_idempotency_records i
             where i.workspace_id = a.workspace_id and i.idempotency_key = $2
           ))::text) as digest
           from public.approvals a where a.id = $1`,
          [id, key],
        );
        return rows[0]?.digest;
      };

      it.each(['owner-token', 'admin-token', 'viewer-token'])(
        'returns 403 with no change or reservation for %s',
        async (token) => {
          const id = await seed();
          const key = randomUUID();
          const before = await digest(id, key);
          expect(before).toEqual(expect.any(String));
          const response = await reject(id, token, key);
          expect.soft(response.statusCode).toBe(403);
          expect
            .soft(response.headers['content-type'])
            .toContain('application/problem+json');
          expect.soft(response.json()).toMatchObject({
            status: 403,
            title: 'Workspace access forbidden',
          });
          expect(await digest(id, key)).toBe(before);
        },
      );

      it('lets the creator reject and replay the same response without a second write', async () => {
        const id = await seed();
        const key = randomUUID();
        const first = await reject(id, 'editor-token', key);
        expect(first.statusCode).toBe(200);
        expect(first.json()).toMatchObject({
          id,
          createdBy: editorId,
          status: 'rejected',
        });
        const after = await digest(id, key);
        const replay = await reject(id, 'editor-token', key);
        expect(replay.statusCode).toBe(200);
        expect(replay.json()).toEqual(first.json());
        expect(await digest(id, key)).toBe(after);
      });

      it.each([ownerId, adminId])(
        'also denies a direct application-role rejection by %s',
        async (actor) => {
          const id = await seed();
          const client = await admin.connect();
          try {
            await client.query('begin');
            await client.query('set local role savia_application');
            await client.query(
              "select set_config('app.subject_id', $1, true)",
              [actor],
            );
            await expect(
              client.query(
                "update public.approvals set status = 'rejected', decided_by = $2, decided_at = now() where id = $1",
                [id, actor],
              ),
            ).rejects.toMatchObject({ code: '42501' });
          } finally {
            await client.query('rollback');
            client.release();
          }
        },
      );
    });

    it('forbids confirmApproval and rejectApproval for editor with 403 Forbidden', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'export_audit', 'low_risk_write', 'hash-e', '{}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const confirmRes = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-e' },
      });
      expect(confirmRes.statusCode).toBe(403);

      const rejectRes = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/reject`,
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-e' },
      });
      expect(rejectRes.statusCode).toBe(403);
    });

    it('forbids confirmApproval and rejectApproval for viewer with 403 Forbidden', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'export_audit', 'low_risk_write', 'hash-v', '{}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const confirmRes = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer viewer-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-v' },
      });
      expect(confirmRes.statusCode).toBe(403);

      const rejectRes = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/reject`,
        headers: {
          authorization: 'Bearer viewer-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-v' },
      });
      expect(rejectRes.statusCode).toBe(403);
    });
  });

  describe('Reason code-point validation', () => {
    it('accepts decision with exactly 500 astral emoji characters in reason', async () => {
      const approvalId = randomUUID();
      const hash = 'hash-emoji';
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'export_audit', 'low_risk_write', $3, '{}'::jsonb, 'pending', now() + interval '1 day', $4
        )`,
        [approvalId, workspace1Id, hash, ownerId],
      );

      const emoji500 = '🎉'.repeat(500);
      expect([...emoji500].length).toBe(500);

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          argumentsHash: hash,
          reason: emoji500,
        },
      });

      expect(res.statusCode).toBe(200);
    });

    it('rejects decision with 501 astral emoji characters in reason with 422 Unprocessable', async () => {
      const approvalId = randomUUID();
      const hash = 'hash-emoji';
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'export_audit', 'low_risk_write', $3, '{}'::jsonb, 'pending', now() + interval '1 day', $4
        )`,
        [approvalId, workspace1Id, hash, ownerId],
      );

      const emoji501 = '🎉'.repeat(501);
      expect([...emoji501].length).toBe(501);

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          argumentsHash: hash,
          reason: emoji501,
        },
      });

      expect(res.statusCode).toBe(422);
    });
  });

  describe('Workspace scoping with dual-workspace member', () => {
    it('returns 404 for getApproval across workspace boundaries with dual member', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'tool_ws1', 'administrative', 'hash-cross', '{}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      // Dual member tries to access approval in workspace 1 using workspace 2 header
      const res = await application.inject({
        method: 'GET',
        url: `/v1/approvals/${approvalId}`,
        headers: {
          authorization: 'Bearer dual-member-token',
          'x-workspace-id': workspace2Id,
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for confirmApproval across workspace boundaries with dual member', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'tool_ws1', 'administrative', 'hash-cross', '{}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer dual-member-token',
          'x-workspace-id': workspace2Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-cross' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for rejectApproval across workspace boundaries with dual member', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'tool_ws1', 'administrative', 'hash-cross', '{}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/reject`,
        headers: {
          authorization: 'Bearer dual-member-token',
          'x-workspace-id': workspace2Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-cross' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('Decision persistence', () => {
    it('persists approved status, decided_by, decided_at, and reason on confirm', async () => {
      const approvalId = randomUUID();
      const hash = 'hash-persist-confirm';
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'destructive_tool', 'destructive', $3, '{"table": "logs"}'::jsonb, 'pending', now() + interval '1 day', $4
        )`,
        [approvalId, workspace1Id, hash, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          argumentsHash: hash,
          reason: 'Authorized by admin',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: approvalId,
        createdBy: ownerId,
        status: 'approved',
      });

      // Verify row state directly in database
      const dbRow = await admin.query<{
        status: string;
        decided_by: string;
        decided_at: Date;
        decision_reason: string;
      }>(
        `select status, decided_by, decided_at, decision_reason from public.approvals where id = $1`,
        [approvalId],
      );

      expect(dbRow.rows[0]?.status).toBe('approved');
      expect(dbRow.rows[0]?.decided_by).toBe(adminId);
      expect(dbRow.rows[0]?.decided_at).toBeDefined();
      expect(dbRow.rows[0]?.decision_reason).toBe('Authorized by admin');
    });

    it('persists rejected status, decided_by, decided_at, and reason on reject', async () => {
      const approvalId = randomUUID();
      const hash = 'hash-persist-reject';
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'destructive_tool', 'destructive', $3, '{"table": "logs"}'::jsonb, 'pending', now() + interval '1 day', $4
        )`,
        [approvalId, workspace1Id, hash, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/reject`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          argumentsHash: hash,
          reason: 'Rejected by creator',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: approvalId,
        createdBy: ownerId,
        status: 'rejected',
      });

      const dbRow = await admin.query<{
        status: string;
        decided_by: string;
        decided_at: Date;
        decision_reason: string;
      }>(
        `select status, decided_by, decided_at, decision_reason from public.approvals where id = $1`,
        [approvalId],
      );

      expect(dbRow.rows[0]?.status).toBe('rejected');
      expect(dbRow.rows[0]?.decided_by).toBe(ownerId);
      expect(dbRow.rows[0]?.decided_at).toBeDefined();
      expect(dbRow.rows[0]?.decision_reason).toBe('Rejected by creator');
    });
  });

  describe('Idempotency handling', () => {
    it('replays identical response for repeated confirm with same idempotency key', async () => {
      const approvalId = randomUUID();
      const hash = 'hash-idem';
      const idemKey = randomUUID();

      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'tool_idem', 'financial_write', $3, '{}'::jsonb, 'pending', now() + interval '1 day', $4
        )`,
        [approvalId, workspace1Id, hash, ownerId],
      );

      const res1 = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idemKey,
        },
        payload: { argumentsHash: hash, reason: 'First try' },
      });
      expect(res1.statusCode).toBe(200);
      const body1 = JSON.parse(res1.body);

      const res2 = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idemKey,
        },
        payload: { argumentsHash: hash, reason: 'First try' },
      });
      expect(res2.statusCode).toBe(200);
      const body2 = JSON.parse(res2.body);
      expect(body2).toEqual(body1);
    });

    it('rejects repeated confirm with different payload using same idempotency key with 409 Conflict', async () => {
      const approvalId = randomUUID();
      const hash = 'hash-idem-diff';
      const idemKey = randomUUID();

      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'tool_idem', 'financial_write', $3, '{}'::jsonb, 'pending', now() + interval '1 day', $4
        )`,
        [approvalId, workspace1Id, hash, ownerId],
      );

      const res1 = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idemKey,
        },
        payload: { argumentsHash: hash, reason: 'First reason' },
      });
      expect(res1.statusCode).toBe(200);

      const res2 = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idemKey,
        },
        payload: { argumentsHash: hash, reason: 'Different reason' },
      });
      expect(res2.statusCode).toBe(409);
    });

    it('rejects repeated confirm on consumed approval with 409 Conflict even with same idempotency key', async () => {
      const approvalId = randomUUID();
      const hash = 'hash-idem-consumed';
      const idemKey = randomUUID();

      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'tool_idem', 'financial_write', $3, '{}'::jsonb, 'pending', now() + interval '1 day', $4
        )`,
        [approvalId, workspace1Id, hash, ownerId],
      );

      const res1 = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idemKey,
        },
        payload: { argumentsHash: hash, reason: 'First try' },
      });
      expect(res1.statusCode).toBe(200);

      // Transition the row to consumed
      await admin.query(
        `update public.approvals set status = 'consumed', decided_by = null, decided_at = null where id = $1`,
        [approvalId],
      );

      const res2 = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idemKey,
        },
        payload: { argumentsHash: hash, reason: 'First try' },
      });
      expect(res2.statusCode).toBe(409);
    });

    it('rejects repeated confirm on expired approval with 409 Conflict even with original idempotency key', async () => {
      const approvalId = randomUUID();
      const hash = 'hash-idem-expired';
      const idemKey = randomUUID();

      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'tool_idem', 'financial_write', $3, '{}'::jsonb, 'pending', now() + interval '1 day', $4
        )`,
        [approvalId, workspace1Id, hash, ownerId],
      );

      const res1 = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idemKey,
        },
        payload: { argumentsHash: hash, reason: 'First try' },
      });
      expect(res1.statusCode).toBe(200);

      // Now expire the row
      await admin.query(
        `update public.approvals set expires_at = now() - interval '1 second' where id = $1`,
        [approvalId],
      );

      const res2 = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idemKey,
        },
        payload: { argumentsHash: hash, reason: 'First try' },
      });
      expect(res2.statusCode).toBe(409);
    });

    it('rejects confirm with 409 Conflict when approval was rejected even with original reject key', async () => {
      const approvalId = randomUUID();
      const hash = 'hash-idem-rejected';
      const idemKey = randomUUID();

      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'tool_idem', 'financial_write', $3, '{}'::jsonb, 'pending', now() + interval '1 day', $4
        )`,
        [approvalId, workspace1Id, hash, ownerId],
      );

      const res1 = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/reject`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idemKey,
        },
        payload: { argumentsHash: hash, reason: 'Reject first' },
      });
      expect(res1.statusCode).toBe(200);

      // Attempting confirm on rejected approval with the original key
      const res2 = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idemKey,
        },
        payload: { argumentsHash: hash, reason: 'Reject first' },
      });
      expect(res2.statusCode).toBe(409);
    });

    it('rejects reject with 409 Conflict when approval was approved even with original confirm key', async () => {
      const approvalId = randomUUID();
      const hash = 'hash-idem-approved';
      const idemKey = randomUUID();

      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'tool_idem', 'financial_write', $3, '{}'::jsonb, 'pending', now() + interval '1 day', $4
        )`,
        [approvalId, workspace1Id, hash, ownerId],
      );

      const res1 = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idemKey,
        },
        payload: { argumentsHash: hash, reason: 'Confirm first' },
      });
      expect(res1.statusCode).toBe(200);

      // Attempting reject on approved approval with the original key
      const res2 = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/reject`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idemKey,
        },
        payload: { argumentsHash: hash, reason: 'Confirm first' },
      });
      expect(res2.statusCode).toBe(409);
    });
  });

  describe('Concurrent decision race condition', () => {
    it('serialises concurrent decisions so exactly one succeeds and one receives 409 Conflict', async () => {
      const approvalId = randomUUID();
      const hash = 'hash-concurrent';
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', $3, '{}'::jsonb, 'pending', now() + interval '1 day', $4
        )`,
        [approvalId, workspace1Id, hash, ownerId],
      );

      // Install temporary BEFORE UPDATE trigger to make the race deterministic
      await admin.query(`
        create or replace function public.test_delay_approval_update() returns trigger as $$
        begin
          perform pg_sleep(0.3);
          return new;
        end;
        $$ language plpgsql;

        drop trigger if exists trg_test_delay_approval_update on public.approvals;
        create trigger trg_test_delay_approval_update
        before update on public.approvals
        for each row execute function public.test_delay_approval_update();
      `);

      try {
        const [confirmRes, rejectRes] = await Promise.all([
          application.inject({
            method: 'POST',
            url: `/v1/approvals/${approvalId}/confirm`,
            headers: {
              authorization: 'Bearer owner-token',
              'x-workspace-id': workspace1Id,
              'idempotency-key': randomUUID(),
            },
            payload: { argumentsHash: hash, reason: 'Owner confirmation' },
          }),
          application.inject({
            method: 'POST',
            url: `/v1/approvals/${approvalId}/reject`,
            headers: {
              authorization: 'Bearer owner-token',
              'x-workspace-id': workspace1Id,
              'idempotency-key': randomUUID(),
            },
            payload: { argumentsHash: hash, reason: 'Creator rejection' },
          }),
        ]);

        const statusCodes = [confirmRes.statusCode, rejectRes.statusCode].sort(
          (a, b) => a - b,
        );
        expect(statusCodes).toEqual([200, 409]);

        const rowResult = await admin.query<{ status: string }>(
          `select status from public.approvals where id = $1`,
          [approvalId],
        );
        expect(['approved', 'rejected']).toContain(rowResult.rows[0]?.status);
      } finally {
        await admin.query(`
          drop trigger if exists trg_test_delay_approval_update on public.approvals;
          drop function if exists public.test_delay_approval_update();
        `);
      }
    });
  });
});
