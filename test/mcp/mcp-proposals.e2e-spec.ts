import { randomUUID } from 'node:crypto';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { ApprovalService } from '../../src/approvals/approval.service.js';
import { FundService } from '../../src/funds/fund.service.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { TransactionService } from '../../src/ledger/transaction.service.js';
import { TransferService } from '../../src/ledger/transfer.service.js';
import { PostgresMcpGrantAdapter } from '../../src/mcp/postgres-mcp-grant.adapter.js';
import { AuthConfig } from '../../src/platform/auth-config.js';
import { CliTokenVerifier } from '../../src/platform/cli-token-verifier.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { CLI_SCOPE_POLICY } from '../../src/platform/cli-scope-policy.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import { SAVIA_SCOPES } from '../../src/platform/savia-scopes.js';
import { mcpAuthEnvironment, mcpTokens } from '../helpers/mcp-jwt.js';

const path = '/v1/mcp/proposals';
const subject = randomUUID();
const grant = randomUUID();
const sessionAudience = mcpAuthEnvironment.JWT_AUDIENCE;
const proposalAudience = mcpAuthEnvironment.SAVIA_MCP_PROPOSAL_AUDIENCE;

async function harness(
  audience?: string,
  configure?: (builder: TestingModuleBuilder) => void,
) {
  const env = { ...mcpAuthEnvironment, SAVIA_MCP_PROPOSAL_AUDIENCE: audience };
  const tokens = await mcpTokens(env);
  const cli = vi.fn(async () => ({
    subject,
    authMethod: 'cli_token',
    scopes: Object.values(SAVIA_SCOPES),
  }));
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AuthConfig)
    .useValue(AuthConfig.fromEnvironment(env))
    .overrideProvider(JoseJwtVerifier)
    .useValue(tokens.verifier)
    .overrideProvider(CliTokenVerifier)
    .useValue({ verify: cli });
  configure?.(builder);
  const module = await builder.compile();
  const app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ exposeHeadRoutes: false }),
  );
  registerProblemFilter(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, cli, ...tokens };
}

