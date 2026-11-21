// Migration under test: 202609060009_agent_messages.sql
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const owner = '11111111-0000-4000-8000-000000000041';
const member = '22222222-0000-4000-8000-000000000042';
const editor = '33333333-0000-4000-8000-000000000043';

interface AgentEvent {
  type: string;
  runId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

function parseEvents(payload: string): AgentEvent[] {
  const frames = payload.split('\n\n').filter(Boolean);
  return frames.map((frame) => {
    const lines = frame.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^event: [a-z_]+$/);
    expect(lines[1]).toMatch(/^data: \{/);
    return JSON.parse(lines[1].slice('data: '.length)) as AgentEvent;
  });
}

describe('agent messages over Fastify HTTP and disposable PostgreSQL', () => {
  let admin: Pool;
  let app: NestFastifyApplication;
  let workspace: string;
  let foreignWorkspace: string;
  const key = () => randomUUID();

  function headers(
    token = 'owner',
    idempotencyKey = key(),
    workspaceId = workspace,
  ): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      'x-workspace-id': workspaceId,
      'idempotency-key': idempotencyKey,
    };
  }

  async function request(
    conversationId: string,
    message: string,
    token = 'owner',
    idempotencyKey = key(),
    workspaceId = workspace,
  ) {
    return app.inject({
      method: 'POST',
      url: `/v1/agent/conversations/${conversationId}/messages`,
      headers: headers(token, idempotencyKey, workspaceId),
      payload: { message },
    });
  }

