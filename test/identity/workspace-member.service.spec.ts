import { describe, expect, it, vi } from 'vitest';

import type { TransactionClient } from '../../src/identity/pg-transaction.js';
import {
  decodeMemberCursor,
  encodeMemberCursor,
  MAX_MEMBER_CURSOR_LENGTH,
  WORKSPACE_MEMBER_LIST_OUTCOMES,
  WORKSPACE_MEMBER_UPDATE_OUTCOMES,
  type WorkspaceMember,
} from '../../src/identity/workspace-member.port.js';
import {
  WorkspaceMemberService,
  type WorkspaceMembershipDetailRecord,
  type WorkspaceMemberReadTransaction,
  type WorkspaceMemberStore,
  type WorkspaceMemberTransaction,
} from '../../src/identity/workspace-member.service.js';
import {
  WORKSPACE_KIND,
  WORKSPACE_MEMBER_STATUS,
  WORKSPACE_ROLE,
} from '../../src/identity/workspace.port.js';

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
    const fakeStore = {
      readMembership: vi.fn().mockResolvedValue(undefined),
      listRoster: vi.fn().mockResolvedValue([]),
    } as unknown as WorkspaceMemberStore;
    const fakeTransaction: WorkspaceMemberReadTransaction = {
      run: vi.fn(),
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
    const fakeStore = {
      readMembership: vi.fn().mockResolvedValue({
        role: 'viewer',
        status: WORKSPACE_MEMBER_STATUS.SUSPENDED,
      }),
      listRoster: vi.fn().mockResolvedValue([]),
    } as unknown as WorkspaceMemberStore;
    const fakeTransaction: WorkspaceMemberReadTransaction = {
      run: vi.fn(),
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
    const fakeStore = {
      readMembership: vi.fn().mockResolvedValue({
        role: 'owner',
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      }),
      listRoster: vi.fn().mockResolvedValue([fakeMember1, fakeMember2]),
    } as unknown as WorkspaceMemberStore;
    const fakeTransaction: WorkspaceMemberReadTransaction = {
      run: vi.fn(),
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
    const fakeStore = {
      readMembership: vi.fn().mockResolvedValue({
        role: 'owner',
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      }),
      listRoster: vi
        .fn()
        .mockResolvedValue([fakeMember1, fakeMember2, fakeMember3]),
    } as unknown as WorkspaceMemberStore;
    const fakeTransaction: WorkspaceMemberReadTransaction = {
      run: vi.fn(),
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
    const fakeStore = {
      readMembership: vi.fn().mockResolvedValue({
        role: 'owner',
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      }),
      listRoster: vi.fn().mockResolvedValue([fakeMember1, fakeMember2]),
    } as unknown as WorkspaceMemberStore;
    const fakeTransaction: WorkspaceMemberReadTransaction = {
      run: vi.fn(),
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
    const fakeStore = {
      readMembership: vi.fn().mockResolvedValue({
        role: 'owner',
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      }),
      listRoster: vi
        .fn()
        .mockResolvedValue([fakeMember1, fakeMember2, fakeMember3]),
    } as unknown as WorkspaceMemberStore;
    const fakeTransaction: WorkspaceMemberReadTransaction = {
      run: vi.fn(),
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
      const decoded = decodeMemberCursor(nextCursor!, dummyWorkspaceId);
      expect(decoded).toEqual({
        workspaceId: dummyWorkspaceId,
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
    const fakeStore = {
      readMembership: vi.fn().mockResolvedValue({
        role: 'owner',
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      }),
      listRoster: vi.fn().mockResolvedValue([fakeMember1]),
    } as unknown as WorkspaceMemberStore;
    const service = new WorkspaceMemberService(fakeTransaction, fakeStore);

    await service.listWorkspaceMembers(dummySubject, dummyWorkspaceId, {
      limit: 50,
    });
    expect(runRead).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('WorkspaceMemberService.updateWorkspaceMember', () => {
  const dummySubject = '3f084ac5-18a6-4e09-920d-2e3da29df7c8';
  const dummyWorkspaceId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const dummyMemberId = '11111111-1111-1111-1111-111111111111';
  const dummyClient = {} as TransactionClient;

  const defaultCallerMembership = {
    role: WORKSPACE_ROLE.OWNER,
    status: WORKSPACE_MEMBER_STATUS.ACTIVE,
  };

  const defaultTargetMembership: WorkspaceMembershipDetailRecord = {
    id: dummyMemberId,
    profileId: '5f084ac5-18a6-4e09-920d-2e3da29df7ca',
    role: WORKSPACE_ROLE.VIEWER,
    status: WORKSPACE_MEMBER_STATUS.ACTIVE,
    version: 3,
  };

  const defaultRosterMember: WorkspaceMember = {
    id: dummyMemberId,
    userId: '5f084ac5-18a6-4e09-920d-2e3da29df7ca',
    displayName: 'Target User',
    role: WORKSPACE_ROLE.EDITOR,
    status: WORKSPACE_MEMBER_STATUS.ACTIVE,
    joinedAt: '2026-07-15T01:00:00.000Z',
  };

  function createService(
    storeOverrides: Partial<WorkspaceMemberStore> = {},
    transactionOverrides: Partial<WorkspaceMemberTransaction> = {},
  ) {
    const store: WorkspaceMemberStore = {
      readMembership: vi.fn().mockResolvedValue(defaultCallerMembership),
      listRoster: vi.fn().mockResolvedValue([]),
      readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.SHARED),
      readMembershipById: vi.fn().mockResolvedValue(defaultTargetMembership),
      retainsActiveOwner: vi.fn().mockResolvedValue(true),
      updateMemberRole: vi.fn().mockResolvedValue({ rowCount: 1, version: 4 }),
      enforceDeferredConstraints: vi.fn().mockResolvedValue(undefined),
      readRosterMember: vi.fn().mockResolvedValue(defaultRosterMember),
      ...storeOverrides,
    };
    const transaction: WorkspaceMemberTransaction = {
      run: vi.fn(async (_subject, callback) => callback(dummyClient)),
      runRead: vi.fn(async (_subject, callback) => callback(dummyClient)),
      ...transactionOverrides,
    };
    return {
      service: new WorkspaceMemberService(transaction, store),
      store,
      transaction,
    };
  }

  it('happy path: owner promotes viewer to editor', async () => {
    const { service } = createService();
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_UPDATE_OUTCOMES.OK);
    if (outcome.kind === WORKSPACE_MEMBER_UPDATE_OUTCOMES.OK) {
      expect(outcome.member).toEqual(defaultRosterMember);
      expect(outcome.version).toBe(4);
    }
  });

  it('happy path: administrator promotes viewer to editor', async () => {
    const { service } = createService({
      readMembership: vi.fn().mockResolvedValue({
        role: WORKSPACE_ROLE.ADMINISTRATOR,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      }),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_UPDATE_OUTCOMES.OK);
  });

  it('happy path: owner promotes editor to owner', async () => {
    const { service } = createService({
      readMembershipById: vi.fn().mockResolvedValue({
        ...defaultTargetMembership,
        role: WORKSPACE_ROLE.EDITOR,
      }),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.OWNER },
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_UPDATE_OUTCOMES.OK);
  });

  it('happy path: no-op update (same role) succeeds and version still increments', async () => {
    const { service } = createService({
      readMembershipById: vi.fn().mockResolvedValue({
        ...defaultTargetMembership,
        role: WORKSPACE_ROLE.VIEWER,
      }),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.VIEWER },
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_UPDATE_OUTCOMES.OK);
    if (outcome.kind === WORKSPACE_MEMBER_UPDATE_OUTCOMES.OK) {
      expect(outcome.version).toBe(4);
    }
  });

  it('step 4: returns not-found when caller has no membership row', async () => {
    const { service } = createService({
      readMembership: vi.fn().mockResolvedValue(undefined),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_UPDATE_OUTCOMES.NOT_FOUND);
  });

  it('step 5: returns forbidden when caller membership is suspended', async () => {
    const { service } = createService({
      readMembership: vi.fn().mockResolvedValue({
        role: WORKSPACE_ROLE.OWNER,
        status: WORKSPACE_MEMBER_STATUS.SUSPENDED,
      }),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_UPDATE_OUTCOMES.FORBIDDEN);
  });

  it('step 6: returns forbidden when caller role is editor or viewer', async () => {
    for (const role of [
      WORKSPACE_ROLE.EDITOR,
      WORKSPACE_ROLE.VIEWER,
    ] as const) {
      const { service } = createService({
        readMembership: vi.fn().mockResolvedValue({
          role,
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        }),
      });
      const outcome = await service.updateWorkspaceMember(
        dummySubject,
        dummyWorkspaceId,
        dummyMemberId,
        { role: WORKSPACE_ROLE.VIEWER },
      );
      expect(outcome.kind).toBe(WORKSPACE_MEMBER_UPDATE_OUTCOMES.FORBIDDEN);
    }
  });

  it('step 7: returns personal-workspace when workspace kind is personal', async () => {
    const { service } = createService({
      readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.PERSONAL),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
    );
    expect(outcome.kind).toBe(
      WORKSPACE_MEMBER_UPDATE_OUTCOMES.PERSONAL_WORKSPACE,
    );
  });

  it('step 7 before step 12 order dependency: in a personal workspace, sole owner demotion returns PERSONAL_WORKSPACE and never LAST_OWNER_REQUIRED', async () => {
    const retainsActiveOwnerSpy = vi.fn().mockResolvedValue(false);
    const { service } = createService({
      readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.PERSONAL),
      readMembershipById: vi.fn().mockResolvedValue({
        ...defaultTargetMembership,
        role: WORKSPACE_ROLE.OWNER,
      }),
      retainsActiveOwner: retainsActiveOwnerSpy,
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
    );
    expect(outcome.kind).toBe(
      WORKSPACE_MEMBER_UPDATE_OUTCOMES.PERSONAL_WORKSPACE,
    );
    expect(retainsActiveOwnerSpy).not.toHaveBeenCalled();
  });

  it('step 8: returns not-found when target membership row is not found in this workspace', async () => {
    const { service } = createService({
      readMembershipById: vi.fn().mockResolvedValue(undefined),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_UPDATE_OUTCOMES.NOT_FOUND);
  });

  it('step 9: returns forbidden when target current role is owner and caller is administrator', async () => {
    const { service } = createService({
      readMembership: vi.fn().mockResolvedValue({
        role: WORKSPACE_ROLE.ADMINISTRATOR,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      }),
      readMembershipById: vi.fn().mockResolvedValue({
        ...defaultTargetMembership,
        role: WORKSPACE_ROLE.OWNER,
      }),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_UPDATE_OUTCOMES.FORBIDDEN);
  });

  it('step 10: returns forbidden when requested role is owner and caller is administrator', async () => {
    const { service } = createService({
      readMembership: vi.fn().mockResolvedValue({
        role: WORKSPACE_ROLE.ADMINISTRATOR,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      }),
      readMembershipById: vi.fn().mockResolvedValue({
        ...defaultTargetMembership,
        role: WORKSPACE_ROLE.EDITOR,
      }),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.OWNER },
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_UPDATE_OUTCOMES.FORBIDDEN);
  });

  it('step 11: returns version-conflict when If-Match version does not match target current version', async () => {
    const { service } = createService({
      readMembershipById: vi.fn().mockResolvedValue({
        ...defaultTargetMembership,
        version: 3,
      }),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
      [1, 2], // 3 is not in [1, 2]
    );
    expect(outcome.kind).toBe(
      WORKSPACE_MEMBER_UPDATE_OUTCOMES.VERSION_CONFLICT,
    );
  });

  it('step 11 positive: passes when If-Match version matches target current version', async () => {
    const { service } = createService({
      readMembershipById: vi.fn().mockResolvedValue({
        ...defaultTargetMembership,
        version: 3,
      }),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
      [1, 3],
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_UPDATE_OUTCOMES.OK);
  });

  it('step 12: returns last-owner-required when demoting an owner and retainsActiveOwner returns false', async () => {
    const { service } = createService({
      readMembershipById: vi.fn().mockResolvedValue({
        ...defaultTargetMembership,
        role: WORKSPACE_ROLE.OWNER,
      }),
      retainsActiveOwner: vi.fn().mockResolvedValue(false),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
    );
    expect(outcome.kind).toBe(
      WORKSPACE_MEMBER_UPDATE_OUTCOMES.LAST_OWNER_REQUIRED,
    );
  });

  it('step 12 positive: succeeds when demoting an owner and retainsActiveOwner returns true', async () => {
    const { service } = createService({
      readMembershipById: vi.fn().mockResolvedValue({
        ...defaultTargetMembership,
        role: WORKSPACE_ROLE.OWNER,
      }),
      retainsActiveOwner: vi.fn().mockResolvedValue(true),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_UPDATE_OUTCOMES.OK);
  });

  it('catches SQLSTATE 23514 from enforceDeferredConstraints and maps to LAST_OWNER_REQUIRED', async () => {
    const checkViolationError = Object.assign(
      new Error(
        'check_violation: collaborative workspace must retain an active owner',
      ),
      { code: '23514' },
    );
    const { service } = createService({
      enforceDeferredConstraints: vi
        .fn()
        .mockRejectedValue(checkViolationError),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
    );
    expect(outcome.kind).toBe(
      WORKSPACE_MEMBER_UPDATE_OUTCOMES.LAST_OWNER_REQUIRED,
    );
  });

  it('residual zero-row update: returns forbidden when caller loses authority between pre-check and residual re-read', async () => {
    let callerReadCount = 0;
    const { service } = createService({
      readMembership: vi.fn().mockImplementation(() => {
        callerReadCount++;
        if (callerReadCount === 1) {
          return Promise.resolve(defaultCallerMembership);
        }
        return Promise.resolve({
          role: WORKSPACE_ROLE.EDITOR,
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        });
      }),
      updateMemberRole: vi.fn().mockResolvedValue({ rowCount: 0 }),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_UPDATE_OUTCOMES.FORBIDDEN);
  });

  it('residual zero-row update: returns not-found when target row has since been deleted', async () => {
    let callCount = 0;
    const { service } = createService({
      readMembershipById: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(
          callCount === 1 ? defaultTargetMembership : undefined,
        );
      }),
      updateMemberRole: vi.fn().mockResolvedValue({ rowCount: 0 }),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_UPDATE_OUTCOMES.NOT_FOUND);
  });

  it('residual zero-row update: returns version-conflict when target row exists and expectedVersion was provided', async () => {
    const { service } = createService({
      updateMemberRole: vi.fn().mockResolvedValue({ rowCount: 0 }),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
      3,
    );
    expect(outcome.kind).toBe(
      WORKSPACE_MEMBER_UPDATE_OUTCOMES.VERSION_CONFLICT,
    );
  });

  it('residual zero-row update: returns conflict when target row exists and no expectedVersion was provided', async () => {
    const { service } = createService({
      updateMemberRole: vi.fn().mockResolvedValue({ rowCount: 0 }),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_UPDATE_OUTCOMES.CONFLICT);
  });

  it('lets non-23514 errors escape unchanged', async () => {
    const otherDbError = Object.assign(new Error('connection failure'), {
      code: '08006',
    });
    const { service } = createService({
      enforceDeferredConstraints: vi.fn().mockRejectedValue(otherDbError),
    });
    await expect(
      service.updateWorkspaceMember(
        dummySubject,
        dummyWorkspaceId,
        dummyMemberId,
        { role: WORKSPACE_ROLE.EDITOR },
      ),
    ).rejects.toThrow('connection failure');
  });

  it('writes through run and never through runRead', async () => {
    const { service, transaction } = createService();
    await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
    );
    expect(transaction.run).toHaveBeenCalledTimes(1);
    expect(transaction.runRead).not.toHaveBeenCalled();
  });
});

describe('encodeMemberCursor and decodeMemberCursor', () => {
  const wsId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const otherWsId = '8c9e6679-7425-40de-944b-e07fc1f90ae8';
  const joinedAt = '2026-07-15T01:00:00.000Z';
  const memId = '11111111-1111-1111-1111-111111111111';

  it('round-trips a valid member cursor', () => {
    const raw = encodeMemberCursor({
      workspaceId: wsId,
      joinedAt,
      membershipId: memId,
    });
    expect(decodeMemberCursor(raw)).toEqual({
      workspaceId: wsId,
      joinedAt,
      membershipId: memId,
    });
    expect(decodeMemberCursor(raw, wsId)).toEqual({
      workspaceId: wsId,
      joinedAt,
      membershipId: memId,
    });
  });

  it('rejects a cursor encoded for another workspace when expectedWorkspaceId is provided', () => {
    const raw = encodeMemberCursor({
      workspaceId: otherWsId,
      joinedAt,
      membershipId: memId,
    });
    expect(decodeMemberCursor(raw, wsId)).toBeUndefined();
  });

  it('rejects an over-long cursor exceeding MAX_MEMBER_CURSOR_LENGTH before JSON parsing', () => {
    const raw = encodeMemberCursor({
      workspaceId: wsId,
      joinedAt,
      membershipId: memId,
    });
    expect(raw.length).toBeLessThanOrEqual(MAX_MEMBER_CURSOR_LENGTH);
    const overlong = raw + 'A'.repeat(MAX_MEMBER_CURSOR_LENGTH);
    expect(overlong.length).toBeGreaterThan(MAX_MEMBER_CURSOR_LENGTH);

    const parseSpy = vi.spyOn(JSON, 'parse');
    try {
      parseSpy.mockClear();
      expect(decodeMemberCursor(overlong)).toBeUndefined();
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('rejects a cursor with non-canonical payload such as trailing whitespace', () => {
    const padded = Buffer.from(
      JSON.stringify([wsId, joinedAt, memId]) + '   ',
    ).toString('base64url');
    expect(decodeMemberCursor(padded)).toBeUndefined();
  });

  it('rejects non-base64url characters and empty string', () => {
    expect(decodeMemberCursor('')).toBeUndefined();
    expect(decodeMemberCursor('!!!not-base64url!!!')).toBeUndefined();
    expect(decodeMemberCursor('abc\0def')).toBeUndefined();
  });

  it('rejects year-0000 timestamp and extended-year timestamp', () => {
    const y0000 = Buffer.from(
      JSON.stringify([wsId, '0000-01-01T00:00:00.000Z', memId]),
    ).toString('base64url');
    expect(decodeMemberCursor(y0000)).toBeUndefined();

    const extended = Buffer.from(
      JSON.stringify([wsId, '+275760-09-13T00:00:00.000Z', memId]),
    ).toString('base64url');
    expect(decodeMemberCursor(extended)).toBeUndefined();
  });

  it('rejects non-UUID workspaceId or membershipId', () => {
    const badWs = Buffer.from(
      JSON.stringify(['not-a-uuid', joinedAt, memId]),
    ).toString('base64url');
    expect(decodeMemberCursor(badWs)).toBeUndefined();

    const badMem = Buffer.from(
      JSON.stringify([wsId, joinedAt, 'not-a-uuid']),
    ).toString('base64url');
    expect(decodeMemberCursor(badMem)).toBeUndefined();
  });
});
