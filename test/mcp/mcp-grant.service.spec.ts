import { describe, expect, it, vi } from 'vitest';
import { McpGrantService } from '../../src/mcp/mcp-grant.service.js';
import {
  MCP_GRANT_OUTCOMES,
  type McpGrantStore,
} from '../../src/mcp/mcp-grant.port.js';
const command = {
  clientName: 'client',
  scopes: ['accounts:read'],
  workspaceIds: ['11111111-1111-4111-8111-111111111111'],
  maxWriteAmount: null,
  expiresAt: null,
} as const;
describe('McpGrantService', () => {
  it('forbids a grant spanning a workspace without active membership', async () => {
    const tx = {
      run: vi.fn(async (_s, cb) => cb({ query: vi.fn() })),
      runRead: vi.fn(),
    };
    const store = {
      hasActiveMemberships: vi.fn().mockResolvedValue(false),
    } as unknown as McpGrantStore;
    const service = new McpGrantService(tx, store, {} as never);
    await expect(
      service.createMcpGrant(
        '11111111-1111-4111-8111-111111111111',
        command,
        'key',
      ),
    ).resolves.toEqual({ kind: MCP_GRANT_OUTCOMES.FORBIDDEN });
  });
  it('derives expiry at the inclusive clock boundary', async () => {
    const tx = {
      run: vi.fn(),
      runRead: vi.fn(async (_s, cb) => cb({ query: vi.fn() })),
    };
    const store = {
      list: vi.fn().mockResolvedValue([
        {
          id: '11111111-1111-4111-8111-111111111111',
          clientName: 'x',
          scopes: ['accounts:read'],
          workspaceIds: [],
          maxWriteAmount: null,
          status: 'active',
          expiresAt: new Date(0).toISOString(),
          createdAt: new Date(0).toISOString(),
        },
      ]),
    } as unknown as McpGrantStore;
    const service = new McpGrantService(
      tx,
      store,
      {} as never,
      () => new Date(0),
    );
    await expect(
      service.listMcpGrants('11111111-1111-4111-8111-111111111111', {
        limit: 10,
      }),
    ).resolves.toMatchObject({ page: { items: [{ status: 'expired' }] } });
  });
});
