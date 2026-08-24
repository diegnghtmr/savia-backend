import { describe, expect, it, vi } from 'vitest';

import type { IdempotencyStore } from '../../src/identity/idempotency.port.js';
import { computeRequestFingerprint } from '../../src/identity/idempotency.service.js';
import type { TransactionClient } from '../../src/identity/pg-transaction.js';
import {
  WORKSPACE_INVITATION_CREATE_OUTCOMES,
  WORKSPACE_INVITATION_LIST_OUTCOMES,
  type WorkspaceInvitation,
} from '../../src/identity/workspace-invitation.port.js';
import {
  WorkspaceInvitationService,
  type WorkspaceInvitationReadTransaction,
  type WorkspaceInvitationStore,
  type WorkspaceInvitationTransaction,
} from '../../src/identity/workspace-invitation.service.js';
import {
  WORKSPACE_KIND,
  WORKSPACE_MEMBER_STATUS,
  WORKSPACE_ROLE,
} from '../../src/identity/workspace.port.js';

describe('WorkspaceInvitationService', () => {
  const dummySubject = '3f084ac5-18a6-4e09-920d-2e3da29df7c8';
  const dummyWorkspaceId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const dummyClient = {} as TransactionClient;

  const fakeInvitation1: WorkspaceInvitation = {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'alice@example.test',
    role: 'editor',
    status: 'pending',
    expiresAt: '2026-07-22T01:00:00.000Z',
    createdAt: '2026-07-15T01:00:00.000Z',
  };

  const fakeInvitation2: WorkspaceInvitation = {
    id: '22222222-2222-2222-2222-222222222222',
    email: 'bob@example.test',
    role: 'viewer',
    status: 'pending',
    expiresAt: '2026-07-22T02:00:00.000Z',
    createdAt: '2026-07-15T02:00:00.000Z',
  };

  const fakeInvitation3: WorkspaceInvitation = {
    id: '33333333-3333-3333-3333-333333333333',
    email: 'charlie@example.test',
    role: 'administrator',
    status: 'expired',
    expiresAt: '2026-07-10T00:00:00.000Z',
    createdAt: '2026-07-03T00:00:00.000Z',
  };

  const createDummyIdempotencyStore = (): IdempotencyStore =>
    ({
      read: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(true),
    }) as unknown as IdempotencyStore;

  describe('listWorkspaceInvitations (RULING 26 Visibility Rule)', () => {
    it('row 1: returns not-found when the caller has no membership in this workspace', async () => {
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue(undefined),
        listInvitations: vi.fn().mockResolvedValue([]),
      } as unknown as WorkspaceInvitationStore;
      const fakeTransaction: WorkspaceInvitationReadTransaction = {
        run: vi.fn(),
        runRead: vi.fn(async (_subject, callback) => callback(dummyClient)),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        createDummyIdempotencyStore(),
      );

      const outcome = await service.listWorkspaceInvitations(
        dummySubject,
        dummyWorkspaceId,
        { limit: 50 },
      );
      expect(outcome.kind).toBe(WORKSPACE_INVITATION_LIST_OUTCOMES.NOT_FOUND);
    });

    it("row 2: returns forbidden when the caller's membership is suspended", async () => {
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue({
          role: 'owner',
          status: WORKSPACE_MEMBER_STATUS.SUSPENDED,
        }),
        listInvitations: vi.fn().mockResolvedValue([]),
      } as unknown as WorkspaceInvitationStore;
      const fakeTransaction: WorkspaceInvitationReadTransaction = {
        run: vi.fn(),
        runRead: vi.fn(async (_subject, callback) => callback(dummyClient)),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        createDummyIdempotencyStore(),
      );

      const outcome = await service.listWorkspaceInvitations(
        dummySubject,
        dummyWorkspaceId,
        { limit: 50 },
      );
      expect(outcome.kind).toBe(WORKSPACE_INVITATION_LIST_OUTCOMES.FORBIDDEN);
    });

    it("row 3: returns forbidden when the caller's role is editor or viewer", async () => {
      for (const role of [WORKSPACE_ROLE.EDITOR, WORKSPACE_ROLE.VIEWER]) {
        const fakeStore = {
          readMembership: vi.fn().mockResolvedValue({
            role,
            status: WORKSPACE_MEMBER_STATUS.ACTIVE,
          }),
          listInvitations: vi.fn().mockResolvedValue([]),
        } as unknown as WorkspaceInvitationStore;
        const fakeTransaction: WorkspaceInvitationReadTransaction = {
          run: vi.fn(),
          runRead: vi.fn(async (_subject, callback) => callback(dummyClient)),
        };
        const service = new WorkspaceInvitationService(
          fakeTransaction,
          fakeStore,
          createDummyIdempotencyStore(),
        );

        const outcome = await service.listWorkspaceInvitations(
          dummySubject,
          dummyWorkspaceId,
          { limit: 50 },
        );
        expect(outcome.kind).toBe(WORKSPACE_INVITATION_LIST_OUTCOMES.FORBIDDEN);
      }
    });

    it('row 4: returns ok with invitation page for owner or administrator', async () => {
      for (const role of [WORKSPACE_ROLE.OWNER, WORKSPACE_ROLE.ADMINISTRATOR]) {
        const fakeStore = {
          readMembership: vi.fn().mockResolvedValue({
            role,
            status: WORKSPACE_MEMBER_STATUS.ACTIVE,
          }),
          listInvitations: vi
            .fn()
            .mockResolvedValue([fakeInvitation1, fakeInvitation2]),
        } as unknown as WorkspaceInvitationStore;
        const fakeTransaction: WorkspaceInvitationReadTransaction = {
          run: vi.fn(),
          runRead: vi.fn(async (_subject, callback) => callback(dummyClient)),
        };
        const service = new WorkspaceInvitationService(
          fakeTransaction,
          fakeStore,
          createDummyIdempotencyStore(),
        );

        const outcome = await service.listWorkspaceInvitations(
          dummySubject,
          dummyWorkspaceId,
          { limit: 50 },
        );
        expect(outcome.kind).toBe(WORKSPACE_INVITATION_LIST_OUTCOMES.OK);
        if (outcome.kind === WORKSPACE_INVITATION_LIST_OUTCOMES.OK) {
          expect(outcome.page.items).toEqual([
            fakeInvitation1,
            fakeInvitation2,
          ]);
          expect(outcome.page.pageInfo.hasNextPage).toBe(false);
          expect(outcome.page.pageInfo.nextCursor).toBeNull();
        }
      }
    });

    it('requests limit + 1 rows and sets nextCursor with pagination info', async () => {
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue({
          role: 'owner',
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        }),
        listInvitations: vi
          .fn()
          .mockResolvedValue([
            fakeInvitation1,
            fakeInvitation2,
            fakeInvitation3,
          ]),
      } as unknown as WorkspaceInvitationStore;
      const fakeTransaction: WorkspaceInvitationReadTransaction = {
        run: vi.fn(),
        runRead: vi.fn(async (_subject, callback) => callback(dummyClient)),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        createDummyIdempotencyStore(),
      );

      const outcome = await service.listWorkspaceInvitations(
        dummySubject,
        dummyWorkspaceId,
        { limit: 2 },
      );
      expect(fakeStore.listInvitations).toHaveBeenCalledWith(
        dummyClient,
        dummyWorkspaceId,
        undefined,
        3,
      );
      expect(outcome.kind).toBe(WORKSPACE_INVITATION_LIST_OUTCOMES.OK);
      if (outcome.kind === WORKSPACE_INVITATION_LIST_OUTCOMES.OK) {
        expect(outcome.page.items).toEqual([fakeInvitation1, fakeInvitation2]);
        expect(outcome.page.pageInfo.hasNextPage).toBe(true);
        expect(outcome.page.pageInfo.nextCursor).not.toBeNull();
      }
    });
  });

  describe('createWorkspaceInvitation (§3 Decision Table)', () => {
    const defaultCommand = {
      email: 'newbie@example.test',
      role: 'editor' as const,
    };
    const fingerprint = computeRequestFingerprint({
      workspaceId: dummyWorkspaceId,
      email: defaultCommand.email,
      role: defaultCommand.role,
    });

    it('row 1: replay with same key and same fingerprint replays stored response verbatim', async () => {
      const fakeIdempotencyStore = {
        read: vi.fn().mockResolvedValue({
          requestFingerprint: fingerprint,
          responseStatus: 201,
          responseEtag: null,
          responseBody: fakeInvitation1,
        }),
        write: vi.fn(),
      } as unknown as IdempotencyStore;
      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const fakeStore = {} as WorkspaceInvitationStore;
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        fakeIdempotencyStore,
      );

      const outcome = await service.createWorkspaceInvitation(
        dummySubject,
        dummyWorkspaceId,
        defaultCommand,
        '00000000-0000-0000-0000-000000000001',
      );
      expect(outcome.kind).toBe(WORKSPACE_INVITATION_CREATE_OUTCOMES.REPLAYED);
      if (outcome.kind === WORKSPACE_INVITATION_CREATE_OUTCOMES.REPLAYED) {
        expect(outcome.status).toBe(201);
        expect(outcome.body).toEqual(fakeInvitation1);
      }
    });

    it('row 2: replay with same key and different fingerprint returns idempotency conflict (409)', async () => {
      const fakeIdempotencyStore = {
        read: vi.fn().mockResolvedValue({
          requestFingerprint: 'different-fingerprint-sha',
          responseStatus: 201,
          responseEtag: null,
          responseBody: fakeInvitation1,
        }),
        write: vi.fn(),
      } as unknown as IdempotencyStore;
      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const fakeStore = {} as WorkspaceInvitationStore;
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        fakeIdempotencyStore,
      );

      const outcome = await service.createWorkspaceInvitation(
        dummySubject,
        dummyWorkspaceId,
        defaultCommand,
        '00000000-0000-0000-0000-000000000001',
      );
      expect(outcome.kind).toBe(
        WORKSPACE_INVITATION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
      );
    });

    it('row 4: caller has no membership in this workspace returns not-found (404)', async () => {
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue(undefined),
      } as unknown as WorkspaceInvitationStore;
      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        createDummyIdempotencyStore(),
      );

      const outcome = await service.createWorkspaceInvitation(
        dummySubject,
        dummyWorkspaceId,
        defaultCommand,
        '00000000-0000-0000-0000-000000000001',
      );
      expect(outcome.kind).toBe(WORKSPACE_INVITATION_CREATE_OUTCOMES.NOT_FOUND);
    });

    it("row 5: caller's membership is suspended returns forbidden (403)", async () => {
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue({
          role: 'owner',
          status: WORKSPACE_MEMBER_STATUS.SUSPENDED,
        }),
      } as unknown as WorkspaceInvitationStore;
      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        createDummyIdempotencyStore(),
      );

      const outcome = await service.createWorkspaceInvitation(
        dummySubject,
        dummyWorkspaceId,
        defaultCommand,
        '00000000-0000-0000-0000-000000000001',
      );
      expect(outcome.kind).toBe(WORKSPACE_INVITATION_CREATE_OUTCOMES.FORBIDDEN);
    });

    it("row 6: caller's role is editor or viewer returns forbidden (403)", async () => {
      for (const role of [WORKSPACE_ROLE.EDITOR, WORKSPACE_ROLE.VIEWER]) {
        const fakeStore = {
          readMembership: vi.fn().mockResolvedValue({
            role,
            status: WORKSPACE_MEMBER_STATUS.ACTIVE,
          }),
        } as unknown as WorkspaceInvitationStore;
        const fakeTransaction: WorkspaceInvitationTransaction = {
          run: vi.fn(async (_subject, callback) => callback(dummyClient)),
          runRead: vi.fn(),
        };
        const service = new WorkspaceInvitationService(
          fakeTransaction,
          fakeStore,
          createDummyIdempotencyStore(),
        );

        const outcome = await service.createWorkspaceInvitation(
          dummySubject,
          dummyWorkspaceId,
          defaultCommand,
          '00000000-0000-0000-0000-000000000001',
        );
        expect(outcome.kind).toBe(
          WORKSPACE_INVITATION_CREATE_OUTCOMES.FORBIDDEN,
        );
      }
    });

    it('row 7: workspace kind is personal returns personal-workspace (422)', async () => {
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue({
          role: 'owner',
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        }),
        readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.PERSONAL),
      } as unknown as WorkspaceInvitationStore;
      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        createDummyIdempotencyStore(),
      );

      const outcome = await service.createWorkspaceInvitation(
        dummySubject,
        dummyWorkspaceId,
        defaultCommand,
        '00000000-0000-0000-0000-000000000001',
      );
      expect(outcome.kind).toBe(
        WORKSPACE_INVITATION_CREATE_OUTCOMES.PERSONAL_WORKSPACE,
      );
    });

    it('row 8: caller is administrator and requested role is owner returns forbidden (403)', async () => {
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue({
          role: WORKSPACE_ROLE.ADMINISTRATOR,
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        }),
        readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.FAMILY),
      } as unknown as WorkspaceInvitationStore;
      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        createDummyIdempotencyStore(),
      );

      const outcome = await service.createWorkspaceInvitation(
        dummySubject,
        dummyWorkspaceId,
        { email: 'newowner@example.test', role: 'owner' },
        '00000000-0000-0000-0000-000000000001',
      );
      expect(outcome.kind).toBe(WORKSPACE_INVITATION_CREATE_OUTCOMES.FORBIDDEN);
    });

    it('positive control for RULING 23: caller is owner and requested role is owner succeeds (201)', async () => {
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue({
          role: WORKSPACE_ROLE.OWNER,
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        }),
        readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.FAMILY),
        hasActiveMember: vi.fn().mockResolvedValue(false),
        findPendingInvitation: vi.fn().mockResolvedValue(undefined),
        createInvitation: vi.fn().mockResolvedValue({
          ...fakeInvitation1,
          role: 'owner',
        }),
      } as unknown as WorkspaceInvitationStore;
      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        createDummyIdempotencyStore(),
      );

      const outcome = await service.createWorkspaceInvitation(
        dummySubject,
        dummyWorkspaceId,
        { email: 'co-owner@example.test', role: 'owner' },
        '00000000-0000-0000-0000-000000000001',
      );
      expect(outcome.kind).toBe(WORKSPACE_INVITATION_CREATE_OUTCOMES.CREATED);
      if (outcome.kind === WORKSPACE_INVITATION_CREATE_OUTCOMES.CREATED) {
        expect(outcome.invitation.role).toBe('owner');
      }
    });

    it('row 9: email already belongs to an active member returns existing-member (409)', async () => {
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue({
          role: 'owner',
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        }),
        readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.FAMILY),
        hasActiveMember: vi.fn().mockResolvedValue(true),
      } as unknown as WorkspaceInvitationStore;
      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        createDummyIdempotencyStore(),
      );

      const outcome = await service.createWorkspaceInvitation(
        dummySubject,
        dummyWorkspaceId,
        defaultCommand,
        '00000000-0000-0000-0000-000000000001',
      );
      expect(outcome.kind).toBe(
        WORKSPACE_INVITATION_CREATE_OUTCOMES.EXISTING_MEMBER,
      );
    });

    it('row 10: unexpired pending invitation exists returns already-pending (409)', async () => {
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue({
          role: 'owner',
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        }),
        readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.FAMILY),
        hasActiveMember: vi.fn().mockResolvedValue(false),
        findPendingInvitation: vi.fn().mockResolvedValue({
          id: '11111111-1111-1111-1111-111111111111',
          isExpired: false,
        }),
      } as unknown as WorkspaceInvitationStore;
      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        createDummyIdempotencyStore(),
      );

      const outcome = await service.createWorkspaceInvitation(
        dummySubject,
        dummyWorkspaceId,
        defaultCommand,
        '00000000-0000-0000-0000-000000000001',
      );
      expect(outcome.kind).toBe(
        WORKSPACE_INVITATION_CREATE_OUTCOMES.ALREADY_PENDING,
      );
    });

    it('row 11: expired pending invitation exists is revoked and replaced with new invitation (201)', async () => {
      const pendingId = '11111111-1111-1111-1111-111111111111';
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue({
          role: 'owner',
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        }),
        readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.FAMILY),
        hasActiveMember: vi.fn().mockResolvedValue(false),
        findPendingInvitation: vi.fn().mockResolvedValue({
          id: pendingId,
          isExpired: true,
        }),
        revokeInvitation: vi.fn().mockResolvedValue(undefined),
        createInvitation: vi.fn().mockResolvedValue(fakeInvitation1),
      } as unknown as WorkspaceInvitationStore;
      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        createDummyIdempotencyStore(),
      );

      const outcome = await service.createWorkspaceInvitation(
        dummySubject,
        dummyWorkspaceId,
        defaultCommand,
        '00000000-0000-0000-0000-000000000001',
      );
      expect(fakeStore.revokeInvitation).toHaveBeenCalledWith(
        dummyClient,
        pendingId,
      );
      expect(fakeStore.createInvitation).toHaveBeenCalledWith(
        dummyClient,
        dummyWorkspaceId,
        dummySubject,
        defaultCommand.email,
        defaultCommand.role,
      );
      expect(outcome.kind).toBe(WORKSPACE_INVITATION_CREATE_OUTCOMES.CREATED);
      if (outcome.kind === WORKSPACE_INVITATION_CREATE_OUTCOMES.CREATED) {
        expect(outcome.invitation).toEqual(fakeInvitation1);
      }
    });

    it('row 12: insert succeeds returns created (201) with invitation body', async () => {
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue({
          role: 'owner',
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        }),
        readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.FAMILY),
        hasActiveMember: vi.fn().mockResolvedValue(false),
        findPendingInvitation: vi.fn().mockResolvedValue(undefined),
        createInvitation: vi.fn().mockResolvedValue(fakeInvitation1),
      } as unknown as WorkspaceInvitationStore;
      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        createDummyIdempotencyStore(),
      );

      const outcome = await service.createWorkspaceInvitation(
        dummySubject,
        dummyWorkspaceId,
        defaultCommand,
        '00000000-0000-0000-0000-000000000001',
      );
      expect(outcome.kind).toBe(WORKSPACE_INVITATION_CREATE_OUTCOMES.CREATED);
      if (outcome.kind === WORKSPACE_INVITATION_CREATE_OUTCOMES.CREATED) {
        expect(outcome.invitation).toEqual(fakeInvitation1);
      }
    });

    it('SQLSTATE 42501: order-sensitive catch re-reads kind first (call 2) and caller membership last (call 2)', async () => {
      let kindReadCount = 0;
      let callerReadCount = 0;

      const fakeStore = {
        readMembership: vi.fn().mockImplementation(async () => {
          callerReadCount++;
          if (callerReadCount === 1) {
            // Initial check: active owner
            return {
              role: WORKSPACE_ROLE.OWNER,
              status: WORKSPACE_MEMBER_STATUS.ACTIVE,
            };
          }
          // Residual diagnosis in 42501 catch:
          // If kind was already re-read in catch (kindReadCount >= 2), caller is now suspended -> FORBIDDEN (403)
          // If caller was re-read before kind (swapped bug), kindReadCount is still 1 -> returns active owner -> NOT_FOUND (404)
          if (kindReadCount >= 2) {
            return {
              role: WORKSPACE_ROLE.OWNER,
              status: WORKSPACE_MEMBER_STATUS.SUSPENDED,
            };
          }
          return {
            role: WORKSPACE_ROLE.OWNER,
            status: WORKSPACE_MEMBER_STATUS.ACTIVE,
          };
        }),
        readWorkspaceKind: vi.fn().mockImplementation(async () => {
          kindReadCount++;
          if (kindReadCount === 1) {
            return WORKSPACE_KIND.FAMILY;
          }
          // Call 2 (in catch): workspace is deleted/absent
          return undefined;
        }),
        hasActiveMember: vi.fn().mockResolvedValue(false),
        findPendingInvitation: vi.fn().mockResolvedValue(undefined),
        createInvitation: vi.fn().mockRejectedValue(
          Object.assign(new Error('insufficient privilege'), {
            code: '42501',
          }),
        ),
      } as unknown as WorkspaceInvitationStore;

      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        createDummyIdempotencyStore(),
      );

      const outcome = await service.createWorkspaceInvitation(
        dummySubject,
        dummyWorkspaceId,
        defaultCommand,
        '00000000-0000-0000-0000-000000000001',
      );
      expect(outcome.kind).toBe(WORKSPACE_INVITATION_CREATE_OUTCOMES.FORBIDDEN);
    });

    it('SQLSTATE 42501: maps to personal-workspace (422) when caller is active owner but workspace kind is personal', async () => {
      let kindReadCount = 0;
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue({
          role: WORKSPACE_ROLE.OWNER,
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        }),
        readWorkspaceKind: vi.fn().mockImplementation(async () => {
          kindReadCount++;
          if (kindReadCount === 1) {
            return WORKSPACE_KIND.FAMILY;
          }
          return WORKSPACE_KIND.PERSONAL;
        }),
        hasActiveMember: vi.fn().mockResolvedValue(false),
        findPendingInvitation: vi.fn().mockResolvedValue(undefined),
        createInvitation: vi.fn().mockRejectedValue(
          Object.assign(new Error('insufficient privilege'), {
            code: '42501',
          }),
        ),
      } as unknown as WorkspaceInvitationStore;

      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        createDummyIdempotencyStore(),
      );

      const outcome = await service.createWorkspaceInvitation(
        dummySubject,
        dummyWorkspaceId,
        defaultCommand,
        '00000000-0000-0000-0000-000000000001',
      );
      expect(outcome.kind).toBe(
        WORKSPACE_INVITATION_CREATE_OUTCOMES.PERSONAL_WORKSPACE,
      );
    });

    it('SQLSTATE 42501: maps to not-found (404) when caller remains active owner but workspace is absent', async () => {
      let kindReadCount = 0;
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue({
          role: WORKSPACE_ROLE.OWNER,
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        }),
        readWorkspaceKind: vi.fn().mockImplementation(async () => {
          kindReadCount++;
          if (kindReadCount === 1) {
            return WORKSPACE_KIND.FAMILY;
          }
          return undefined;
        }),
        hasActiveMember: vi.fn().mockResolvedValue(false),
        findPendingInvitation: vi.fn().mockResolvedValue(undefined),
        createInvitation: vi.fn().mockRejectedValue(
          Object.assign(new Error('insufficient privilege'), {
            code: '42501',
          }),
        ),
      } as unknown as WorkspaceInvitationStore;

      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        createDummyIdempotencyStore(),
      );

      const outcome = await service.createWorkspaceInvitation(
        dummySubject,
        dummyWorkspaceId,
        defaultCommand,
        '00000000-0000-0000-0000-000000000001',
      );
      expect(outcome.kind).toBe(WORKSPACE_INVITATION_CREATE_OUTCOMES.NOT_FOUND);
    });

    it('SQLSTATE 23503: workspace deleted mid-flight maps to not-found (404)', async () => {
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue({
          role: WORKSPACE_ROLE.OWNER,
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        }),
        readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.FAMILY),
        hasActiveMember: vi.fn().mockResolvedValue(false),
        findPendingInvitation: vi.fn().mockResolvedValue(undefined),
        createInvitation: vi.fn().mockRejectedValue(
          Object.assign(new Error('foreign key violation'), {
            code: '23503',
          }),
        ),
      } as unknown as WorkspaceInvitationStore;

      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        createDummyIdempotencyStore(),
      );

      const outcome = await service.createWorkspaceInvitation(
        dummySubject,
        dummyWorkspaceId,
        defaultCommand,
        '00000000-0000-0000-0000-000000000001',
      );
      expect(outcome.kind).toBe(WORKSPACE_INVITATION_CREATE_OUTCOMES.NOT_FOUND);
    });

    it('B3: idempotency lost-write path where write resolves false re-reads and replays (201)', async () => {
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue({
          role: WORKSPACE_ROLE.OWNER,
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        }),
        readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.FAMILY),
        hasActiveMember: vi.fn().mockResolvedValue(false),
        findPendingInvitation: vi.fn().mockResolvedValue(undefined),
        createInvitation: vi.fn().mockResolvedValue(fakeInvitation1),
      } as unknown as WorkspaceInvitationStore;

      const fakeIdempotencyStore = {
        read: vi
          .fn()
          .mockResolvedValueOnce(undefined) // Initial read: no record
          .mockResolvedValueOnce({
            // Lost-write recovery read
            requestFingerprint: fingerprint,
            responseStatus: 201,
            responseEtag: null,
            responseBody: fakeInvitation1,
          }),
        write: vi.fn().mockResolvedValue(false), // Lost-write: race resolved false
      };

      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        fakeIdempotencyStore,
      );

      const outcome = await service.createWorkspaceInvitation(
        dummySubject,
        dummyWorkspaceId,
        defaultCommand,
        '00000000-0000-0000-0000-000000000001',
      );
      expect(outcome.kind).toBe(WORKSPACE_INVITATION_CREATE_OUTCOMES.REPLAYED);
      if (outcome.kind === WORKSPACE_INVITATION_CREATE_OUTCOMES.REPLAYED) {
        expect(outcome.status).toBe(201);
        expect(outcome.body).toEqual(fakeInvitation1);
      }
    });

    it('B3: idempotency lost-write path where write resolves false and re-read reveals different fingerprint returns conflict (409)', async () => {
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue({
          role: WORKSPACE_ROLE.OWNER,
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        }),
        readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.FAMILY),
        hasActiveMember: vi.fn().mockResolvedValue(false),
        findPendingInvitation: vi.fn().mockResolvedValue(undefined),
        createInvitation: vi.fn().mockResolvedValue(fakeInvitation1),
      } as unknown as WorkspaceInvitationStore;

      const fakeIdempotencyStore = {
        read: vi
          .fn()
          .mockResolvedValueOnce(undefined) // Initial read: no record
          .mockResolvedValueOnce({
            // Lost-write recovery read with mismatched fingerprint
            requestFingerprint: 'different-fingerprint-mismatch',
            status: 201,
            etag: null,
            body: fakeInvitation1,
          }),
        write: vi.fn().mockResolvedValue(false), // Lost-write: race resolved false
      };

      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        fakeIdempotencyStore,
      );

      const outcome = await service.createWorkspaceInvitation(
        dummySubject,
        dummyWorkspaceId,
        defaultCommand,
        '00000000-0000-0000-0000-000000000001',
      );
      expect(outcome.kind).toBe(
        WORKSPACE_INVITATION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
      );
    });

    it('RULING 27: unique violation 23505 with constraint workspace_invitations_one_pending_per_email is caught and mapped to already-pending (409)', async () => {
      const pgUniqueError = Object.assign(
        new Error('duplicate key value violates unique constraint'),
        {
          code: '23505',
          constraint: 'workspace_invitations_one_pending_per_email',
        },
      );
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue({
          role: 'owner',
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        }),
        readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.FAMILY),
        hasActiveMember: vi.fn().mockResolvedValue(false),
        findPendingInvitation: vi.fn().mockResolvedValue(undefined),
        createInvitation: vi.fn().mockRejectedValue(pgUniqueError),
      } as unknown as WorkspaceInvitationStore;

      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        createDummyIdempotencyStore(),
      );

      const outcome = await service.createWorkspaceInvitation(
        dummySubject,
        dummyWorkspaceId,
        defaultCommand,
        '00000000-0000-0000-0000-000000000001',
      );
      expect(outcome.kind).toBe(
        WORKSPACE_INVITATION_CREATE_OUTCOMES.ALREADY_PENDING,
      );
    });

    it('RULING 27: unique violation 23505 with a DIFFERENT constraint is not caught and rethrows', async () => {
      const pgOtherUniqueError = Object.assign(
        new Error('duplicate key value violates unique constraint'),
        {
          code: '23505',
          constraint: 'workspace_invitations_pkey',
        },
      );
      const fakeStore = {
        readMembership: vi.fn().mockResolvedValue({
          role: 'owner',
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        }),
        readWorkspaceKind: vi.fn().mockResolvedValue(WORKSPACE_KIND.FAMILY),
        hasActiveMember: vi.fn().mockResolvedValue(false),
        findPendingInvitation: vi.fn().mockResolvedValue(undefined),
        createInvitation: vi.fn().mockRejectedValue(pgOtherUniqueError),
      } as unknown as WorkspaceInvitationStore;

      const fakeTransaction: WorkspaceInvitationTransaction = {
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
        runRead: vi.fn(),
      };
      const service = new WorkspaceInvitationService(
        fakeTransaction,
        fakeStore,
        createDummyIdempotencyStore(),
      );

      await expect(
        service.createWorkspaceInvitation(
          dummySubject,
          dummyWorkspaceId,
          defaultCommand,
          '00000000-0000-0000-0000-000000000001',
        ),
      ).rejects.toThrow(pgOtherUniqueError);
    });
  });
});