describe('MCP proposal write dispatch', () => {
  const workspaceId = randomUUID();
  const fundId = randomUUID();
  const accountId = randomUUID();
  const id = randomUUID();
  const expiresAt = '2027-01-01T00:00:00.000Z';
  const ifMatch = '"actual-strong-etag"';
  const amount = { amountMinor: '00025', currency: 'USD' };
  const bookedAmount = { amountMinor: '25', currency: 'USD' };

  async function proposals() {
    const authorizeMcpGrant = vi.fn().mockResolvedValue(true);
    const checkCreateAccounts = vi.fn().mockResolvedValue(undefined);
    const checkUpdateWithin = vi.fn().mockResolvedValue({ kind: 'ok' });
    const checkContributionWithin = vi.fn().mockResolvedValue({ kind: 'ok' });
    const create = vi.fn<ApprovalService['createMcpProposal']>(
      async (
        _subject,
        _workspace,
        { preview },
        _key,
        _replay,
        authorize,
        validate,
      ) => {
        const client = {} as TransactionClient;
        if (!(await authorize(client))) return { kind: 'forbidden' };
        const kind = await validate(client);
        return kind === 'ok'
          ? { kind, body: { id, preview, expiresAt, status: 'pending' } }
          : { kind };
      },
    );
    const { app, sign } = await harness(proposalAudience, (builder) => {
      builder
        .overrideProvider(ApprovalService)
        .useValue({ createMcpProposal: create });
      builder
        .overrideProvider(FundService)
        .useValue({ checkUpdateWithin, checkContributionWithin });
      builder
        .overrideProvider(PostgresMcpGrantAdapter)
        .useValue({ authorizeMcpGrant });
      builder
        .overrideProvider(TransferService)
        .useValue({ checkCreateAccounts });
      builder.overrideProvider(TransactionService).useValue({
        readWithin: vi.fn().mockResolvedValue({
          accountId,
          amount: bookedAmount,
          version: 1,
          status: 'confirmed',
        }),
        preflightUpdateFields: vi.fn().mockResolvedValue(true),
      });
    });
    const token = await sign(subject, grant);
    const key = randomUUID();
    return {
      app,
      create,
      authorizeMcpGrant,
      send: (
        toolName: string,
        args: Record<string, unknown>,
        idempotencyKey = key,
      ) =>
        app.inject({
          method: 'POST',
          url: path,
          headers: {
            authorization: `Bearer ${token}`,
            'x-workspace-id': workspaceId,
            'idempotency-key': idempotencyKey,
          },
          payload: { toolName, arguments: args },
        }),
    };
  }

  it.each([
    {
      tool: 'update_sinking_fund',
      args: {
        fundId,
        ifMatch,
        body: {
          objective: null,
          targetAmount: amount,
          linkedAccountId: accountId,
        },
      },
      previewBody: {
        objective: null,
        targetAmount: { ...amount, amountMinor: '25' },
        linkedAccountId: accountId,
      },
      invalid: [
        { fundId, body: { name: 'New name' } },
        { fundId, ifMatch: '*', body: { name: 'New name' } },
        { fundId, ifMatch: `W/${ifMatch}`, body: { name: 'New name' } },
        { fundId, ifMatch, body: {} },
        { fundId, ifMatch, body: { currency: 'EUR' } },
        { fundId, ifMatch, body: { targetDate: '2027-02-29' } },
        { fundId, ifMatch, body: { responsibleMemberIds: [id, id] } },
      ],
    },
    {
      tool: 'withdraw_from_fund',
      args: {
        fundId,
        body: { accountId, amount, reason: 'Replace a broken appliance.' },
      },
      previewBody: {
        accountId,
        amount: { ...amount, amountMinor: '25' },
        reason: 'Replace a broken appliance.',
      },
      invalid: [
        { fundId: 'invalid', body: { accountId, amount, reason: 'Repair' } },
        { fundId, body: { accountId, amount } },
        { fundId, body: { accountId, amount, reason: ' ' } },
        { fundId, body: { accountId, amount, reason: 'a'.repeat(501) } },
        {
          fundId,
          body: {
            accountId,
            amount: { ...amount, amountMinor: '0' },
            reason: 'Repair',
          },
        },
        {
          fundId,
          body: {
            accountId,
            amount: { ...amount, amountMinor: '9223372036854775808' },
            reason: 'Repair',
          },
        },
        {
          fundId,
          body: {
            accountId,
            amount,
            reason: 'Repair',
            occurredAt: '2026-01-01T00:00:00Z',
          },
        },
      ],
    },
  ])(
    'validates and dispatches $tool through the proposal endpoint',
    async ({ tool, args, previewBody, invalid }) => {
      const { app, create, send } = await proposals();
      try {
        for (const malformed of invalid) {
          const rejected = await send(tool, malformed);
          expect(rejected.statusCode).toBe(422);
          expect(rejected.json()).toEqual(
            problem('Invalid MCP proposal tool or arguments'),
          );
        }
        expect(create).not.toHaveBeenCalled();
        const result = await send(tool, args);
        expect(result.statusCode).toBe(201);
        expect(result.json()).toEqual({
          id,
          expiresAt,
          status: 'pending',
          preview: { ...args, action: tool, workspaceId, body: previewBody },
        });
        expect(create).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    },
  );

  it('carries the optional extraordinary boolean exactly as on HTTP PATCH', async () => {
    const { app, create, send } = await proposals();
    const update = { transactionId: id, ifMatch: '"1"' };
    const tool = 'update_transaction';
    try {
      for (const extraordinary of ['true', 0, null]) {
        const rejected = await send(tool, {
          ...update,
          body: { extraordinary },
        });
        expect(rejected.statusCode).toBe(422);
        expect(rejected.json()).toEqual(
          problem('Invalid MCP proposal tool or arguments'),
        );
      }
      expect(create).not.toHaveBeenCalled();
      for (const body of [
        { extraordinary: true },
        { extraordinary: false },
        { description: 'Preserve flag' },
      ]) {
        const result = await send(tool, { ...update, body }, randomUUID());
        expect(result.statusCode).toBe(201);
        expect(result.json()).toEqual({
          id,
          expiresAt,
          status: 'pending',
          preview: {
            ...update,
            body,
            action: tool,
            workspaceId,
            accountId,
            amount: bookedAmount,
            status: 'confirmed',
          },
        });
      }
      expect(create).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });

  it('previews same-currency transfer fee and description and counts both debit amounts', async () => {
    const { app, create, authorizeMcpGrant, send } = await proposals();
    const tool = 'create_transfer';
    const plain = {
      sourceAccountId: accountId,
      destinationAccountId: id,
      amount: bookedAmount,
      occurredAt: '2026-01-02T00:00:00.000Z',
    };
    const fee = { amountMinor: '2', currency: 'USD' };
    try {
      for (const extra of [
        { fee: null },
        { fee: { ...fee, amountMinor: '0' } },
        { description: 'a'.repeat(501) },
      ]) {
        const rejected = await send(tool, { ...plain, ...extra });
        expect(rejected.statusCode).toBe(422);
        expect(rejected.json()).toEqual(
          problem('Invalid MCP proposal tool or arguments'),
        );
      }
      expect(create).not.toHaveBeenCalled();
      expect(authorizeMcpGrant).not.toHaveBeenCalled();
      for (const [extra, amounts] of [
        [{}, [bookedAmount]],
        [{ fee, description: 'Transfer with fee' }, [bookedAmount, fee]],
        [{ description: null }, [bookedAmount]],
      ] as const) {
        const result = await send(tool, { ...plain, ...extra }, randomUUID());
        expect(result.statusCode).toBe(201);
        expect(result.json()).toEqual({
          id,
          expiresAt,
          status: 'pending',
          preview: { ...plain, ...extra, action: tool, workspaceId },
        });
        expect(authorizeMcpGrant).toHaveBeenLastCalledWith(expect.any(Object), {
          subject,
          grantId: grant,
          workspaceId,
          toolName: tool,
          accountIds: [accountId, id],
          amounts,
        });
      }
      expect(create).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });

  it('rejects deferred receipt scans explicitly without requesting an approval', async () => {
    const { app, create, send } = await proposals();
    try {
      const rejected = await send('scan_receipt', { file: 'receipt.pdf' });
      expect(rejected.statusCode).toBe(422);
      expect(rejected.json()).toEqual(
        problem('Tool not available for proposals'),
      );
      const unknown = await send('unknown_tool', {});
      expect(unknown.statusCode).toBe(422);
      expect(unknown.json()).toEqual(
        problem('Invalid MCP proposal tool or arguments'),
      );
      expect(create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  function problem(title: string) {
    return {
      code: 'unprocessable',
      instance: path,
      status: 422,
      title,
      traceId: expect.any(String),
      type: 'https://savia.app/problems/unprocessable',
    };
  }
});

describe('MCP proposal auth boundary', () => {
  it('accepts only the dedicated grant-bound credential; other API guards reject even dual-audience tokens', async () => {
    const { app, cli, sign, isActive, sessionId } =
      await harness(proposalAudience);
    const propose = (token: string) =>
      app.inject({
        method: 'POST',
        url: path,
        headers: { authorization: `Bearer ${token}` },
      });
    const session = await sign(subject, undefined, { aud: sessionAudience });
    const proposal = await sign(subject, grant);
    const dual = await sign(subject, grant, {
      aud: [sessionAudience, proposalAudience],
    });
    const dualWithoutGrant = await sign(subject, undefined, {
      aud: [sessionAudience, proposalAudience],
    });
    try {
      expect((await propose(proposal)).json()).toMatchObject({
        status: 400,
        title: 'Invalid X-Workspace-Id header',
      });
      const invalid = [
        session,
        'svt_cli',
        dual,
        dualWithoutGrant,
        await sign(subject, grant, { aud: 'wrong-resource' }),
        await sign(subject),
        await sign(subject, 'not-a-uuid'),
        await sign(subject, grant, { exp: 1 }),
        await sign(subject, grant, { iss: 'https://wrong.example.test' }),
      ];
      for (const token of invalid) {
        const response = await propose(token);
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
          code: 'unauthorized',
          instance: path,
          status: 401,
          title: 'Authentication is required',
          traceId: expect.any(String),
          type: 'https://savia.app/problems/unauthorized',
        });
      }
      expect(cli).not.toHaveBeenCalled();
      expect(CLI_SCOPE_POLICY.has(`POST ${path}`)).toBe(false);
      for (const token of [proposal, dual, dualWithoutGrant]) {
        const response = await app.inject({
          method: 'POST',
          url: `/v1/approvals/${randomUUID()}/confirm`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(401);
      }
      expect(isActive).not.toHaveBeenCalled();
      const response = await app.inject({
        method: 'GET',
        url: '/v1/approvals',
        headers: { authorization: `Bearer ${session}` },
      });
      expect(response.json()).toMatchObject({
        status: 400,
        title: 'Invalid X-Workspace-Id header',
      });
      expect(isActive).toHaveBeenCalledExactlyOnceWith(subject, sessionId);
    } finally {
      await app.close();
    }
  });

  it.each([undefined, sessionAudience])(
    'fails closed without a distinct proposal audience (%s)',
    async (audience) => {
      const { app, sign } = await harness(audience);
      try {
        const token = await sign(subject, grant, {
          aud: audience ?? proposalAudience,
        });
        const response = await app.inject({
          method: 'POST',
          url: path,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    },
  );
});
