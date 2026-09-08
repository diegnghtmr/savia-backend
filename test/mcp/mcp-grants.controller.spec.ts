import { describe, expect, it, vi } from 'vitest';
import { McpGrantsController } from '../../src/mcp/mcp-grants.controller.js';
import {
  MCP_GRANT_OUTCOMES,
  type McpGrantPort,
} from '../../src/mcp/mcp-grant.port.js';

class Reply {
  statusCode = 200;
  body: unknown = undefined;
  request = { id: 'trace', url: '/v1/mcp/grants' };
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  type(_type?: string) {
    void _type;
    return this;
  }
  send(body?: unknown) {
    this.body = body;
    return this;
  }
}
const subject = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const grant = {
  id,
  clientName: 'client',
  scopes: ['accounts:read'],
  workspaceIds: [id],
  maxWriteAmount: null,
  status: 'active' as const,
  expiresAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};
function req() {
  return {
    headers: { 'idempotency-key': '33333333-3333-4333-8333-333333333333' },
    identity: { subject },
  } as never;
}
function port(
  overrides: Partial<Record<keyof McpGrantPort, ReturnType<typeof vi.fn>>> = {},
) {
  return {
    createMcpGrant: vi.fn(),
    listMcpGrants: vi.fn(),
    revokeMcpGrant: vi.fn(),
    ...overrides,
  } as unknown as McpGrantPort;
}

describe('McpGrantsController', () => {
  it('maps every create outcome', async () => {
    for (const [outcome, status] of [
      [{ kind: MCP_GRANT_OUTCOMES.CREATED, grant }, 201],
      [{ kind: MCP_GRANT_OUTCOMES.FORBIDDEN }, 403],
      [{ kind: MCP_GRANT_OUTCOMES.INVALID }, 422],
      [{ kind: MCP_GRANT_OUTCOMES.CONFLICT }, 409],
    ] as const) {
      const p = port({ createMcpGrant: vi.fn().mockResolvedValue(outcome) });
      const reply = new Reply();
      await new McpGrantsController(p).create(
        req(),
        { clientName: 'x', scopes: ['accounts:read'], workspaceIds: [id] },
        reply as never,
      );
      expect(reply.statusCode).toBe(status);
    }
  });
  it('returns 422 with violations for validation errors', async () => {
    const reply = new Reply();
    const p = port();
    await new McpGrantsController(p).create(
      req(),
      { clientName: 'x', scopes: [], workspaceIds: [id] },
      reply as never,
    );
    expect(reply.statusCode).toBe(422);
    expect(reply.body).toMatchObject({
      status: 422,
      errors: [{ field: 'scopes' }],
    });
    expect(p.createMcpGrant).not.toHaveBeenCalled();
  });
  it('maps list success and malformed query', async () => {
    const p = port({
      listMcpGrants: vi.fn().mockResolvedValue({
        kind: 'ok',
        page: {
          items: [],
          pageInfo: { hasNextPage: false, nextCursor: null },
        },
      }),
    });
    const ok = new Reply();
    await new McpGrantsController(p).list(req(), ok as never, undefined, '2');
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBeDefined();
    const bad = new Reply();
    await new McpGrantsController(p).list(req(), bad as never, undefined, '0');
    expect(bad.statusCode).toBe(400);
    expect(p.listMcpGrants).toHaveBeenCalledTimes(1);
  });
  it('maps revoke not-found, conflict, and 204 without a body', async () => {
    for (const [outcome, status, hasBody] of [
      [{ kind: MCP_GRANT_OUTCOMES.NOT_FOUND }, 404, true],
      [{ kind: MCP_GRANT_OUTCOMES.CONFLICT }, 409, true],
      [
        {
          kind: MCP_GRANT_OUTCOMES.OK,
          page: {
            items: [],
            pageInfo: { hasNextPage: false, nextCursor: null },
          },
        },
        204,
        false,
      ],
    ] as const) {
      const p = port({ revokeMcpGrant: vi.fn().mockResolvedValue(outcome) });
      const reply = new Reply();
      await new McpGrantsController(p).revoke(id, req(), reply as never);
      expect(reply.statusCode).toBe(status);
      if (hasBody) expect(reply.body).toBeDefined();
      else expect(reply.body).toBeUndefined();
    }
  });
  it('rejects invalid idempotency and grant identifiers before invoking the port', async () => {
    const p = port();
    const reply = new Reply();
    await new McpGrantsController(p).revoke(
      'not-a-uuid',
      req(),
      reply as never,
    );
    expect(reply.statusCode).toBe(400);
    expect(p.revokeMcpGrant).not.toHaveBeenCalled();
    const noKey = { headers: {}, identity: { subject } } as never;
    const second = new Reply();
    await new McpGrantsController(p).create(
      noKey,
      { clientName: 'x', scopes: ['accounts:read'], workspaceIds: [id] },
      second as never,
    );
    expect(second.statusCode).toBe(400);
  });
});
