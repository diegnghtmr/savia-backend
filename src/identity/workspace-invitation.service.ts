import type { IdempotencyStore } from './idempotency.port.js';
import { computeRequestFingerprint } from './idempotency.service.js';
import type { TransactionClient } from './pg-transaction.js';
import { PROBLEM_TYPES } from './problem-details.js';
import type { CreateWorkspaceInvitationCommand } from './workspace-invitation-command.js';
import {
  WORKSPACE_INVITATION_CREATE_OUTCOMES,
  WORKSPACE_INVITATION_LIST_OUTCOMES,
  type WorkspaceInvitation,
  type WorkspaceInvitationCreateOutcome,
  type WorkspaceInvitationListOutcome,
  type WorkspaceInvitationListQuery,
  type WorkspaceInvitationPort,
} from './workspace-invitation.port.js';
import {
  encodeCursor,
  WORKSPACE_KIND,
  WORKSPACE_MEMBER_STATUS,
  WORKSPACE_ROLE,
  type WorkspaceCursor,
  type WorkspaceKind,
  type WorkspaceRole,
} from './workspace.port.js';
import type { WorkspaceMembershipRecord } from './workspace.service.js';

export interface WorkspaceInvitationTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export type WorkspaceInvitationReadTransaction = WorkspaceInvitationTransaction;

