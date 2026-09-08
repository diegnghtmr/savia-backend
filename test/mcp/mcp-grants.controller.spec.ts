import { describe, expect, it, vi } from 'vitest';
import { McpGrantsController } from '../../src/mcp/mcp-grants.controller.js';
describe('McpGrantsController', () => {
  it('rejects an invalid idempotency key before invoking the port', async () => {
    const port = { createMcpGrant: vi.fn() };
    const reply = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn(),
      request: { id: 'x', url: '/' },
    };
    await new McpGrantsController(port as never).create(
      {
        headers: {},
        identity: { subject: '11111111-1111-4111-8111-111111111111' },
      } as never,
      {},
      reply as never,
    );
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(port.createMcpGrant).not.toHaveBeenCalled();
  });
});
