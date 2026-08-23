import type { TransactionClient } from './pg-transaction.js';
import type { WorkspaceMemberUpdateCommand } from './workspace-member-command.js';
import {
  encodeMemberCursor,
  WORKSPACE_MEMBER_LIST_OUTCOMES,
  WORKSPACE_MEMBER_UPDATE_OUTCOMES,
  type WorkspaceMember,
  type WorkspaceMemberCursor,
  type WorkspaceMemberListOutcome,
  type WorkspaceMemberListQuery,
  type WorkspaceMemberPort,
  type WorkspaceMemberUpdateOutcome,
} from './workspace-member.port.js';
import {
  WORKSPACE_KIND,
  WORKSPACE_MEMBER_STATUS,
  WORKSPACE_ROLE,
  type WorkspaceKind,
  type WorkspaceMemberStatus,
  type WorkspaceRole,
} from './workspace.port.js';
import type { WorkspaceMembershipRecord } from './workspace.service.js';

export interface WorkspaceMemberTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export type WorkspaceMemberReadTransaction = WorkspaceMemberTransaction;

export interface WorkspaceMembershipDetailRecord {
  readonly id: string;
  readonly profileId: string;
  readonly role: WorkspaceRole;
  readonly status: WorkspaceMemberStatus;
  readonly version: number;
}

export interface WorkspaceMemberStore {
  readMembership(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
  ): Promise<WorkspaceMembershipRecord | undefined>;
  listRoster(
    client: TransactionClient,
    workspaceId: string,
    cursor: WorkspaceMemberCursor | undefined,
    limit: number,
  ): Promise<readonly WorkspaceMember[]>;
  readWorkspaceKind(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<WorkspaceKind | undefined>;
  readMembershipById(
    client: TransactionClient,
    workspaceId: string,
    memberId: string,
  ): Promise<WorkspaceMembershipDetailRecord | undefined>;
  retainsActiveOwner(
    client: TransactionClient,
    workspaceId: string,
    excludedMembershipId: string,
  ): Promise<boolean>;
  updateMemberRole(
    client: TransactionClient,
    workspaceId: string,
    memberId: string,
    role: WorkspaceRole,
    expectedVersion?: number | readonly number[],
  ): Promise<{ rowCount: number; version?: number }>;
  enforceDeferredConstraints(client: TransactionClient): Promise<void>;
  readRosterMember(
    client: TransactionClient,
    workspaceId: string,
    memberId: string,
  ): Promise<WorkspaceMember | undefined>;
}

export class WorkspaceMemberService implements WorkspaceMemberPort {
  public constructor(
    private readonly transaction: WorkspaceMemberTransaction,
    private readonly store: WorkspaceMemberStore,
  ) {}

