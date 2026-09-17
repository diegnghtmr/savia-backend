import { describe, expect, it, vi } from 'vitest';
import type {
  IdempotencyRecord,
  IdempotencyStore,
} from '../../src/platform/idempotency.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import {
  McpGrantService,
  type McpGrantTransaction,
} from '../../src/mcp/mcp-grant.service.js';
import { computeRequestFingerprint } from '../../src/platform/idempotency.service.js';
import {
  MCP_GRANT_OUTCOMES,
  type McpGrant,
  type McpGrantStore,
} from '../../src/mcp/mcp-grant.port.js';

const subject = '11111111-1111-4111-8111-111111111111';
const workspace = '22222222-2222-4222-8222-222222222222';
const command = {
  clientName: 'client',
  scopes: ['accounts:read'],
  workspaceIds: [workspace],
  maxWriteAmount: null,
  expiresAt: null,
} as const;
const grant: McpGrant = {
  id: '33333333-3333-4333-8333-333333333333',
  ...command,
  status: 'active',
  expiresAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

class RecordingTransaction implements McpGrantTransaction {
  public returned = 0;
  public thrown = 0;
  public callbackError: Error | null = null;
  private readonly client = { query: vi.fn() } as unknown as TransactionClient;
  public async run<T>(
    _subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await callback(this.client);
      this.returned++;
      return result;
    } catch (error) {
      this.thrown++;
      throw error;
    }
  }
  public async runRead<T>(
    _subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await callback(this.client);
      this.returned++;
      return result;
    } catch (error) {
      this.thrown++;
      throw error;
    }
  }
}
class FakeStore implements McpGrantStore {
  public hasMembership = true;
  public accountsValid = true;
  public revokeResult = true;
  public findResult: McpGrant | undefined = grant;
  public listResult: readonly McpGrant[] = [grant];
  public createCalls = 0;
  public revokeCalls = 0;
  createId() {
    return grant.id;
  }
  async hasActiveMemberships() {
    return this.hasMembership;
  }
  async accountsBelongToWorkspaces() {
    return this.accountsValid;
  }
  async create() {
    this.createCalls++;
    return grant;
  }
  async list() {
    return this.listResult;
  }
  async find() {
    return this.findResult;
  }
  async revoke() {
    this.revokeCalls++;
    return this.revokeResult;
  }
}
class FakeIdempotency implements IdempotencyStore {
  public record: IdempotencyRecord | undefined;
  public writeResult = true;
  public writes = 0;
  async read() {
    return this.record;
  }
  async write(
    _c: TransactionClient,
    _s: string,
    _r: string,
    _k: string,
    fingerprint: string,
    status: number,
    etag: string | null,
    body: unknown,
  ) {
    this.writes++;
    if (this.writeResult)
      this.record = {
        requestFingerprint: fingerprint,
        responseStatus: status,
        responseEtag: etag,
        responseBody: body,
      };
    return this.writeResult;
  }
}
function harness(clock = () => new Date(0)) {
  const tx = new RecordingTransaction();
  const store = new FakeStore();
  const idempotency = new FakeIdempotency();
  return {
    tx,
    store,
    idempotency,
    service: new McpGrantService(tx, store, idempotency, clock),
  };
}

