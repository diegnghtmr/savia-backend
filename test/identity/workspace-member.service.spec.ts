import { describe, expect, it, vi } from 'vitest';

import type { TransactionClient } from '../../src/identity/pg-transaction.js';
import {
  decodeMemberCursor,
  encodeMemberCursor,
  WORKSPACE_MEMBER_LIST_OUTCOMES,
  type WorkspaceMember,
} from '../../src/identity/workspace-member.port.js';
import {
  WorkspaceMemberService,
  type WorkspaceMemberReadTransaction,
  type WorkspaceMemberStore,
} from '../../src/identity/workspace-member.service.js';
import { WORKSPACE_MEMBER_STATUS } from '../../src/identity/workspace.port.js';

describe('WorkspaceMemberService.listWorkspaceMembers', () => {
  const dummySubject = '3f084ac5-18a6-4e09-920d-2e3da29df7c8';
  const dummyWorkspaceId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const dummyClient = {} as TransactionClient;

  const fakeMember1: WorkspaceMember = {
    id: '11111111-1111-1111-1111-111111111111',
    userId: dummySubject,
    displayName: 'Alice',
    email: 'alice@example.test',
    role: 'owner',
    status: 'active',
    joinedAt: '2026-07-15T01:00:00.000Z',
  };

  const fakeMember2: WorkspaceMember = {
    id: '22222222-2222-2222-2222-222222222222',
    userId: '4f084ac5-18a6-4e09-920d-2e3da29df7c9',
    displayName: 'Bob',
    role: 'editor',
    status: 'active',
    joinedAt: '2026-07-15T02:00:00.000Z',
  };

  const fakeMember3: WorkspaceMember = {
    id: '33333333-3333-3333-3333-333333333333',
    userId: '5f084ac5-18a6-4e09-920d-2e3da29df7ca',
    displayName: 'Charlie',
    role: 'viewer',
    status: 'active',
    joinedAt: '2026-07-15T03:00:00.000Z',
  };

  it('returns not-found when the caller has no membership row', async () => {
    const fakeStore: WorkspaceMemberStore = {
      readMembership: vi.fn().mockResolvedValue(undefined),
      listRoster: vi.fn().mockResolvedValue([]),
    };
    const fakeTransaction: WorkspaceMemberReadTransaction = {
      runRead: vi.fn(async (_subject, callback) => callback(dummyClient)),
    };
    const service = new WorkspaceMemberService(fakeTransaction, fakeStore);

    const outcome = await service.listWorkspaceMembers(
      dummySubject,
      dummyWorkspaceId,
      { limit: 50 },
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_LIST_OUTCOMES.NOT_FOUND);
  });

  it('returns forbidden when the caller membership is suspended', async () => {
    const fakeStore: WorkspaceMemberStore = {
      readMembership: vi.fn().mockResolvedValue({
        role: 'viewer',
        status: WORKSPACE_MEMBER_STATUS.SUSPENDED,
      }),
      listRoster: vi.fn().mockResolvedValue([]),
    };
    const fakeTransaction: WorkspaceMemberReadTransaction = {
      runRead: vi.fn(async (_subject, callback) => callback(dummyClient)),
    };
    const service = new WorkspaceMemberService(fakeTransaction, fakeStore);

    const outcome = await service.listWorkspaceMembers(
      dummySubject,
      dummyWorkspaceId,
      { limit: 50 },
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_LIST_OUTCOMES.FORBIDDEN);
  });

  it('returns ok with the roster and pageInfo for an active member', async () => {
    const fakeStore: WorkspaceMemberStore = {
      readMembership: vi.fn().mockResolvedValue({
        role: 'owner',
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      }),
      listRoster: vi.fn().mockResolvedValue([fakeMember1, fakeMember2]),
    };
    const fakeTransaction: WorkspaceMemberReadTransaction = {
      runRead: vi.fn(async (_subject, callback) => callback(dummyClient)),
    };
    const service = new WorkspaceMemberService(fakeTransaction, fakeStore);

    const outcome = await service.listWorkspaceMembers(
      dummySubject,
      dummyWorkspaceId,
      { limit: 50 },
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_LIST_OUTCOMES.OK);
    if (outcome.kind === WORKSPACE_MEMBER_LIST_OUTCOMES.OK) {
      expect(outcome.page.items).toEqual([fakeMember1, fakeMember2]);
      expect(outcome.page.pageInfo.hasNextPage).toBe(false);
      expect(outcome.page.pageInfo.nextCursor).toBeNull();
    }
  });

  it('requests limit + 1 rows and reports hasNextPage when the store returns the extra row', async () => {
    const fakeStore: WorkspaceMemberStore = {
      readMembership: vi.fn().mockResolvedValue({
        role: 'owner',
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      }),
      listRoster: vi
        .fn()
        .mockResolvedValue([fakeMember1, fakeMember2, fakeMember3]),
    };
    const fakeTransaction: WorkspaceMemberReadTransaction = {
      runRead: vi.fn(async (_subject, callback) => callback(dummyClient)),
    };
    const service = new WorkspaceMemberService(fakeTransaction, fakeStore);

    const outcome = await service.listWorkspaceMembers(
      dummySubject,
      dummyWorkspaceId,
      { limit: 2 },
    );
    expect(fakeStore.listRoster).toHaveBeenCalledWith(
      dummyClient,
      dummyWorkspaceId,
      undefined,
      3,
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_LIST_OUTCOMES.OK);
    if (outcome.kind === WORKSPACE_MEMBER_LIST_OUTCOMES.OK) {
      expect(outcome.page.items).toEqual([fakeMember1, fakeMember2]);
      expect(outcome.page.pageInfo.hasNextPage).toBe(true);
      expect(outcome.page.pageInfo.nextCursor).not.toBeNull();
    }
  });

  it('returns a null nextCursor when the store returns no extra row', async () => {
    const fakeStore: WorkspaceMemberStore = {
      readMembership: vi.fn().mockResolvedValue({
        role: 'owner',
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      }),
      listRoster: vi.fn().mockResolvedValue([fakeMember1, fakeMember2]),
    };
    const fakeTransaction: WorkspaceMemberReadTransaction = {
      runRead: vi.fn(async (_subject, callback) => callback(dummyClient)),
    };
    const service = new WorkspaceMemberService(fakeTransaction, fakeStore);

    const outcome = await service.listWorkspaceMembers(
      dummySubject,
      dummyWorkspaceId,
      { limit: 2 },
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_LIST_OUTCOMES.OK);
    if (outcome.kind === WORKSPACE_MEMBER_LIST_OUTCOMES.OK) {
      expect(outcome.page.items).toEqual([fakeMember1, fakeMember2]);
      expect(outcome.page.pageInfo.hasNextPage).toBe(false);
      expect(outcome.page.pageInfo.nextCursor).toBeNull();
    }
  });

  it('encodes nextCursor from the last item joinedAt and id', async () => {
    const fakeStore: WorkspaceMemberStore = {
      readMembership: vi.fn().mockResolvedValue({
        role: 'owner',
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      }),
      listRoster: vi
        .fn()
        .mockResolvedValue([fakeMember1, fakeMember2, fakeMember3]),
    };
    const fakeTransaction: WorkspaceMemberReadTransaction = {
      runRead: vi.fn(async (_subject, callback) => callback(dummyClient)),
    };
    const service = new WorkspaceMemberService(fakeTransaction, fakeStore);

    const outcome = await service.listWorkspaceMembers(
      dummySubject,
      dummyWorkspaceId,
      { limit: 2 },
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_LIST_OUTCOMES.OK);
    if (outcome.kind === WORKSPACE_MEMBER_LIST_OUTCOMES.OK) {
      const nextCursor = outcome.page.pageInfo.nextCursor;
      expect(nextCursor).not.toBeNull();
      const decoded = decodeMemberCursor(nextCursor!);
      expect(decoded).toEqual({
        joinedAt: fakeMember2.joinedAt,
        membershipId: fakeMember2.id,
      });
    }
  });

  it('reads through runRead and never through run', async () => {
    const run = vi.fn();
    const runRead = vi.fn(async (_subject, callback) => callback(dummyClient));
    const fakeTransaction = {
      run,
      runRead,
    } as unknown as WorkspaceMemberReadTransaction;
    const fakeStore: WorkspaceMemberStore = {
      readMembership: vi.fn().mockResolvedValue({
        role: 'owner',
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      }),
      listRoster: vi.fn().mockResolvedValue([fakeMember1]),
    };
    const service = new WorkspaceMemberService(fakeTransaction, fakeStore);

    await service.listWorkspaceMembers(dummySubject, dummyWorkspaceId, {
      limit: 50,
    });
    expect(runRead).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });
});