  async function createConversation(workspaceId = workspace, token = 'owner') {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent/conversations',
      headers: headers(token, key(), workspaceId),
      payload: { title: 'Integration conversation' },
    });
    expect(response.statusCode).toBe(201);
    return (JSON.parse(response.payload) as { id: string }).id;
  }

  async function asApplication<T>(
    subject: string,
    callback: (pool: Pool) => Promise<T>,
  ): Promise<T> {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_application');
      await client.query("select set_config('app.subject_id',$1,true)", [
        subject,
      ]);
      const result = await callback({
        query: (text: string, values?: readonly unknown[]) =>
          values === undefined
            ? client.query(text)
            : client.query(text, [...values]),
      } as unknown as Pool);
      await client.query('rollback');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

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
      "insert into auth.users (id,email) values ($1,'agent-message-owner@test'),($2,'agent-message-member@test'),($3,'agent-message-editor@test') on conflict (id) do nothing",
      [owner, member, editor],
    );
    await admin.query(
      "insert into public.profiles (id,email,display_name,locale,country_code,timezone,date_format,week_starts_on,number_format,default_currency) values ($1,'agent-message-owner@test','Agent Message Owner','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD'),($2,'agent-message-member@test','Agent Message Member','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD'),($3,'agent-message-editor@test','Agent Message Editor','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD') on conflict (id) do nothing",
      [owner, member, editor],
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: async (token: string) =>
          token === 'owner'
            ? { subject: owner }
            : token === 'member'
              ? { subject: member }
              : Promise.reject(new Error('rejected')),
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(async () => {
    workspace = randomUUID();
    foreignWorkspace = randomUUID();
    await admin.query(
      "insert into public.workspaces (id,name,kind,base_currency) values ($1,'Agent message workspace','shared','USD'),($2,'Agent message foreign','shared','USD')",
      [workspace, foreignWorkspace],
    );
    await admin.query(
      "insert into public.workspace_memberships (workspace_id,profile_id,role,status) values ($1,$3,'owner','active'),($1,$4,'viewer','active'),($1,$5,'editor','active'),($2,$3,'owner','active')",
      [workspace, foreignWorkspace, owner, member, editor],
    );
  });

  afterEach(async () => {
    await admin.query(
      'delete from public.agent_message_idempotency where workspace_id in ($1,$2)',
      [workspace, foreignWorkspace],
    );
    await admin.query(
      'delete from public.agent_message_runs where workspace_id in ($1,$2)',
      [workspace, foreignWorkspace],
    );
    await admin.query('delete from public.workspaces where id in ($1,$2)', [
      workspace,
      foreignWorkspace,
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await admin?.query('delete from auth.users where id in ($1,$2,$3)', [
      owner,
      member,
      editor,
    ]);
    await admin?.end();
  });

  it('uses the workspace credential and replays a redacted failure', async () => {
    const secret = 'synthetic-gateway-secret';
    const created = await app.inject({
      method: 'POST',
      url: '/v1/ai/credentials',
      headers: headers(),
      payload: {
        ownerType: 'workspace',
        providerId: 'openai-compatible',
        credentialType: 'gateway_token',
        secret,
        metadata: { baseUrl: 'https://gateway.example/v1' },
      },
    });
    expect(created.statusCode).toBe(201);
    const credentialId = (JSON.parse(created.payload) as { id: string }).id;
    const configured = await app.inject({
      method: 'PUT',
      url: '/v1/ai/default-model',
      headers: headers(),
      payload: { modelRef: 'openai-compatible:demo', credentialId },
    });
    expect(configured.statusCode).toBe(204);
    const unauthorized = Object.assign(Readable.from([Buffer.from(secret)]), {
      statusCode: 401,
      headers: {},
    });
    const respond = (
      _url: URL,
      _options: https.RequestOptions,
      callback: (response: unknown) => void,
    ) => {
      const request = new EventEmitter();
      return Object.assign(request, { end: () => callback(unauthorized) });
    };
    const upstream = vi
      .spyOn(https, 'request')
      .mockImplementation(respond as unknown as typeof https.request);
    try {
      const conversation = await createConversation();
      const id = key();
      const failure = await request(conversation, 'prompt', 'owner', id);
      expect(failure.statusCode).toBe(200);
      expect(
        parseEvents(failure.payload).map(({ type, data }) => [type, data]),
      ).toEqual([
        ['run_started', {}],
        ['run_failed', { message: 'Provider HTTP 401' }],
      ]);
      const replay = await request(conversation, 'prompt', 'owner', id);
      expect(replay.statusCode).toBe(200);
      expect(parseEvents(replay.payload)).toEqual(parseEvents(failure.payload));
      const auth = { Authorization: `Bearer ${secret}` };
      expect(upstream).toHaveBeenCalledExactlyOnceWith(
        new URL('https://gateway.example/v1/chat/completions'),
        expect.objectContaining({ headers: expect.objectContaining(auth) }),
        expect.any(Function),
      );
    } finally {
      upstream.mockRestore();
    }
  });

  it('reads workspace accounts then persists one bound approval without writing the ledger', async () => {
    const createAccount = (scope: string, name: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: headers('owner', key(), scope),
        payload: { name, type: 'cash', currency: 'USD' },
      });
    const local = await createAccount(workspace, 'Local account');
    const foreign = await createAccount(foreignWorkspace, 'Foreign account');
    expect(local.statusCode).toBe(201);
    expect(foreign.statusCode).toBe(201);
    const accountId = (JSON.parse(local.payload) as { id: string }).id;
    const foreignId = (JSON.parse(foreign.payload) as { id: string }).id;
    const args = {
      type: 'expense',
      accountId,
      amount: { amountMinor: '25', currency: 'USD' },
      occurredAt: '2026-01-02T00:00:00Z',
    };
    const turns: { messages?: { role: string; content: string }[] }[] = [];
    const fake = createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8').on('data', (chunk: string) => {
        raw += chunk;
      });
      req.on('end', () => {
        turns.push(JSON.parse(raw) as (typeof turns)[number]);
        const { name, arguments: input } = [
          { name: 'list_accounts', arguments: {} },
          {
            name: 'create_transaction',
            arguments: { ...args, accountId: foreignId },
          },
          { name: 'create_transaction', arguments: args },
        ][turns.length - 1] ?? { name: 'list_accounts', arguments: {} };
        const tool = {
          index: 0,
          id: `call_${turns.length}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(input) },
        };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [tool] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
        );
      });
    });
    fake.listen(0, '127.0.0.1');
    await once(fake, 'listening');
    try {
      const address = fake.address();
      if (!address || typeof address === 'string')
        throw new Error('Expected fake TCP port');
      const credential = await app.inject({
        method: 'POST',
        url: '/v1/ai/credentials',
        headers: headers(),
        payload: {
          ownerType: 'workspace',
          providerId: 'local',
          credentialType: 'local_endpoint',
          secret: `http://127.0.0.1:${address.port}/v1`,
        },
      });
      expect(credential.statusCode).toBe(201);
      const credentialId = (JSON.parse(credential.payload) as { id: string })
        .id;
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/v1/ai/default-model',
            headers: headers(),
            payload: { modelRef: 'local:demo', credentialId },
          })
        ).statusCode,
      ).toBe(204);
      const conversationId = await createConversation();
      const idempotency = key();
      const response = await request(
        conversationId,
        'make a proposal',
        'owner',
        idempotency,
      );
      expect(response.statusCode).toBe(200);
      const events = parseEvents(response.payload);
      expect(events.map(({ type }) => type)).toEqual([
        'run_started',
        'tool_proposed',
        'tool_completed',
        'tool_proposed',
        'tool_completed',
        'tool_proposed',
        'approval_required',
        'run_completed',
      ]);
      expect(turns).toHaveLength(3);
      const read = turns[1]?.messages?.at(-1);
      expect(read?.role).toBe('tool');
      expect(read?.content).toContain(accountId);
      expect(read?.content).not.toContain(foreignId);
      expect(turns[2]?.messages?.at(-1)).toMatchObject({
        role: 'tool',
        content: '{"error":"Account was not found in the workspace"}',
      });
      const { approvalId } =
        events.find(({ type }) => type === 'approval_required')?.data ?? {};
      expect(typeof approvalId).toBe('string');
      const approval = await app.inject({
        method: 'GET',
        url: `/v1/approvals/${String(approvalId)}`,
        headers: headers(),
      });
      expect(approval.statusCode).toBe(200);
      expect(JSON.parse(approval.payload)).toMatchObject({
        id: approvalId,
        status: 'pending',
        riskClass: 'financial_write',
        toolName: 'create_transaction',
        preview: {
          action: 'create_transaction',
          workspaceId: workspace,
          accountId,
          amount: '25',
          currency: 'USD',
          date: args.occurredAt,
          categoryId: null,
        },
      });
      expect(
        parseEvents(
          (
            await request(
              conversationId,
              'make a proposal',
              'owner',
              idempotency,
            )
          ).payload,
        ),
      ).toEqual(events);
      expect(turns).toHaveLength(3);
      const stored = await admin.query(
        `select
        (select count(*)::int from public.approvals where workspace_id = $1 and channel = 'agent') as approvals,
        (select count(*)::int from public.transactions where workspace_id in ($1, $2)) as transactions`,
        [workspace, foreignWorkspace],
      );
      expect(stored.rows).toEqual([{ approvals: 1, transactions: 0 }]);
    } finally {
      const closed = once(fake, 'close');
      fake.close();
      fake.closeAllConnections();
      await closed;
    }
  });

  it('returns the SSE headers and exact event/data wire format', async () => {
    const response = await request(await createConversation(), 'hello');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe(
      'text/event-stream; charset=utf-8',
    );
    expect(response.headers['cache-control']).toBe('no-cache, no-transform');
    expect(response.headers.connection).toBe('keep-alive');
    expect(response.payload).toMatch(
      /^event: run_started\ndata: \{"type":"run_started","runId":"[^"]+","timestamp":"[^"]+","data":\{\}\}\n\n/,
    );
  });

  it('orders one run from started to exactly one terminal event with no trailing frame', async () => {
    const events = parseEvents(
      await (
        await request(await createConversation(), 'ordered')
      ).payload,
    );
    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'text_delta',
      'run_completed',
    ]);
    expect(events.at(-1)?.type).toBe('run_completed');
    expect(
      events.filter(
        (event) =>
          event.type === 'run_completed' || event.type === 'run_failed',
      ),
    ).toHaveLength(1);
    expect(events.every((event) => event.runId === events[0]?.runId)).toBe(
      true,
    );
    expect(
      events.every((event) => !Number.isNaN(Date.parse(event.timestamp))),
    ).toBe(true);
  });

  it.each(['line one\nline two', 'line one\r\nline two'])(
    'round-trips text_delta newlines byte for byte: %j',
    async (message) => {
      const events = parseEvents(
        await (
          await request(await createConversation(), message)
        ).payload,
      );
      expect(
        events.find((event) => event.type === 'text_delta')?.data.text,
      ).toBe(message);
    },
  );

  it('leaves persisted state sane after a completed client-visible stream', async () => {
    const conversationId = await createConversation();
    const response = await request(conversationId, 'disconnect-safe');
    expect(response.statusCode).toBe(200);
    const rows = await admin.query<{ runs: string; idempotency: string }>(
      'select (select count(*) from public.agent_message_runs where conversation_id=$1) as runs, (select count(*) from public.agent_message_idempotency where conversation_id=$1) as idempotency',
      [conversationId],
    );
    expect(rows.rows[0]).toEqual({ runs: '1', idempotency: '1' });
  });

  it('returns 404 for a conversation in another workspace without revealing it', async () => {
    const conversationId = await createConversation(foreignWorkspace);
    const response = await request(conversationId, 'hidden');
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.payload)).toMatchObject({ status: 404 });
    expect(response.payload).not.toContain(foreignWorkspace);
  });

  it('returns 422 for missing, empty, and over-limit messages', async () => {
    const conversationId = await createConversation();
    const base = headers();
    const missing = await app.inject({
      method: 'POST',
      url: `/v1/agent/conversations/${conversationId}/messages`,
      headers: base,
      payload: {},
    });
    const empty = await request(conversationId, '');
    const over = await request(conversationId, 'a'.repeat(20001));
    expect(missing.statusCode).toBe(422);
    expect(empty.statusCode).toBe(422);
    expect(over.statusCode).toBe(422);
  });

  it('accepts 20000 astral characters because maxLength counts characters', async () => {
    const response = await request(
      await createConversation(),
      '🧪'.repeat(20000),
    );
    expect(response.statusCode).toBe(200);
    expect(
      parseEvents(response.payload).find((event) => event.type === 'text_delta')
        ?.data.text,
    ).toBe('🧪'.repeat(20000));
  });

  it('replays matching events and conflicts when the idempotent payload changes', async () => {
    const conversationId = await createConversation();
    const idempotencyKey = key();
    const first = await request(
      conversationId,
      'same',
      'owner',
      idempotencyKey,
    );
    const replay = await request(
      conversationId,
      'same',
      'owner',
      idempotencyKey,
    );
    const conflict = await request(
      conversationId,
      'changed',
      'owner',
      idempotencyKey,
    );
    expect(replay.statusCode).toBe(200);
    expect(parseEvents(replay.payload)).toEqual(parseEvents(first.payload));
    expect(conflict.statusCode).toBe(409);
  });

  it('scopes the 20-request rate budget by conversation, workspace, and subject', async () => {
    const conversationId = await createConversation();
    for (let index = 0; index < 20; index++)
      expect((await request(conversationId, `same-${index}`)).statusCode).toBe(
        200,
      );
    expect((await request(conversationId, 'same-21')).statusCode).toBe(429);
    const otherConversation = await createConversation();
    expect(
      (await request(otherConversation, 'other-conversation')).statusCode,
    ).toBe(200);
    const foreignConversation = await createConversation(foreignWorkspace);
    expect(
      (
        await request(
          foreignConversation,
          'other-workspace',
          'owner',
          key(),
          foreignWorkspace,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await request(conversationId, 'member-budget', 'member')).statusCode,
    ).toBe(200);
  });

  it('returns 401 without a token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/agent/conversations/${randomUUID()}/messages`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('allows an active workspace member to update a conversation but denies another workspace', async () => {
    const localConversation = await createConversation();
    const foreignConversation = await createConversation(foreignWorkspace);
    const policy = await admin.query<{ qual: string; withCheck: string }>(
      "select qual, with_check as \"withCheck\" from pg_policies where schemaname='public' and tablename='agent_conversations' and policyname='agent_conversations_update_workspace'",
    );
    expect(policy.rows[0]).toEqual({
      qual: expect.stringContaining('workspace_actor_active_role'),
      withCheck: expect.stringContaining('workspace_actor_active_role'),
    });
    await asApplication(member, async (pool) => {
      const viewerUpdate = await pool.query(
        'update public.agent_conversations set updated_at=now() where id=$1',
        [localConversation],
      );
      expect(viewerUpdate.rowCount).toBe(0);
      const denied = await pool.query(
        'update public.agent_conversations set updated_at=now() where id=$1',
        [foreignConversation],
      );
      expect(denied.rowCount).toBe(0);
      return undefined;
    });
    await asApplication(editor, async (pool) => {
      const editorUpdate = await pool.query(
        'update public.agent_conversations set updated_at=now() where id=$1',
        [localConversation],
      );
      expect(editorUpdate.rowCount).toBe(1);
      return undefined;
    });
  });

  it('uses UTC minute windows under a non-UTC session timezone', async () => {
    const conversationId = await createConversation();
    const client = await admin.connect();
    try {
      await client.query("set time zone 'America/Los_Angeles'");
      await client.query(
        'select public.consume_agent_message_rate_limit($1,$2,$3,$4::timestamptz), public.consume_agent_message_rate_limit($1,$2,$3,$5::timestamptz)',
        [
          owner,
          workspace,
          conversationId,
          '2026-01-01T00:00:59.000Z',
          '2026-01-01T00:01:00.000Z',
        ],
      );
      const rows = await client.query(
        'select count(*)::int as count from public.agent_message_rate_limits where conversation_id=$1',
        [conversationId],
      );
      expect(rows.rows[0]?.count).toBe(2);
    } finally {
      await client.query('reset time zone');
      client.release();
    }
  });
});
