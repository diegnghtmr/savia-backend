import type { IdempotencyStore } from './idempotency.port.js';
import { computeRequestFingerprint } from './idempotency.service.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  WorkspaceCreateCommand,
  WorkspaceUpdateCommand,
} from './workspace-command.js';
import { encodeCursor } from '../platform/cursor.js';
import {
  WORKSPACE_ACCESS_KINDS,
  WORKSPACE_CREATE_OUTCOME_KINDS,
  WORKSPACE_DELETE_OUTCOME_KINDS,
  WORKSPACE_KIND,
  WORKSPACE_MEMBER_STATUS,
  WORKSPACE_ROLE,
  WORKSPACE_UPDATE_OUTCOMES,
  type Workspace,
  type WorkspaceAccess,
  type WorkspaceCreateOutcome,
  type WorkspaceCursor,
  type WorkspaceDeleteOutcome,
  type WorkspaceDeleteOutcomeKind,
  type WorkspaceKind,
  type WorkspaceListQuery,
  type WorkspaceMemberStatus,
  type WorkspacePage,
  type WorkspacePort,
  type WorkspaceRole,
  type WorkspaceUpdateOutcome,
} from './workspace.port.js';

export interface WorkspaceReadTransaction {
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export interface WorkspaceTransaction extends WorkspaceReadTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export interface WorkspaceMembershipRecord {
  readonly role: WorkspaceRole;
  readonly status: WorkspaceMemberStatus;
}

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: WorkspaceKind;
  readonly baseCurrency: string;
  readonly createdAt: string;
  readonly version: number;
}

export interface WorkspaceItem {
  readonly workspace: Workspace;
  readonly cursorAt: string;
}

