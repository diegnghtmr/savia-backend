import { expect, it } from 'vitest';
import { MCP_TOOL_ANNOTATIONS } from '../../src/mcp/mcp-tools.js';
import { McpRead } from '../../src/platform/mcp-read-auth.js';

it('makes a new route declaration sufficient to recognize its tool and scopes', () => {
  const toolName = 'test_scope_only_mcp_read';
  class TestController {
    public read() {
      return true;
    }
  }
  const method = Object.getOwnPropertyDescriptor(
    TestController.prototype,
    'read',
  )!;
  McpRead(toolName, ['budgets:read'])(TestController.prototype, 'read', method);
  expect(MCP_TOOL_ANNOTATIONS.get(toolName)).toEqual({
    riskClass: 'read',
    requiresApproval: false,
    requiredScopes: ['budgets:read'],
  });
});

it('fails configuration if a route tries to declare different scopes from the catalog', () => {
  expect(() => McpRead('get_account_balance', ['budgets:read'])).toThrow();
});