export interface WorkspaceInvitationStore {
  readMembership(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
  ): Promise<WorkspaceMembershipRecord | undefined>;
  listInvitations(
    client: TransactionClient,
    workspaceId: string,
    cursor: WorkspaceCursor | undefined,
    limit: number,
  ): Promise<readonly WorkspaceInvitation[]>;
  readWorkspaceKind(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<WorkspaceKind | undefined>;
  hasActiveMember(
    client: TransactionClient,
    workspaceId: string,
    email: string,
  ): Promise<boolean>;
  findPendingInvitation(
    client: TransactionClient,
    workspaceId: string,
    email: string,
  ): Promise<{ id: string; isExpired: boolean } | undefined>;
  revokeInvitation(
    client: TransactionClient,
    invitationId: string,
  ): Promise<void>;
  createInvitation(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    email: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceInvitation>;
}

export class WorkspaceInvitationService implements WorkspaceInvitationPort {
  public constructor(
    private readonly transaction: WorkspaceInvitationTransaction,
    private readonly store: WorkspaceInvitationStore,
    private readonly idempotencyStore: IdempotencyStore,
  ) {}

  public listWorkspaceInvitations(
    subject: string,
    workspaceId: string,
    query: WorkspaceInvitationListQuery,
  ): Promise<WorkspaceInvitationListOutcome> {
    return this.transaction.runRead(subject, async (client) => {
      // RULING 26: Visibility Rule
      // #1 caller has no membership -> 404
      // #2 caller membership is suspended -> 403
      // #3 caller role is editor or viewer -> 403
      // #4 owner or administrator -> 200 page
      const membership = await this.store.readMembership(
        client,
        workspaceId,
        subject,
      );
      if (membership === undefined) {
        return { kind: WORKSPACE_INVITATION_LIST_OUTCOMES.NOT_FOUND };
      }
      if (membership.status === WORKSPACE_MEMBER_STATUS.SUSPENDED) {
        return { kind: WORKSPACE_INVITATION_LIST_OUTCOMES.FORBIDDEN };
      }
      if (
        membership.role === WORKSPACE_ROLE.EDITOR ||
        membership.role === WORKSPACE_ROLE.VIEWER
      ) {
        return { kind: WORKSPACE_INVITATION_LIST_OUTCOMES.FORBIDDEN };
      }

      const rows = await this.store.listInvitations(
        client,
        workspaceId,
        query.cursor,
        query.limit + 1,
      );
      const hasNextPage = rows.length > query.limit;
      const items = hasNextPage ? rows.slice(0, query.limit) : rows;
      const lastItem = items[items.length - 1];
      const nextCursor =
        hasNextPage && lastItem !== undefined
          ? encodeCursor({
              createdAt: lastItem.createdAt,
              id: lastItem.id,
            })
          : null;

      return {
        kind: WORKSPACE_INVITATION_LIST_OUTCOMES.OK,
        page: { items, pageInfo: { hasNextPage, nextCursor } },
      };
    });
  }

  public createWorkspaceInvitation(
    subject: string,
    workspaceId: string,
    command: CreateWorkspaceInvitationCommand,
    idempotencyKey: string,
  ): Promise<WorkspaceInvitationCreateOutcome> {
    const route = 'POST /v1/workspaces/{workspaceId}/invitations';
    const fingerprint = computeRequestFingerprint({
      workspaceId,
      email: command.email,
      role: command.role,
    });

    return this.transaction.run(subject, async (client) => {
      // Rows 1, 2: Idempotency preamble
      const existing = await this.idempotencyStore.read(
        client,
        subject,
        route,
        idempotencyKey,
      );
      if (existing !== undefined) {
        if (existing.requestFingerprint !== fingerprint) {
          return {
            kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
          };
        }
        return {
          kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.REPLAYED,
          status: existing.responseStatus,
          body: existing.responseBody,
        };
      }

      const persistAndReturn = async (
        status: number,
        body: unknown,
        outcome: WorkspaceInvitationCreateOutcome,
      ): Promise<WorkspaceInvitationCreateOutcome> => {
        const written = await this.idempotencyStore.write(
          client,
          subject,
          route,
          idempotencyKey,
          fingerprint,
          status,
          null,
          body,
        );
        if (!written) {
          const reread = await this.idempotencyStore.read(
            client,
            subject,
            route,
            idempotencyKey,
          );
          if (reread !== undefined) {
            if (reread.requestFingerprint !== fingerprint) {
              return {
                kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
              };
            }
            return {
              kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.REPLAYED,
              status: reread.responseStatus,
              body: reread.responseBody,
            };
          }
        }
        return outcome;
      };

      // Rows 4, 5, 6: Caller's own membership row
      const callerMembership = await this.store.readMembership(
        client,
        workspaceId,
        subject,
      );
      if (callerMembership === undefined) {
        return persistAndReturn(
          404,
          {
            type: PROBLEM_TYPES.NOT_FOUND,
            title: 'Workspace not found',
            status: 404,
          },
          { kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.NOT_FOUND },
        );
      }
      if (callerMembership.status === WORKSPACE_MEMBER_STATUS.SUSPENDED) {
        return persistAndReturn(
          403,
          {
            type: PROBLEM_TYPES.FORBIDDEN,
            title: 'Workspace access forbidden',
            status: 403,
          },
          { kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.FORBIDDEN },
        );
      }
      if (
        callerMembership.role !== WORKSPACE_ROLE.OWNER &&
        callerMembership.role !== WORKSPACE_ROLE.ADMINISTRATOR
      ) {
        return persistAndReturn(
          403,
          {
            type: PROBLEM_TYPES.FORBIDDEN,
            title: 'Workspace access forbidden',
            status: 403,
          },
          { kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.FORBIDDEN },
        );
      }

      // Row 7: Workspace kind is personal (422)
      const kind = await this.store.readWorkspaceKind(client, workspaceId);
      if (kind === WORKSPACE_KIND.PERSONAL) {
        return persistAndReturn(
          422,
          {
            type: PROBLEM_TYPES.UNPROCESSABLE,
            title: 'Personal workspace cannot have invitations',
            status: 422,
          },
          { kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.PERSONAL_WORKSPACE },
        );
      }

      // Row 8: Caller is administrator and requested role is owner (403)
      if (
        callerMembership.role === WORKSPACE_ROLE.ADMINISTRATOR &&
        command.role === WORKSPACE_ROLE.OWNER
      ) {
        return persistAndReturn(
          403,
          {
            type: PROBLEM_TYPES.FORBIDDEN,
            title: 'Administrators cannot invite owners',
            status: 403,
          },
          { kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.FORBIDDEN },
        );
      }

      // Row 9: Email already belongs to an active member (409)
      const hasActive = await this.store.hasActiveMember(
        client,
        workspaceId,
        command.email,
      );
      if (hasActive) {
        return persistAndReturn(
          409,
          {
            type: PROBLEM_TYPES.WORKSPACE_INVITATION_EXISTING_MEMBER,
            title: 'Workspace member already active with this email',
            status: 409,
          },
          { kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.EXISTING_MEMBER },
        );
      }

      // Rows 10, 11: Check pending invitation
      const pending = await this.store.findPendingInvitation(
        client,
        workspaceId,
        command.email,
      );
      if (pending !== undefined) {
        if (!pending.isExpired) {
          // Row 10: unexpired pending invitation exists (409)
          return persistAndReturn(
            409,
            {
              type: PROBLEM_TYPES.WORKSPACE_INVITATION_ALREADY_PENDING,
              title: 'Pending invitation already exists for this email',
              status: 409,
            },
            { kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.ALREADY_PENDING },
          );
        }
        // Row 11: expired pending invitation -> revoke it, then continue to insert
        await this.store.revokeInvitation(client, pending.id);
      }

      // Row 12: Insert fresh invitation (with failure classification)
      let invitation: WorkspaceInvitation;
      try {
        invitation = await this.store.createInvitation(
          client,
          workspaceId,
          subject,
          command.email,
          command.role,
        );
      } catch (error: unknown) {
        if (isPendingEmailUniqueViolation(error)) {
          return persistAndReturn(
            409,
            {
              type: PROBLEM_TYPES.WORKSPACE_INVITATION_ALREADY_PENDING,
              title: 'Pending invitation already exists for this email',
              status: 409,
            },
            { kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.ALREADY_PENDING },
          );
        }

        const sqlState = getSqlStateCode(error);

        if (sqlState === '42501') {
          // 1. Re-read the workspace kind first
          const residualKind = await this.store.readWorkspaceKind(
            client,
            workspaceId,
          );

          // 2. Re-read the caller's own membership LAST
          const residualCaller = await this.store.readMembership(
            client,
            workspaceId,
            subject,
          );

          // 3. Caller is no longer an active owner or administrator -> 403
          if (
            residualCaller === undefined ||
            residualCaller.status === WORKSPACE_MEMBER_STATUS.SUSPENDED ||
            (residualCaller.role !== WORKSPACE_ROLE.OWNER &&
              residualCaller.role !== WORKSPACE_ROLE.ADMINISTRATOR)
          ) {
            return persistAndReturn(
              403,
              {
                type: PROBLEM_TYPES.FORBIDDEN,
                title: 'Workspace access forbidden',
                status: 403,
              },
              { kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.FORBIDDEN },
            );
          }

          // 4. Else kind is personal -> 422
          if (residualKind === WORKSPACE_KIND.PERSONAL) {
            return persistAndReturn(
              422,
              {
                type: PROBLEM_TYPES.UNPROCESSABLE,
                title: 'Personal workspaces cannot have invitations',
                status: 422,
              },
              { kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.PERSONAL_WORKSPACE },
            );
          }

          // 5. Else workspace absent -> 404
          if (residualKind === undefined) {
            return persistAndReturn(
              404,
              {
                type: PROBLEM_TYPES.NOT_FOUND,
                title: 'Workspace not found',
                status: 404,
              },
              { kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.NOT_FOUND },
            );
          }

          // 6. Else -> 403
          return persistAndReturn(
            403,
            {
              type: PROBLEM_TYPES.FORBIDDEN,
              title: 'Workspace access forbidden',
              status: 403,
            },
            { kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.FORBIDDEN },
          );
        }

        if (sqlState === '23503') {
          // Workspace was deleted mid-flight -> 404
          return persistAndReturn(
            404,
            {
              type: PROBLEM_TYPES.NOT_FOUND,
              title: 'Workspace not found',
              status: 404,
            },
            { kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.NOT_FOUND },
          );
        }

        throw error;
      }

      return persistAndReturn(201, invitation, {
        kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.CREATED,
        invitation,
      });
    });
  }
}

export function isPendingEmailUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as { code?: unknown; constraint?: unknown };
  return (
    String(err.code) === '23505' &&
    err.constraint === 'workspace_invitations_one_pending_per_email'
  );
}

function getSqlStateCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
