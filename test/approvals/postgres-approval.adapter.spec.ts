import { describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import { PostgresApprovalAdapter } from '../../src/approvals/postgres-approval.adapter.js';

describe('PostgresApprovalAdapter', () => {
  const workspaceId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const approvalId = 'bbbbbbbb-0000-4000-8000-000000000001';
  const subject = '11111111-0000-4000-8000-000000000001';

  it('reads active role for workspace', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ role: 'owner' }],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresApprovalAdapter();
    const role = await adapter.readActiveRole(mockClient, workspaceId);

    expect(role).toBe('owner');
    // STRUCTURAL assertion, deliberately not behavioural. Pinning the call to
    // workspace_actor_active_role verifies the adapter queries active role membership
    // via the PostgreSQL RLS helper. A harmless query rewrite is expected to update this string.
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('workspace_actor_active_role'),
      [workspaceId],
    );
  });

  it('finds approval by id in workspace', async () => {
    const expiresAt = new Date('2026-09-06T12:00:00.000Z');
    const createdAt = new Date('2026-09-05T12:00:00.000Z');

    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            id: approvalId,
            workspaceId,
            toolName: 'execute_sql',
            riskClass: 'destructive',
            argumentsHash: 'hash-123',
            preview: { query: 'DROP TABLE test' },
            status: 'pending',
            expiresAt,
            decidedBy: null,
            decidedAt: null,
            decisionReason: null,
            createdBy: subject,
            createdAt,
          },
        ],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresApprovalAdapter();
    const result = await adapter.findApprovalById(
      mockClient,
      workspaceId,
      approvalId,
    );

    expect(result).toBeDefined();
    expect(result?.id).toBe(approvalId);
    expect(result?.workspaceId).toBe(workspaceId);
    expect(result?.status).toBe('pending');
    expect(result?.preview).toEqual({ query: 'DROP TABLE test' });

    // STRUCTURAL assertion, deliberately not behavioural. It pins the select statement
    // structure and workspace_id predicate against the mocked client.
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringMatching(/from\s+public\.approvals/i),
      [workspaceId, approvalId],
    );
  });

  it('returns undefined when approval not found', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresApprovalAdapter();
    const result = await adapter.findApprovalById(
      mockClient,
      workspaceId,
      approvalId,
    );

    expect(result).toBeUndefined();
  });

  it('updates approval decision and returns updated record', async () => {
    const decidedAt = new Date('2026-09-05T13:00:00.000Z');
    const expiresAt = new Date('2026-09-06T12:00:00.000Z');
    const createdAt = new Date('2026-09-05T12:00:00.000Z');

    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            id: approvalId,
            workspaceId,
            toolName: 'execute_sql',
            riskClass: 'destructive',
            argumentsHash: 'hash-123',
            preview: { query: 'DROP TABLE test' },
            status: 'approved',
            expiresAt,
            decidedBy: subject,
            decidedAt,
            decisionReason: 'Approved by admin',
            createdBy: subject,
            createdAt,
          },
        ],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresApprovalAdapter();
    const result = await adapter.updateApprovalDecision(
      mockClient,
      workspaceId,
      approvalId,
      'approved',
      subject,
      decidedAt,
      'Approved by admin',
    );

    expect(result).toBeDefined();
    expect(result?.status).toBe('approved');
    expect(result?.decidedBy).toBe(subject);
    expect(result?.decisionReason).toBe('Approved by admin');

    // STRUCTURAL assertion, deliberately not behavioural. It pins the update statement
    // structure and workspace_id predicate against the mocked client.
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringMatching(/update\s+public\.approvals/i),
      [
        workspaceId,
        approvalId,
        'approved',
        subject,
        decidedAt,
        'Approved by admin',
      ],
    );
  });
});
