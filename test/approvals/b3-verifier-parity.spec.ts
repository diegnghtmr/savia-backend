import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ApprovalService } from '../../src/approvals/approval.service.js';
import type {
  ApprovalExecutors,
  ApprovalRecord,
  ApprovalStore,
} from '../../src/approvals/approval.port.js';
import type { IdempotencyStore } from '../../src/platform/idempotency.port.js';
const creator = '11111111-1111-4111-8111-111111111111';
const admin = '22222222-2222-4222-8222-222222222222';
const workspace = '33333333-3333-4333-8333-333333333333';
const id = '44444444-4444-4444-8444-444444444444';
const hash = createHash('sha256').update('{}').digest('hex');
const clock = () => new Date('2026-01-01T00:00:00Z');
async function decide(
  channel: 'agent' | 'mcp',
  target: 'confirm' | 'reject',
  subject = admin,
  creatorRole = 'editor',
) {
  let actor = '';
  const query = vi.fn(async (_sql: string, values: string[]) => {
    actor = values[0]!;
  });
  const claim = vi.fn(
    async (
      _client: unknown,
      _workspace: string,
      _id: string,
      _tool: string,
      claimHash: string,
    ) =>
      claimHash !== hash
        ? 'conflict'
        : actor === creator && creatorRole === 'editor'
          ? 'ok'
          : 'forbidden',
  );
  const write = vi.fn(async () => true);
  const executor = vi.fn(async () => 'ok' as const);
  const update = vi.fn(
    async (
      _client: unknown,
      _workspace: string,
      _id: string,
      status: ApprovalRecord['status'],
    ) => ({ ...row, status }),
  );
  const store = {
    claimApproval: claim,
    readActiveRole: vi.fn(async () =>
      actor === admin ? 'administrator' : creatorRole,
    ),
    findApprovalById: vi.fn(async () => row),
    updateApprovalDecision: update,
  } as unknown as ApprovalStore;
  const row: ApprovalRecord = {
    id,
    workspaceId: workspace,
    toolName: 'create_transaction',
    createdBy: creator,
    channel,
    riskClass: 'financial_write',
    argumentsHash: hash,
    preview: channel === 'agent' ? { arguments: {} } : {},
    status: 'pending',
    createdAt: clock(),
    expiresAt: new Date('2026-01-02T00:00:00Z'),
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
  };
  const idem = { read: vi.fn(), write } as unknown as IdempotencyStore;
  const tx = {
    run: async <T>(subject: string, cb: (client: never) => Promise<T>) => {
      actor = subject;
      try {
        return await cb({ query } as never);
      } finally {
        actor = '';
      }
    },
    runRead: vi.fn(),
  };
  const executors: ApprovalExecutors = new Map([
    ['create_transaction', executor],
  ]);
  const svc = new ApprovalService(tx, store, idem, clock, executors);
  const operation =
    target === 'confirm' ? svc.confirmApproval : svc.rejectApproval;
  const result = await operation.call(
    svc,
    subject,
    workspace,
    id,
    { argumentsHash: hash },
    'key',
  );
  return { result, query, claim, write, executor, update };
}
it('refuses an agent confirmation by a different same-workspace administrator', async () => {
  const r = await decide('agent', 'confirm');
  expect(r.result).toEqual({ kind: 'forbidden' });
  expect(r.query).not.toHaveBeenCalled();
  expect(r.claim).not.toHaveBeenCalled();
  expect(r.executor).not.toHaveBeenCalled();
});
it('allows the original active editor to confirm their own agent approval', async () => {
  const r = await decide('agent', 'confirm', creator);
  expect(r.result).toMatchObject({
    kind: 'ok',
    approval: { status: 'consumed' },
  });
});
it('preserves administrator confirmation for a legacy MCP approval', async () => {
  const r = await decide('mcp', 'confirm');
  expect(r.result).toEqual({
    kind: 'ok',
    approval: {
      id,
      createdBy: creator,
      toolName: 'create_transaction',
      riskClass: 'financial_write',
      argumentsHash: hash,
      preview: {},
      status: 'approved',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
    },
  });
  expect(r.executor).not.toHaveBeenCalled();
  expect(r.query).not.toHaveBeenCalled();
});

it('refuses an MCP rejection by a different same-workspace administrator', async () => {
  const r = await decide('mcp', 'reject');
  expect(r.result).toEqual({ kind: 'forbidden' });
  expect(r.update).not.toHaveBeenCalled();
  expect(r.write).not.toHaveBeenCalled();
  expect(r.executor).not.toHaveBeenCalled();
});
