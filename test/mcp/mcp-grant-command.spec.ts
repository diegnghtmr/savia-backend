import { describe, expect, it } from 'vitest';
import {
  createMcpGrantCommand,
  McpGrantCommandValidationError,
  MCP_GRANT_SCOPES,
} from '../../src/mcp/mcp-grant-command.js';
describe('MCP grant command', () => {
  it('accepts the complete derived scope vocabulary', () =>
    expect(
      createMcpGrantCommand({
        clientName: 'client',
        scopes: [...MCP_GRANT_SCOPES],
        workspaceIds: ['11111111-1111-4111-8111-111111111111'],
      }).scopes,
    ).toEqual(MCP_GRANT_SCOPES));
  it('rejects duplicate, empty, unsupported, and unknown fields', () => {
    for (const body of [
      {
        clientName: 'x',
        scopes: [],
        workspaceIds: ['11111111-1111-4111-8111-111111111111'],
      },
      {
        clientName: 'x',
        scopes: ['accounts:read', 'accounts:read'],
        workspaceIds: ['11111111-1111-4111-8111-111111111111'],
      },
      {
        clientName: 'x',
        scopes: ['nope'],
        workspaceIds: ['11111111-1111-4111-8111-111111111111'],
      },
      {
        clientName: 'x',
        scopes: ['accounts:read'],
        workspaceIds: ['11111111-1111-4111-8111-111111111111'],
        extra: true,
      },
    ])
      expect(() => createMcpGrantCommand(body)).toThrow(
        McpGrantCommandValidationError,
      );
  });
});
