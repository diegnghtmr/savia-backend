import { describe, expect, it } from 'vitest';
import {
  createMcpGrantCommand,
  McpGrantCommandValidationError,
  MCP_GRANT_SCOPES,
} from '../../src/mcp/mcp-grant-command.js';

const workspace = '11111111-1111-4111-8111-111111111111';
const account = '22222222-2222-4222-8222-222222222222';
const base = () => ({
  clientName: 'client',
  scopes: ['accounts:read'],
  workspaceIds: [workspace],
});
function violations(input: unknown) {
  try {
    createMcpGrantCommand(input);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(McpGrantCommandValidationError);
    return (error as McpGrantCommandValidationError).violations;
  }
}
function fields(input: unknown): string[] {
  return violations(input).map((violation) => violation.field);
}

describe('MCP grant command', () => {
  it.each(MCP_GRANT_SCOPES)('accepts scope %s', (scope) => {
    expect(
      createMcpGrantCommand({ ...base(), scopes: [scope] }).scopes,
    ).toEqual([scope]);
  });
  it('rejects unsupported, duplicate, and empty scopes with field names', () => {
    expect(fields({ ...base(), scopes: ['nope'] })).toContain('scopes');
    expect(
      fields({ ...base(), scopes: ['accounts:read', 'accounts:read'] }),
    ).toContain('scopes');
    expect(fields({ ...base(), scopes: [] })).toContain('scopes');
  });
  it('enforces clientName boundaries', () => {
    expect(
      createMcpGrantCommand({ ...base(), clientName: 'x' }).clientName,
    ).toBe('x');
    expect(
      createMcpGrantCommand({ ...base(), clientName: 'x'.repeat(120) }),
    ).toBeTruthy();
    expect(fields({ ...base(), clientName: '' })).toContain('clientName');
    expect(fields({ ...base(), clientName: 'x'.repeat(121) })).toContain(
      'clientName',
    );
  });
  it('rejects empty and duplicate workspace ids', () => {
    expect(fields({ ...base(), workspaceIds: [] })).toContain('workspaceIds');
    expect(
      fields({ ...base(), workspaceIds: [workspace, workspace] }),
    ).toContain('workspaceIds');
  });
  it('rejects duplicate account ids', () => {
    expect(fields({ ...base(), accountIds: [account, account] })).toContain(
      'accountIds',
    );
  });
  it('rejects inactive currencies and independently incomplete amounts', () => {
    expect(
      fields({
        ...base(),
        maxWriteAmount: { amountMinor: 1, currency: 'ZZZ' },
      }),
    ).toContain('maxWriteAmount.currency');
    expect(fields({ ...base(), maxWriteAmount: { amountMinor: 1 } })).toContain(
      'maxWriteAmount.currency',
    );
    expect(
      fields({ ...base(), maxWriteAmount: { currency: 'USD' } }),
    ).toContain('maxWriteAmount');
  });
  it('rejects unknown top-level keys and reports that key', () => {
    expect(fields({ ...base(), unknown: true })).toContain('unknown');
  });
  it('normalizes accepted ids and currency', () => {
    expect(
      createMcpGrantCommand({
        ...base(),
        workspaceIds: [workspace.toUpperCase()],
        maxWriteAmount: { amountMinor: 4, currency: 'usd' },
      }),
    ).toMatchObject({
      workspaceIds: [workspace],
      maxWriteAmount: { currency: 'USD' },
    });
  });
});