describe('McpGrantService', () => {
  it('fingerprints different expiry strings differently', () => {
    expect(
      computeRequestFingerprint({
        ...command,
        expiresAt: '2026-01-01T00:00:00.000Z',
      }),
    ).not.toBe(
      computeRequestFingerprint({
        ...command,
        expiresAt: '2027-01-01T00:00:00.000Z',
      }),
    );
  });
  it('creates and records idempotency after membership and account checks', async () => {
    const h = harness();
    await expect(
      h.service.createMcpGrant(subject, command, 'key'),
    ).resolves.toMatchObject({ kind: 'created', grant });
    expect(h.store.createCalls).toBe(1);
    expect(h.idempotency.writes).toBe(1);
    expect(h.tx.returned).toBe(1);
  });
  it.each([
    ['membership', false, true, MCP_GRANT_OUTCOMES.FORBIDDEN],
    ['accounts', true, false, MCP_GRANT_OUTCOMES.INVALID],
  ])(
    'maps %s failure and returns from transaction',
    async (_name, membership, accounts, outcome) => {
      const h = harness();
      h.store.hasMembership = membership;
      h.store.accountsValid = accounts;
      await expect(
        h.service.createMcpGrant(
          subject,
          { ...command, accountIds: ['44444444-4444-4444-8444-444444444444'] },
          'key',
        ),
      ).resolves.toEqual({ kind: outcome });
      expect(h.tx.returned).toBe(1);
      expect(h.tx.thrown).toBe(0);
      expect(h.store.createCalls).toBe(0);
    },
  );
  it('replays an identical create and conflicts on a different payload', async () => {
    const first = harness();
    await first.service.createMcpGrant(subject, command, 'key');
    await expect(
      first.service.createMcpGrant(subject, command, 'key'),
    ).resolves.toMatchObject({ kind: 'created' });
    await expect(
      first.service.createMcpGrant(
        subject,
        { ...command, clientName: 'other' },
        'key',
      ),
    ).resolves.toEqual({ kind: 'conflict' });
  });
  it('conflicts when only expiresAt changes under the same idempotency key', async () => {
    const h = harness();
    await h.service.createMcpGrant(
      subject,
      {
        ...command,
        expiresAt: '2026-01-01T00:00:00.000Z',
      },
      'key',
    );
    await expect(
      h.service.createMcpGrant(
        subject,
        {
          ...command,
          expiresAt: '2027-01-01T00:00:00.000Z',
        },
        'key',
      ),
    ).resolves.toEqual({ kind: 'conflict' });
  });
  it('rolls back when the idempotency write loses its race', async () => {
    const h = harness();
    h.idempotency.writeResult = false;
    await expect(
      h.service.createMcpGrant(subject, command, 'key'),
    ).resolves.toEqual({ kind: 'conflict' });
    expect(h.tx.thrown).toBe(1);
    expect(h.tx.returned).toBe(0);
  });
  it('maps list pages and inclusive read-time expiry', async () => {
    const h = harness(() => new Date(0));
    h.store.listResult = [{ ...grant, expiresAt: new Date(0).toISOString() }];
    await expect(
      h.service.listMcpGrants(subject, { limit: 1 }),
    ).resolves.toMatchObject({
      kind: 'ok',
      page: { items: [{ status: 'expired' }] },
    });
    expect(h.tx.returned).toBe(1);
  });
  it.each([
    ['missing', undefined, MCP_GRANT_OUTCOMES.NOT_FOUND],
    [
      'revoked',
      { ...grant, status: 'revoked' as const },
      MCP_GRANT_OUTCOMES.CONFLICT,
    ],
    [
      'expired',
      { ...grant, expiresAt: new Date(0).toISOString() },
      MCP_GRANT_OUTCOMES.CONFLICT,
    ],
  ])('maps revoke %s', async (_name, found, outcome) => {
    const h = harness();
    h.store.findResult = found;
    await expect(
      h.service.revokeMcpGrant(subject, grant.id, 'key'),
    ).resolves.toEqual({ kind: outcome });
    expect(h.store.revokeCalls).toBe(0);
    expect(h.tx.returned).toBe(1);
  });
  it('rolls back after revoke when idempotency recording fails', async () => {
    const h = harness();
    h.idempotency.writeResult = false;
    await expect(
      h.service.revokeMcpGrant(subject, grant.id, 'key'),
    ).resolves.toEqual({ kind: 'conflict' });
    expect(h.store.revokeCalls).toBe(1);
    expect(h.tx.thrown).toBe(1);
    expect(h.tx.returned).toBe(0);
  });
  it('replays and conflicts revoke idempotency keys by grant id', async () => {
    const h = harness();
    await h.service.revokeMcpGrant(subject, grant.id, 'key');
    await expect(
      h.service.revokeMcpGrant(subject, grant.id, 'key'),
    ).resolves.toMatchObject({ kind: 'ok' });
    await expect(
      h.service.revokeMcpGrant(
        subject,
        '55555555-5555-4555-8555-555555555555',
        'key',
      ),
    ).resolves.toEqual({ kind: 'conflict' });
  });
});
