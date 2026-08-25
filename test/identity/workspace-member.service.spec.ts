import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyStore } from '../../src/identity/idempotency.port.js';
import { computeRequestFingerprint } from '../../src/identity/idempotency.service.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import {
  decodeCursor,
  encodeCursor,
  MAX_CURSOR_LENGTH,
} from '../../src/platform/cursor.js';
import {
  WORKSPACE_MEMBER_LIST_OUTCOMES,
  WORKSPACE_MEMBER_REMOVE_OUTCOMES,
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
import { IDENTITY_PROBLEM_TYPES } from '../../src/identity/identity-problem-types.js';

describe('WorkspaceMemberService.listWorkspaceMembers', () => {
  const dummySubject = '3f084ac5-18a6-4e09-920d-2e3da29df7c8';
  const dummyWorkspaceId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const dummyClient = {
    query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
  } as unknown as TransactionClient;

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
      listRoster: vi.fn().mockResolvedValue([
        { member: fakeMember1, cursorAt: '2026-07-15T01:00:00.000000Z' },
        { member: fakeMember2, cursorAt: '2026-07-15T02:00:00.000000Z' },
      ]),
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
      listRoster: vi.fn().mockResolvedValue([
        { member: fakeMember1, cursorAt: '2026-07-15T01:00:00.000000Z' },
        { member: fakeMember2, cursorAt: '2026-07-15T02:00:00.000000Z' },
        { member: fakeMember3, cursorAt: '2026-07-15T03:00:00.000000Z' },
      ]),
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
      listRoster: vi.fn().mockResolvedValue([
        { member: fakeMember1, cursorAt: '2026-07-15T01:00:00.000000Z' },
        { member: fakeMember2, cursorAt: '2026-07-15T02:00:00.000000Z' },
      ]),
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
      listRoster: vi.fn().mockResolvedValue([
        { member: fakeMember1, cursorAt: '2026-07-15T01:00:00.000000Z' },
        { member: fakeMember2, cursorAt: '2026-07-15T02:00:00.000000Z' },
        { member: fakeMember3, cursorAt: '2026-07-15T03:00:00.000000Z' },
      ]),
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
      const decoded = decodeCursor(nextCursor!, dummyWorkspaceId);
      expect(decoded).toEqual({
        workspaceId: dummyWorkspaceId,
        createdAt: '2026-07-15T02:00:00.000000Z',
        id: fakeMember2.id,
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
      deleteMember: vi.fn().mockResolvedValue(1),
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

  it('updateWorkspaceMember: a caller who loses authority between the UPDATE and the residual reads answers forbidden, not not-found', async () => {
    // Models READ COMMITTED snapshot interleaving:
    // A concurrent transaction demotes the caller between the two residual reads.
    // If caller is read FIRST (wrong order): its snapshot is taken before the demotion
    // commits, so it still sees owner authority. Then the target read's snapshot is taken
    // after the demotion commits, so RLS hides the target -> NOT_FOUND (the bug).
    // If target is read FIRST (correct order): the target is still visible. Then the
    // caller read's snapshot sees the demotion -> viewer -> FORBIDDEN (correct).
    let callerResidualCalled = false;
    let targetResidualCalled = false;
    let callerReadCount = 0;
    let targetReadCount = 0;
    const { service } = createService({
      readMembership: vi.fn().mockImplementation(() => {
        callerReadCount++;
        if (callerReadCount === 1) {
          return Promise.resolve(defaultCallerMembership);
        }
        callerResidualCalled = true;
        if (targetResidualCalled) {
          // Correct order: target was read first, demotion committed, caller sees viewer
          return Promise.resolve({
            role: WORKSPACE_ROLE.VIEWER,
            status: WORKSPACE_MEMBER_STATUS.ACTIVE,
          });
        }
        // Wrong order: caller read first, snapshot before demotion -> still sees owner
        return Promise.resolve(defaultCallerMembership);
      }),
      readMembershipById: vi.fn().mockImplementation(() => {
        targetReadCount++;
        if (targetReadCount === 1) {
          return Promise.resolve(defaultTargetMembership);
        }
        targetResidualCalled = true;
        if (callerResidualCalled) {
          // Wrong order: caller was read first (still saw owner), demotion now committed,
          // RLS hides the target from the demoted caller
          return Promise.resolve(undefined);
        }
        // Correct order: target read first, demotion not yet committed, target visible
        return Promise.resolve(defaultTargetMembership);
      }),
      updateMemberRole: vi.fn().mockResolvedValue({ rowCount: 0 }),
    });
    const outcome = await service.updateWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      { role: WORKSPACE_ROLE.EDITOR },
    );
    // Correct order: target visible (conflict), caller demoted -> FORBIDDEN
    // Wrong order: caller still owner (passes), target hidden -> NOT_FOUND (bug!)
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_UPDATE_OUTCOMES.FORBIDDEN);
  });

  it('updateWorkspaceMember positive control: caller retains authority but target is genuinely absent answers not-found', async () => {
    let targetReadCount = 0;
    const { service } = createService({
      readMembership: vi.fn().mockResolvedValue({
        role: WORKSPACE_ROLE.ADMINISTRATOR,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      }),
      readMembershipById: vi.fn().mockImplementation(() => {
        targetReadCount++;
        if (targetReadCount === 1) {
          return Promise.resolve(defaultTargetMembership);
        }
        return Promise.resolve(undefined);
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

describe('encodeCursor and decodeCursor with workspaceId binding', () => {
  const wsId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const otherWsId = '8c9e6679-7425-40de-944b-e07fc1f90ae8';
  const createdAt = '2026-07-15T01:00:00.000000Z';
  const memId = '11111111-1111-1111-1111-111111111111';

  it('round-trips a valid member cursor', () => {
    const raw = encodeCursor({
      workspaceId: wsId,
      createdAt,
      id: memId,
    });
    // A member cursor is bound, so only the bound site accepts it: what a call
    // site emits is exactly what that same site accepts.
    expect(decodeCursor(raw)).toBeUndefined();
    expect(decodeCursor(raw, wsId)).toEqual({
      workspaceId: wsId,
      createdAt,
      id: memId,
    });
  });

  it('rejects a cursor encoded for another workspace when expectedWorkspaceId is provided', () => {
    const raw = encodeCursor({
      workspaceId: otherWsId,
      createdAt,
      id: memId,
    });
    expect(decodeCursor(raw, wsId)).toBeUndefined();
  });

  it('rejects an over-long cursor exceeding MAX_CURSOR_LENGTH before JSON parsing', () => {
    const raw = encodeCursor({
      workspaceId: wsId,
      createdAt,
      id: memId,
    });
    expect(raw.length).toBeLessThanOrEqual(MAX_CURSOR_LENGTH);
    const overlong = raw + 'A'.repeat(MAX_CURSOR_LENGTH);
    expect(overlong.length).toBeGreaterThan(MAX_CURSOR_LENGTH);

    const parseSpy = vi.spyOn(JSON, 'parse');
    try {
      parseSpy.mockClear();
      expect(decodeCursor(overlong)).toBeUndefined();
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('rejects a cursor with non-canonical payload such as trailing whitespace', () => {
    const padded = Buffer.from(
      JSON.stringify([wsId, createdAt, memId]) + '   ',
    ).toString('base64url');
    expect(decodeCursor(padded)).toBeUndefined();
  });

  it('rejects non-base64url characters and empty string', () => {
    expect(decodeCursor('')).toBeUndefined();
    expect(decodeCursor('!!!not-base64url!!!')).toBeUndefined();
    expect(decodeCursor('abc\0def')).toBeUndefined();
  });

  it('rejects year-0000 timestamp and extended-year timestamp', () => {
    const y0000 = Buffer.from(
      JSON.stringify([wsId, '0000-01-01T00:00:00.000000Z', memId]),
    ).toString('base64url');
    expect(decodeCursor(y0000)).toBeUndefined();

    const extended = Buffer.from(
      JSON.stringify([wsId, '+275760-09-13T00:00:00.000000Z', memId]),
    ).toString('base64url');
    expect(decodeCursor(extended)).toBeUndefined();
  });

  it('rejects non-UUID workspaceId or membershipId', () => {
    const badWs = Buffer.from(
      JSON.stringify(['not-a-uuid', createdAt, memId]),
    ).toString('base64url');
    expect(decodeCursor(badWs)).toBeUndefined();

    const badMem = Buffer.from(
      JSON.stringify([wsId, createdAt, 'not-a-uuid']),
    ).toString('base64url');
    expect(decodeCursor(badMem)).toBeUndefined();
  });
});

describe('WorkspaceMemberService.removeWorkspaceMember', () => {
  const dummySubject = '3f084ac5-18a6-4e09-920d-2e3da29df7c8';
  const dummyWorkspaceId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const dummyMemberId = '11111111-1111-1111-1111-111111111111';
  const dummyKey = 'a0000000-0000-0000-0000-000000000001';
  const dummyClient = {
    query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
  } as unknown as TransactionClient;

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

  function createRemoveService(
    storeOverrides: Partial<WorkspaceMemberStore> = {},
    transactionOverrides: Partial<WorkspaceMemberTransaction> = {},
    idempotencyOverrides: Partial<IdempotencyStore> = {},
  ) {
    const store: WorkspaceMemberStore = {
      readMembership: vi.fn().mockResolvedValue(defaultCallerMembership),
      listRoster: vi.fn().mockResolvedValue([]),
      readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.SHARED),
      readMembershipById: vi.fn().mockResolvedValue(defaultTargetMembership),
      retainsActiveOwner: vi.fn().mockResolvedValue(true),
      updateMemberRole: vi.fn().mockResolvedValue({ rowCount: 1, version: 4 }),
      deleteMember: vi.fn().mockResolvedValue(1),
      enforceDeferredConstraints: vi.fn().mockResolvedValue(undefined),
      readRosterMember: vi.fn().mockResolvedValue(undefined),
      ...storeOverrides,
    };
    const transaction: WorkspaceMemberTransaction = {
      run: vi.fn(async (_subject, callback) => callback(dummyClient)),
      runRead: vi.fn(async (_subject, callback) => callback(dummyClient)),
      ...transactionOverrides,
    };
    const idempotencyStore: IdempotencyStore = {
      read: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(true),
      ...idempotencyOverrides,
    };
    return {
      service: new WorkspaceMemberService(transaction, store, idempotencyStore),
      store,
      transaction,
      idempotencyStore,
    };
  }

  it('happy path: owner removes viewer -> REMOVED', async () => {
    const { service, store, idempotencyStore } = createRemoveService();
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.REMOVED);
    expect(store.deleteMember).toHaveBeenCalledWith(
      dummyClient,
      dummyWorkspaceId,
      dummyMemberId,
    );
    expect(idempotencyStore.write).toHaveBeenCalledWith(
      dummyClient,
      dummySubject,
      'DELETE /v1/workspaces/{workspaceId}/members/{memberId}',
      dummyKey,
      expect.any(String),
      204,
      null,
      null,
      dummyWorkspaceId,
    );
  });

  it('happy path: administrator removes viewer -> REMOVED', async () => {
    const { service } = createRemoveService({
      readMembership: vi.fn().mockResolvedValue({
        role: WORKSPACE_ROLE.ADMINISTRATOR,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      }),
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.REMOVED);
  });

  it('happy path: owner removes co-owner when another owner remains -> REMOVED', async () => {
    const { service } = createRemoveService({
      readMembershipById: vi.fn().mockResolvedValue({
        ...defaultTargetMembership,
        role: WORKSPACE_ROLE.OWNER,
      }),
      retainsActiveOwner: vi.fn().mockResolvedValue(true),
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.REMOVED);
  });

  it('happy path: an owner removes a member who happens to be themselves when another owner remains -> REMOVED', async () => {
    const { service } = createRemoveService({
      readMembershipById: vi.fn().mockResolvedValue({
        ...defaultTargetMembership,
        profileId: dummySubject,
        role: WORKSPACE_ROLE.OWNER,
      }),
      retainsActiveOwner: vi.fn().mockResolvedValue(true),
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.REMOVED);
  });

  it('idempotency: replayed matching fingerprint returns REPLAYED with stored status and problem type', async () => {
    const matchingFingerprint = computeRequestFingerprint({
      workspaceId: dummyWorkspaceId,
      memberId: dummyMemberId,
    });
    const { service } = createRemoveService(
      {},
      {},
      {
        read: vi.fn().mockResolvedValue({
          requestFingerprint: matchingFingerprint,
          responseStatus: 409,
          responseEtag: null,
          responseBody: { type: IDENTITY_PROBLEM_TYPES.LAST_OWNER_REQUIRED },
        }),
      },
    );
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.REPLAYED);
    if (outcome.kind === WORKSPACE_MEMBER_REMOVE_OUTCOMES.REPLAYED) {
      expect(outcome.status).toBe(409);
      expect(outcome.problemType).toBe(
        IDENTITY_PROBLEM_TYPES.LAST_OWNER_REQUIRED,
      );
    }
  });

  it('idempotency: replayed matching fingerprint for 204 returns REPLAYED with status 204 and undefined problemType', async () => {
    const matchingFingerprint = computeRequestFingerprint({
      workspaceId: dummyWorkspaceId,
      memberId: dummyMemberId,
    });
    const { service } = createRemoveService(
      {},
      {},
      {
        read: vi.fn().mockResolvedValue({
          requestFingerprint: matchingFingerprint,
          responseStatus: 204,
          responseEtag: null,
          responseBody: null,
        }),
      },
    );
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.REPLAYED);
    if (outcome.kind === WORKSPACE_MEMBER_REMOVE_OUTCOMES.REPLAYED) {
      expect(outcome.status).toBe(204);
      expect(outcome.problemType).toBeUndefined();
    }
  });

  it('idempotency: replayed with different fingerprint returns IDEMPOTENCY_CONFLICT', async () => {
    const { service } = createRemoveService(
      {},
      {},
      {
        read: vi.fn().mockResolvedValue({
          requestFingerprint:
            'different-fingerprint-64-chars-000000000000000000000000000000000000',
          responseStatus: 204,
          responseEtag: null,
          responseBody: null,
        }),
      },
    );
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(
      WORKSPACE_MEMBER_REMOVE_OUTCOMES.IDEMPOTENCY_CONFLICT,
    );
  });

  it('idempotency: stores { type } for 409 refusals in response_body', async () => {
    const writeSpy = vi.fn().mockResolvedValue(true);
    const { service } = createRemoveService(
      {
        readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.PERSONAL),
      },
      {},
      {
        write: writeSpy,
      },
    );
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(
      WORKSPACE_MEMBER_REMOVE_OUTCOMES.PERSONAL_WORKSPACE,
    );
    expect(writeSpy).toHaveBeenCalledWith(
      dummyClient,
      dummySubject,
      'DELETE /v1/workspaces/{workspaceId}/members/{memberId}',
      dummyKey,
      expect.any(String),
      409,
      null,
      { type: IDENTITY_PROBLEM_TYPES.PERSONAL_WORKSPACE_MEMBERSHIP },
      dummyWorkspaceId,
    );
  });

  it('idempotency: write collision (!written) re-reads and replays if matching fingerprint', async () => {
    const matchingFingerprint = computeRequestFingerprint({
      workspaceId: dummyWorkspaceId,
      memberId: dummyMemberId,
    });
    let readCount = 0;
    const { service } = createRemoveService(
      {},
      {},
      {
        read: vi.fn().mockImplementation(() => {
          readCount++;
          if (readCount === 1) return Promise.resolve(undefined);
          return Promise.resolve({
            requestFingerprint: matchingFingerprint,
            responseStatus: 204,
            responseEtag: null,
            responseBody: null,
          });
        }),
        write: vi.fn().mockResolvedValue(false),
      },
    );
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.REPLAYED);
  });

  it('idempotency: write collision (!written) returns IDEMPOTENCY_CONFLICT if re-read fingerprint differs', async () => {
    let readCount = 0;
    const { service } = createRemoveService(
      {},
      {},
      {
        read: vi.fn().mockImplementation(() => {
          readCount++;
          if (readCount === 1) return Promise.resolve(undefined);
          return Promise.resolve({
            requestFingerprint:
              'different-fingerprint-64-chars-000000000000000000000000000000000000',
            responseStatus: 204,
            responseEtag: null,
            responseBody: null,
          });
        }),
        write: vi.fn().mockResolvedValue(false),
      },
    );
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(
      WORKSPACE_MEMBER_REMOVE_OUTCOMES.IDEMPOTENCY_CONFLICT,
    );
  });

  it('step 5: returns not-found when caller has no membership row', async () => {
    const { service } = createRemoveService({
      readMembership: vi.fn().mockResolvedValue(undefined),
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.NOT_FOUND);
  });

  it('step 6: returns forbidden when caller membership is suspended', async () => {
    const { service } = createRemoveService({
      readMembership: vi.fn().mockResolvedValue({
        role: WORKSPACE_ROLE.OWNER,
        status: WORKSPACE_MEMBER_STATUS.SUSPENDED,
      }),
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.FORBIDDEN);
  });

  it('step 7: returns forbidden when caller role is editor or viewer', async () => {
    for (const role of [
      WORKSPACE_ROLE.EDITOR,
      WORKSPACE_ROLE.VIEWER,
    ] as const) {
      const { service } = createRemoveService({
        readMembership: vi.fn().mockResolvedValue({
          role,
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        }),
      });
      const outcome = await service.removeWorkspaceMember(
        dummySubject,
        dummyWorkspaceId,
        dummyMemberId,
        dummyKey,
      );
      expect(outcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.FORBIDDEN);
    }
  });

  it('step 8: returns personal-workspace when workspace kind is personal', async () => {
    const { service } = createRemoveService({
      readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.PERSONAL),
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(
      WORKSPACE_MEMBER_REMOVE_OUTCOMES.PERSONAL_WORKSPACE,
    );
  });

  it('step 8 before step 11 ordering: in a personal workspace, returns PERSONAL_WORKSPACE and does not call retainsActiveOwner', async () => {
    const retainsSpy = vi.fn().mockResolvedValue(false);
    const { service } = createRemoveService({
      readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.PERSONAL),
      readMembershipById: vi.fn().mockResolvedValue({
        ...defaultTargetMembership,
        role: WORKSPACE_ROLE.OWNER,
      }),
      retainsActiveOwner: retainsSpy,
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(
      WORKSPACE_MEMBER_REMOVE_OUTCOMES.PERSONAL_WORKSPACE,
    );
    expect(retainsSpy).not.toHaveBeenCalled();
  });

  it('step 9: returns not-found when target membership row is not found in this workspace', async () => {
    const { service } = createRemoveService({
      readMembershipById: vi.fn().mockResolvedValue(undefined),
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.NOT_FOUND);
  });

  it('step 10: returns forbidden when target role is owner and caller is administrator', async () => {
    const { service } = createRemoveService({
      readMembership: vi.fn().mockResolvedValue({
        role: WORKSPACE_ROLE.ADMINISTRATOR,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      }),
      readMembershipById: vi.fn().mockResolvedValue({
        ...defaultTargetMembership,
        role: WORKSPACE_ROLE.OWNER,
      }),
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.FORBIDDEN);
  });

  it('step 11: returns last-owner-required when target is owner and retainsActiveOwner returns false', async () => {
    const { service } = createRemoveService({
      readMembershipById: vi.fn().mockResolvedValue({
        ...defaultTargetMembership,
        role: WORKSPACE_ROLE.OWNER,
      }),
      retainsActiveOwner: vi.fn().mockResolvedValue(false),
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(
      WORKSPACE_MEMBER_REMOVE_OUTCOMES.LAST_OWNER_REQUIRED,
    );
  });

  it('step 11 positive: succeeds when target is owner and retainsActiveOwner returns true', async () => {
    const { service } = createRemoveService({
      readMembershipById: vi.fn().mockResolvedValue({
        ...defaultTargetMembership,
        role: WORKSPACE_ROLE.OWNER,
      }),
      retainsActiveOwner: vi.fn().mockResolvedValue(true),
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.REMOVED);
  });

  it('catches SQLSTATE 23514 from enforceDeferredConstraints and maps to LAST_OWNER_REQUIRED', async () => {
    const checkViolationError = Object.assign(
      new Error(
        'check_violation: collaborative workspace must retain an active owner',
      ),
      { code: '23514' },
    );
    const { service } = createRemoveService({
      enforceDeferredConstraints: vi
        .fn()
        .mockRejectedValue(checkViolationError),
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(
      WORKSPACE_MEMBER_REMOVE_OUTCOMES.LAST_OWNER_REQUIRED,
    );
  });

  it('deferred-trigger 23514 path writes idempotency record with last-owner-required and replay returns 409', async () => {
    const checkViolationError = Object.assign(
      new Error(
        'check_violation: collaborative workspace must retain an active owner',
      ),
      { code: '23514' },
    );
    const writeSpy = vi.fn().mockResolvedValue(true);
    const { service } = createRemoveService(
      {
        enforceDeferredConstraints: vi
          .fn()
          .mockRejectedValue(checkViolationError),
      },
      {},
      {
        write: writeSpy,
      },
    );
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(
      WORKSPACE_MEMBER_REMOVE_OUTCOMES.LAST_OWNER_REQUIRED,
    );
    expect(writeSpy).toHaveBeenCalledWith(
      dummyClient,
      dummySubject,
      'DELETE /v1/workspaces/{workspaceId}/members/{memberId}',
      dummyKey,
      expect.any(String),
      409,
      null,
      { type: IDENTITY_PROBLEM_TYPES.LAST_OWNER_REQUIRED },
      dummyWorkspaceId,
    );

    // Replay of that key returns 409 with that exact type
    const matchingFingerprint = computeRequestFingerprint({
      workspaceId: dummyWorkspaceId,
      memberId: dummyMemberId,
    });
    const { service: replayService } = createRemoveService(
      {},
      {},
      {
        read: vi.fn().mockResolvedValue({
          requestFingerprint: matchingFingerprint,
          responseStatus: 409,
          responseEtag: null,
          responseBody: { type: IDENTITY_PROBLEM_TYPES.LAST_OWNER_REQUIRED },
        }),
      },
    );
    const replayOutcome = await replayService.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(replayOutcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.REPLAYED);
    if (replayOutcome.kind === WORKSPACE_MEMBER_REMOVE_OUTCOMES.REPLAYED) {
      expect(replayOutcome.status).toBe(409);
      expect(replayOutcome.problemType).toBe(
        IDENTITY_PROBLEM_TYPES.LAST_OWNER_REQUIRED,
      );
    }
  });

  it('lets non-23514 errors escape unchanged', async () => {
    const otherDbError = Object.assign(new Error('connection failure'), {
      code: '08006',
    });
    const { service } = createRemoveService({
      enforceDeferredConstraints: vi.fn().mockRejectedValue(otherDbError),
    });
    await expect(
      service.removeWorkspaceMember(
        dummySubject,
        dummyWorkspaceId,
        dummyMemberId,
        dummyKey,
      ),
    ).rejects.toThrow('connection failure');
  });

  it('zero-row delete: returns not-found when target row has since been deleted', async () => {
    let targetCallCount = 0;
    const { service } = createRemoveService({
      readMembershipById: vi.fn().mockImplementation(() => {
        targetCallCount++;
        return Promise.resolve(
          targetCallCount === 1 ? defaultTargetMembership : undefined,
        );
      }),
      deleteMember: vi.fn().mockResolvedValue(0),
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.NOT_FOUND);
  });

  it('zero-row delete: returns forbidden when caller lost administrator/owner authority', async () => {
    let callerCallCount = 0;
    const { service } = createRemoveService({
      readMembership: vi.fn().mockImplementation(() => {
        callerCallCount++;
        if (callerCallCount === 1)
          return Promise.resolve(defaultCallerMembership);
        return Promise.resolve({
          role: WORKSPACE_ROLE.VIEWER,
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        });
      }),
      deleteMember: vi.fn().mockResolvedValue(0),
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.FORBIDDEN);
  });

  it('a caller who loses authority between the DELETE and the residual reads answers forbidden, not not-found', async () => {
    // Models READ COMMITTED snapshot interleaving (see updateWorkspaceMember equivalent).
    let callerResidualCalled = false;
    let targetResidualCalled = false;
    let callerCallCount = 0;
    let targetCallCount = 0;
    const { service } = createRemoveService({
      readMembership: vi.fn().mockImplementation(() => {
        callerCallCount++;
        if (callerCallCount === 1) {
          return Promise.resolve(defaultCallerMembership);
        }
        callerResidualCalled = true;
        if (targetResidualCalled) {
          // Correct order: target was read first, demotion committed, caller sees viewer
          return Promise.resolve({
            role: WORKSPACE_ROLE.VIEWER,
            status: WORKSPACE_MEMBER_STATUS.ACTIVE,
          });
        }
        // Wrong order: caller read first, snapshot before demotion -> still sees owner
        return Promise.resolve(defaultCallerMembership);
      }),
      readMembershipById: vi.fn().mockImplementation(() => {
        targetCallCount++;
        if (targetCallCount === 1) {
          return Promise.resolve(defaultTargetMembership);
        }
        targetResidualCalled = true;
        if (callerResidualCalled) {
          // Wrong order: caller was read first (still saw owner), demotion now committed,
          // RLS hides the target
          return Promise.resolve(undefined);
        }
        // Correct order: target read first, demotion not yet committed, target visible
        return Promise.resolve(defaultTargetMembership);
      }),
      deleteMember: vi.fn().mockResolvedValue(0),
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    // Correct order: target visible, caller demoted -> FORBIDDEN
    // Wrong order: caller still owner (passes), target hidden -> NOT_FOUND (bug!)
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.FORBIDDEN);
  });

  it('positive control: caller retains authority but target is genuinely absent answers not-found', async () => {
    let targetCallCount = 0;
    const { service } = createRemoveService({
      readMembership: vi.fn().mockResolvedValue({
        role: WORKSPACE_ROLE.ADMINISTRATOR,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      }),
      readMembershipById: vi.fn().mockImplementation(() => {
        targetCallCount++;
        if (targetCallCount === 1) {
          return Promise.resolve(defaultTargetMembership);
        }
        return Promise.resolve(undefined);
      }),
      deleteMember: vi.fn().mockResolvedValue(0),
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.NOT_FOUND);
  });

  it('zero-row delete: returns policy refusal (forbidden) when target is owner and caller is administrator', async () => {
    let callerCallCount = 0;
    const { service } = createRemoveService({
      readMembership: vi.fn().mockImplementation(() => {
        callerCallCount++;
        if (callerCallCount === 1)
          return Promise.resolve(defaultCallerMembership);
        return Promise.resolve({
          role: WORKSPACE_ROLE.ADMINISTRATOR,
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        });
      }),
      readMembershipById: vi.fn().mockResolvedValue({
        ...defaultTargetMembership,
        role: WORKSPACE_ROLE.OWNER,
      }),
      deleteMember: vi.fn().mockResolvedValue(0),
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(WORKSPACE_MEMBER_REMOVE_OUTCOMES.FORBIDDEN);
  });

  it('zero-row delete: returns personal-workspace when target row is present and workspace is personal', async () => {
    const { service } = createRemoveService({
      readWorkspaceKind: vi
        .fn()
        .mockResolvedValueOnce(WORKSPACE_KIND.SHARED)
        .mockResolvedValueOnce(WORKSPACE_KIND.PERSONAL),
      deleteMember: vi.fn().mockResolvedValue(0),
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(
      WORKSPACE_MEMBER_REMOVE_OUTCOMES.PERSONAL_WORKSPACE,
    );
  });

  it('zero-row delete: returns last-owner-required when target is owner and RLS refused', async () => {
    const { service } = createRemoveService({
      readMembershipById: vi.fn().mockResolvedValue({
        ...defaultTargetMembership,
        role: WORKSPACE_ROLE.OWNER,
      }),
      deleteMember: vi.fn().mockResolvedValue(0),
    });
    const outcome = await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(outcome.kind).toBe(
      WORKSPACE_MEMBER_REMOVE_OUTCOMES.LAST_OWNER_REQUIRED,
    );
  });

  it('writes through run and never through runRead', async () => {
    const { service, transaction } = createRemoveService();
    await service.removeWorkspaceMember(
      dummySubject,
      dummyWorkspaceId,
      dummyMemberId,
      dummyKey,
    );
    expect(transaction.run).toHaveBeenCalledTimes(1);
    expect(transaction.runRead).not.toHaveBeenCalled();
  });
});
