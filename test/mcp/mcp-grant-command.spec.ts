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
function violationCodes(input: unknown, field: string): string[] {
  return violations(input)
    .filter((violation) => violation.field === field)
    .map((violation) => violation.code);
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
  it('accepts signed 64-bit amountMinor strings and preserves precision', () => {
    expect(
      createMcpGrantCommand({
        ...base(),
        maxWriteAmount: { amountMinor: '125000', currency: 'usd' },
      }),
    ).toMatchObject({
      maxWriteAmount: { amountMinor: '125000', currency: 'USD' },
    });
    expect(
      createMcpGrantCommand({
        ...base(),
        maxWriteAmount: { amountMinor: '-5000', currency: 'USD' },
      }).maxWriteAmount,
    ).toEqual({ amountMinor: '-5000', currency: 'USD' });
    expect(
      createMcpGrantCommand({
        ...base(),
        maxWriteAmount: { amountMinor: '0', currency: 'USD' },
      }).maxWriteAmount,
    ).toEqual({ amountMinor: '0', currency: 'USD' });
    expect(
      createMcpGrantCommand({
        ...base(),
        maxWriteAmount: {
          amountMinor: '9007199254740993',
          currency: 'USD',
        },
      }).maxWriteAmount,
    ).toEqual({ amountMinor: '9007199254740993', currency: 'USD' });
    expect(
      createMcpGrantCommand({
        ...base(),
        maxWriteAmount: {
          amountMinor: '-9223372036854775808',
          currency: 'USD',
        },
      }).maxWriteAmount,
    ).toEqual({ amountMinor: '-9223372036854775808', currency: 'USD' });
    expect(
      createMcpGrantCommand({
        ...base(),
        maxWriteAmount: {
          amountMinor: '9223372036854775807',
          currency: 'USD',
        },
      }).maxWriteAmount,
    ).toEqual({ amountMinor: '9223372036854775807', currency: 'USD' });
  });
  it('accepts ISO date-time strings and rejects broader Date.parse inputs', () => {
    expect(
      createMcpGrantCommand({
        ...base(),
        expiresAt: '2026-01-01T00:00:00.000Z',
      }).expiresAt,
    ).toBe('2026-01-01T00:00:00.000Z');
    for (const expiresAt of ['2026-01-01', '2026-01-01T00:00', 'not-a-date'])
      expect(fields({ ...base(), expiresAt })).toContain('expiresAt');
  });
  it('rejects invalid amountMinor values with its nested field name', () => {
    for (const amountMinor of [
      125000,
      '12.5',
      '1e5',
      '',
      ' 125 ',
      '12\x005',
      '9223372036854775808',
    ])
      expect(
        fields({
          ...base(),
          maxWriteAmount: { amountMinor, currency: 'USD' },
        }),
      ).toContain('maxWriteAmount.amountMinor');
    for (const amountMinor of ['12.5', '1e5', ' 125 '])
      expect(
        violationCodes(
          { ...base(), maxWriteAmount: { amountMinor, currency: 'USD' } },
          'maxWriteAmount.amountMinor',
        ),
      ).toContain('invalid-format');
    expect(
      violationCodes(
        {
          ...base(),
          maxWriteAmount: { amountMinor: '12\x005', currency: 'USD' },
        },
        'maxWriteAmount.amountMinor',
      ),
    ).toContain('invalid-characters');
  });
  it('rejects inactive currencies and independently incomplete amounts', () => {
    expect(
      fields({
        ...base(),
        maxWriteAmount: { amountMinor: '1', currency: 'ZZZ' },
      }),
    ).toContain('maxWriteAmount.currency');
    expect(
      fields({ ...base(), maxWriteAmount: { amountMinor: '1' } }),
    ).toContain('maxWriteAmount.currency');
    expect(
      fields({ ...base(), maxWriteAmount: { currency: 'USD' } }),
    ).toContain('maxWriteAmount.amountMinor');
  });
  it('rejects unknown top-level keys and reports that key', () => {
    expect(fields({ ...base(), unknown: true })).toContain('unknown');
  });
  it('normalizes accepted ids and currency', () => {
    expect(
      createMcpGrantCommand({
        ...base(),
        workspaceIds: [workspace.toUpperCase()],
        maxWriteAmount: { amountMinor: '4', currency: 'usd' },
      }),
    ).toMatchObject({
      workspaceIds: [workspace],
      maxWriteAmount: { currency: 'USD' },
    });
  });
});