  // runRead, NOT run. listWorkspaceMembers is a read path: it ends in ROLLBACK, has no
  // commit-uncertainty branch, and therefore declares 500 and never 503 in the contract.
  // The Visibility Rule is decided HERE, not by the projection returning zero rows, because
  // the spec distinguishes 403 from 404: readMembership reads the caller's own row, always
  // visible under the unchanged application_reads_own_membership (202607150002:38-44).
  public listWorkspaceMembers(
    subject: string,
    workspaceId: string,
    query: WorkspaceMemberListQuery,
  ): Promise<WorkspaceMemberListOutcome> {
    return this.transaction.runRead(subject, async (client) => {
      const membership = await this.store.readMembership(
        client,
        workspaceId,
        subject,
      );
      if (membership === undefined) {
        return { kind: WORKSPACE_MEMBER_LIST_OUTCOMES.NOT_FOUND };
      }
      if (membership.status === WORKSPACE_MEMBER_STATUS.SUSPENDED) {
        return { kind: WORKSPACE_MEMBER_LIST_OUTCOMES.FORBIDDEN };
      }

      const rows = await this.store.listRoster(
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
          ? encodeMemberCursor({
              workspaceId,
              joinedAt: lastItem.joinedAt,
              membershipId: lastItem.id,
            })
          : null;
      return {
        kind: WORKSPACE_MEMBER_LIST_OUTCOMES.OK,
        page: { items, pageInfo: { hasNextPage, nextCursor } },
      };
    });
  }

  // run, NOT runRead. updateWorkspaceMember is a write path: it mutates membership role,
  // increments version, and can raise CommitOutcomeUnknownError at commit time, which
  // maps to 503 outcome-unknown with Retry-After in the problem filter. Therefore, the contract
  // declares 500 and 503.
  public updateWorkspaceMember(
    subject: string,
    workspaceId: string,
    memberId: string,
    command: WorkspaceMemberUpdateCommand,
    expectedVersion?: number | readonly number[],
  ): Promise<WorkspaceMemberUpdateOutcome> {
    return this.transaction.run(subject, async (client) => {
      // Steps 4, 5, 6: Caller's own membership row
      const callerMembership = await this.store.readMembership(
        client,
        workspaceId,
        subject,
      );
      if (callerMembership === undefined) {
        return { kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.NOT_FOUND };
      }
      if (callerMembership.status === WORKSPACE_MEMBER_STATUS.SUSPENDED) {
        return { kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.FORBIDDEN };
      }
      if (
        callerMembership.role !== WORKSPACE_ROLE.OWNER &&
        callerMembership.role !== WORKSPACE_ROLE.ADMINISTRATOR
      ) {
        return { kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.FORBIDDEN };
      }

      // Step 7: Workspace kind is personal (must precede steps 8 and 12)
      const kind = await this.store.readWorkspaceKind(client, workspaceId);
      if (kind === WORKSPACE_KIND.PERSONAL) {
        return { kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.PERSONAL_WORKSPACE };
      }

      // Step 8: Target membership row in this workspace
      const targetMembership = await this.store.readMembershipById(
        client,
        workspaceId,
        memberId,
      );
      if (targetMembership === undefined) {
        return { kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.NOT_FOUND };
      }

      // Step 9: Target's CURRENT role is owner and caller's role is administrator (RULING 7)
      if (
        targetMembership.role === WORKSPACE_ROLE.OWNER &&
        callerMembership.role === WORKSPACE_ROLE.ADMINISTRATOR
      ) {
        return { kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.FORBIDDEN };
      }

      // Step 10: REQUESTED role is owner and caller's role is administrator (RULING 7)
      if (
        command.role === WORKSPACE_ROLE.OWNER &&
        callerMembership.role === WORKSPACE_ROLE.ADMINISTRATOR
      ) {
        return { kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.FORBIDDEN };
      }

      // Step 11: If-Match is versions and target's current version is in none of them
      if (expectedVersion !== undefined) {
        const versions = Array.isArray(expectedVersion)
          ? expectedVersion
          : [expectedVersion];
        if (!versions.includes(targetMembership.version)) {
          return { kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.VERSION_CONFLICT };
        }
      }

      // Step 12: Target's current role is owner, requested role is NOT owner, and no other active owner would remain
      if (
        targetMembership.role === WORKSPACE_ROLE.OWNER &&
        command.role !== WORKSPACE_ROLE.OWNER
      ) {
        const retains = await this.store.retainsActiveOwner(
          client,
          workspaceId,
          memberId,
        );
        if (!retains) {
          return {
            kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.LAST_OWNER_REQUIRED,
          };
        }
      }

      // Perform UPDATE
      // The SQL predicate ($4::integer[] is null or version = any($4::integer[])),
      // not the step-11 pre-check, is the load-bearing guard against concurrent lost updates.
      const updateResult = await this.store.updateMemberRole(
        client,
        workspaceId,
        memberId,
        command.role,
        expectedVersion,
      );

      if (updateResult.rowCount === 0) {
        // Residual zero-row UPDATE:
        // A concurrent transaction could have demoted/suspended the caller (losing authority under RLS),
        // or deleted/modified the target member row (failing the version predicate or id match).
        // 1. Re-read the caller's own membership first (always visible under application_reads_own_membership).
        // If the caller is no longer an active owner or administrator, answer FORBIDDEN (403).
        const callerResidual = await this.store.readMembership(
          client,
          workspaceId,
          subject,
        );
        if (
          callerResidual === undefined ||
          callerResidual.status === WORKSPACE_MEMBER_STATUS.SUSPENDED ||
          (callerResidual.role !== WORKSPACE_ROLE.OWNER &&
            callerResidual.role !== WORKSPACE_ROLE.ADMINISTRATOR)
        ) {
          return { kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.FORBIDDEN };
        }

        // 2. Re-read the target row to decide 404 vs 412 vs 409.
        // Never answer 200 after a zero-row UPDATE.
        const residual = await this.store.readMembershipById(
          client,
          workspaceId,
          memberId,
        );
        if (residual === undefined) {
          return { kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.NOT_FOUND };
        }
        if (expectedVersion !== undefined) {
          return { kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.VERSION_CONFLICT };
        }
        return { kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.CONFLICT };
      }

      // After the UPDATE, and still inside the run callback, issue `set constraints all immediate`.
      // This forces any deferred constraint triggers (such as enforce_collaborative_owner_from_membership)
      // to fire here where check_violation (SQLSTATE 23514) can be caught and mapped to LAST_OWNER_REQUIRED (409),
      // rather than at COMMIT where PgTransaction.run would convert it into CommitOutcomeUnknownError (503).
      try {
        await this.store.enforceDeferredConstraints(client);
      } catch (error) {
        if (isCheckViolation(error)) {
          return {
            kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.LAST_OWNER_REQUIRED,
          };
        }
        throw error;
      }

      const member = await this.store.readRosterMember(
        client,
        workspaceId,
        memberId,
      );
      if (member === undefined) {
        return { kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.NOT_FOUND };
      }

      return {
        kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.OK,
        member,
        version: updateResult.version!,
      };
    });
  }
}

function isCheckViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    String((error as { code: unknown }).code) === '23514'
  );
}
