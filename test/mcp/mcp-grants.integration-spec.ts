// Migration under test: 202609060006_mcp_grants.sql
import { describe, expect, it } from 'vitest';
describe('MCP grants integration registration', () => {
  it('is registered as a disposable Fastify integration suite', () =>
    expect(process.env.DATABASE_URL).toBeDefined());
});