export interface WorkspaceStore {
  readMembership(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
  ): Promise<WorkspaceMembershipRecord | undefined>;
  readWorkspace(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<WorkspaceRecord | undefined>;
  listWorkspaces(
    client: TransactionClient,
    subject: string,
    cursor: WorkspaceCursor | undefined,
    limit: number,
  ): Promise<readonly WorkspaceItem[]>;
  createWorkspace(
    client: TransactionClient,
    subject: string,
    command: WorkspaceCreateCommand,
  ): Promise<{ id: string }>;
  createMembership(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    role: WorkspaceRole,
    status: WorkspaceMemberStatus,
  ): Promise<void>;
  hasAccounts(client: TransactionClient, workspaceId: string): Promise<boolean>;
  update(
    client: TransactionClient,
    workspaceId: string,
    command: WorkspaceUpdateCommand,
    expectedVersion?: number | readonly number[],
  ): Promise<WorkspaceRecord | undefined>;
  deleteWorkspace(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<number>;
}

export class WorkspaceService implements WorkspacePort {
  public constructor(
    private readonly transaction: WorkspaceTransaction,
    private readonly store: WorkspaceStore,
    private readonly idempotencyStore: IdempotencyStore,
  ) {}

  public read(subject: string, workspaceId: string): Promise<WorkspaceAccess> {
    return this.transaction.runRead(subject, async (client) => {
      const membership = await this.store.readMembership(
        client,
        workspaceId,
        subject,
      );
      if (membership === undefined) {
        return { kind: WORKSPACE_ACCESS_KINDS.NOT_FOUND };
      }
      if (membership.status === WORKSPACE_MEMBER_STATUS.SUSPENDED) {
        return { kind: WORKSPACE_ACCESS_KINDS.FORBIDDEN };
      }
      const workspace = await this.store.readWorkspace(client, workspaceId);
      // Not dead code, and not reachable by any test: the transaction is READ
      // COMMITTED, so this statement takes a newer snapshot than the membership
      // read above. A membership suspended or removed in between makes the
      // hardened policy withhold the row here even though it was active a
      // moment ago. Answering not-found is the right outcome for access revoked
      // mid-request, and it is what keeps the race from dereferencing undefined
      // and becoming a 500.
      if (workspace === undefined) {
        return { kind: WORKSPACE_ACCESS_KINDS.NOT_FOUND };
      }
      return {
        kind: WORKSPACE_ACCESS_KINDS.OK,
        workspace: {
          id: workspace.id,
          name: workspace.name,
          kind: workspace.kind,
          baseCurrency: workspace.baseCurrency,
          role: membership.role,
          createdAt: workspace.createdAt,
          version: workspace.version,
        },
      };
    });
  }

  public list(
    subject: string,
    query: WorkspaceListQuery,
  ): Promise<WorkspacePage> {
    return this.transaction.runRead(subject, async (client) => {
      const rows = await this.store.listWorkspaces(
        client,
        subject,
        query.cursor,
        query.limit + 1,
      );
      const hasNextPage = rows.length > query.limit;
      const visible = hasNextPage ? rows.slice(0, query.limit) : rows;
      const items = visible.map((entry) => entry.workspace);
      const lastItem = visible[visible.length - 1];
      const nextCursor =
        hasNextPage && lastItem !== undefined
          ? encodeCursor({
              createdAt: lastItem.cursorAt,
              id: lastItem.workspace.id,
            })
          : null;
      return {
        items,
        pageInfo: {
          hasNextPage,
          nextCursor,
        },
      };
    });
  }

  public async create(
    subject: string,
    command: WorkspaceCreateCommand,
    idempotencyKey: string,
  ): Promise<WorkspaceCreateOutcome> {
    const route = 'POST /v1/workspaces';
    const fingerprint = computeRequestFingerprint(command);

    return this.transaction.run(subject, async (client) => {
      const existing = await this.idempotencyStore.read(
        client,
        subject,
        route,
        idempotencyKey,
        null,
      );
      if (existing !== undefined) {
        if (existing.requestFingerprint !== fingerprint) {
          return {
            kind: WORKSPACE_CREATE_OUTCOME_KINDS.IDEMPOTENCY_CONFLICT,
          };
        }
        return {
          kind: WORKSPACE_CREATE_OUTCOME_KINDS.REPLAYED,
          status: existing.responseStatus,
          etag: existing.responseEtag,
          body: existing.responseBody,
        };
      }

      const { id } = await this.store.createWorkspace(client, subject, command);
      await this.store.createMembership(client, id, subject, 'owner', 'active');

      const record = await this.store.readWorkspace(client, id);
      if (record === undefined) {
        throw new Error('Created workspace could not be read.');
      }

      const workspace: Workspace = {
        id: record.id,
        name: record.name,
        kind: record.kind,
        baseCurrency: record.baseCurrency,
        role: 'owner',
        createdAt: record.createdAt,
        version: record.version,
      };

      const written = await this.idempotencyStore.write(
        client,
        subject,
        route,
        idempotencyKey,
        fingerprint,
        201,
        `"${workspace.version}"`,
        workspace,
        null,
      );

      if (!written) {
        // A losing write means a live record won and the response must come from that record.
        const reread = await this.idempotencyStore.read(
          client,
          subject,
          route,
          idempotencyKey,
          null,
        );
        if (reread !== undefined) {
          if (reread.requestFingerprint !== fingerprint) {
            return {
              kind: WORKSPACE_CREATE_OUTCOME_KINDS.IDEMPOTENCY_CONFLICT,
            };
          }
          return {
            kind: WORKSPACE_CREATE_OUTCOME_KINDS.REPLAYED,
            status: reread.responseStatus,
            etag: reread.responseEtag,
            body: reread.responseBody,
          };
        }
      }

      return {
        kind: WORKSPACE_CREATE_OUTCOME_KINDS.CREATED,
        workspace,
      };
    });
  }

  public update(
    subject: string,
    workspaceId: string,
    command: WorkspaceUpdateCommand,
    expectedVersion?: number | readonly number[],
  ): Promise<WorkspaceUpdateOutcome> {
    return this.transaction.run(subject, async (client) => {
      const membership = await this.store.readMembership(
        client,
        workspaceId,
        subject,
      );
      if (membership === undefined) {
        return { kind: WORKSPACE_UPDATE_OUTCOMES.NOT_FOUND };
      }
      if (membership.status === WORKSPACE_MEMBER_STATUS.SUSPENDED) {
        return { kind: WORKSPACE_UPDATE_OUTCOMES.FORBIDDEN };
      }
      if (
        membership.role !== WORKSPACE_ROLE.OWNER &&
        membership.role !== WORKSPACE_ROLE.ADMINISTRATOR
      ) {
        return { kind: WORKSPACE_UPDATE_OUTCOMES.FORBIDDEN };
      }

      const workspace = await this.store.readWorkspace(client, workspaceId);
      if (workspace === undefined) {
        return { kind: WORKSPACE_UPDATE_OUTCOMES.NOT_FOUND };
      }

      const versions =
        typeof expectedVersion === 'number'
          ? [expectedVersion]
          : expectedVersion;
      if (versions !== undefined && !versions.includes(workspace.version)) {
        return { kind: WORKSPACE_UPDATE_OUTCOMES.VERSION_CONFLICT };
      }

      if (
        command.baseCurrency !== undefined &&
        command.baseCurrency !== workspace.baseCurrency
      ) {
        const hasAccounts = await this.store.hasAccounts(client, workspaceId);
        if (hasAccounts) {
          return {
            kind: WORKSPACE_UPDATE_OUTCOMES.BASE_CURRENCY_CHANGE_UNSUPPORTED,
          };
        }
      }

      const updated = await this.store.update(
        client,
        workspaceId,
        command,
        versions,
      );
      if (updated === undefined) {
        // A zero-row UPDATE has three distinct causes:
        // 1. The workspace was deleted mid-transaction -> not-found (404)
        // 2. A concurrent update bumped the version -> version-conflict (412)
        // 3. The caller's membership was suspended mid-transaction, so the RLS
        //    UPDATE policy withheld the row while the version is unchanged -> forbidden (403)
        // Collapsing them into 412 reports an authorization failure as a concurrency failure.
        const reread = await this.store.readWorkspace(client, workspaceId);
        if (reread === undefined) {
          return { kind: WORKSPACE_UPDATE_OUTCOMES.NOT_FOUND };
        }
        if (reread.version !== workspace.version) {
          return { kind: WORKSPACE_UPDATE_OUTCOMES.VERSION_CONFLICT };
        }
        return { kind: WORKSPACE_UPDATE_OUTCOMES.FORBIDDEN };
      }

      return {
        kind: WORKSPACE_UPDATE_OUTCOMES.OK,
        workspace: {
          id: updated.id,
          name: updated.name,
          kind: updated.kind,
          baseCurrency: updated.baseCurrency,
          role: membership.role,
          createdAt: updated.createdAt,
          version: updated.version,
        },
        version: updated.version,
      };
    });
  }

  public async delete(
    subject: string,
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<WorkspaceDeleteOutcome> {
    const route = 'DELETE /v1/workspaces/{workspaceId}';
    const fingerprint = computeRequestFingerprint({ workspaceId });

    return this.transaction.run(subject, async (client) => {
      const existing = await this.idempotencyStore.read(
        client,
        subject,
        route,
        idempotencyKey,
        workspaceId,
      );
      if (existing !== undefined) {
        if (existing.requestFingerprint !== fingerprint) {
          return {
            kind: WORKSPACE_DELETE_OUTCOME_KINDS.IDEMPOTENCY_CONFLICT,
          };
        }
        return {
          kind: WORKSPACE_DELETE_OUTCOME_KINDS.REPLAYED,
          status: existing.responseStatus,
        };
      }

      let outcomeKind: WorkspaceDeleteOutcomeKind;
      let status: number;

      const membership = await this.store.readMembership(
        client,
        workspaceId,
        subject,
      );
      if (membership === undefined) {
        outcomeKind = WORKSPACE_DELETE_OUTCOME_KINDS.NOT_FOUND;
        status = 404;
      } else if (membership.status === WORKSPACE_MEMBER_STATUS.SUSPENDED) {
        outcomeKind = WORKSPACE_DELETE_OUTCOME_KINDS.FORBIDDEN;
        status = 403;
      } else if (membership.role !== WORKSPACE_ROLE.OWNER) {
        outcomeKind = WORKSPACE_DELETE_OUTCOME_KINDS.FORBIDDEN;
        status = 403;
      } else {
        const workspace = await this.store.readWorkspace(client, workspaceId);
        if (workspace === undefined) {
          outcomeKind = WORKSPACE_DELETE_OUTCOME_KINDS.NOT_FOUND;
          status = 404;
        } else if (workspace.kind === WORKSPACE_KIND.PERSONAL) {
          outcomeKind = WORKSPACE_DELETE_OUTCOME_KINDS.UNPROCESSABLE;
          status = 422;
        } else {
          const rowCount = await this.store.deleteWorkspace(
            client,
            workspaceId,
          );
          if (rowCount === 1) {
            outcomeKind = WORKSPACE_DELETE_OUTCOME_KINDS.DELETED;
            status = 204;
          } else {
            // rowCount === 0: Confirming re-SELECT separates policy refusal from concurrent deletion
            const reread = await this.store.readWorkspace(client, workspaceId);
            if (reread !== undefined) {
              // Row STILL PRESENT -> RLS policy refused deletion
              outcomeKind = WORKSPACE_DELETE_OUTCOME_KINDS.UNPROCESSABLE;
              status = 422;
            } else {
              // Row ABSENT -> workspace was concurrently deleted
              outcomeKind = WORKSPACE_DELETE_OUTCOME_KINDS.NOT_FOUND;
              status = 404;
            }
          }
        }
      }

      const written = await this.idempotencyStore.write(
        client,
        subject,
        route,
        idempotencyKey,
        fingerprint,
        status,
        null,
        null,
        workspaceId,
      );

      if (!written) {
        const reread = await this.idempotencyStore.read(
          client,
          subject,
          route,
          idempotencyKey,
          workspaceId,
        );
        if (reread !== undefined) {
          if (reread.requestFingerprint !== fingerprint) {
            return {
              kind: WORKSPACE_DELETE_OUTCOME_KINDS.IDEMPOTENCY_CONFLICT,
            };
          }
          return {
            kind: WORKSPACE_DELETE_OUTCOME_KINDS.REPLAYED,
            status: reread.responseStatus,
          };
        }
      }

      if (outcomeKind === WORKSPACE_DELETE_OUTCOME_KINDS.DELETED) {
        return { kind: WORKSPACE_DELETE_OUTCOME_KINDS.DELETED };
      }
      if (outcomeKind === WORKSPACE_DELETE_OUTCOME_KINDS.FORBIDDEN) {
        return { kind: WORKSPACE_DELETE_OUTCOME_KINDS.FORBIDDEN };
      }
      if (outcomeKind === WORKSPACE_DELETE_OUTCOME_KINDS.NOT_FOUND) {
        return { kind: WORKSPACE_DELETE_OUTCOME_KINDS.NOT_FOUND };
      }
      return { kind: WORKSPACE_DELETE_OUTCOME_KINDS.UNPROCESSABLE };
    });
  }
}
