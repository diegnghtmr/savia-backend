import { createHash, timingSafeEqual } from 'node:crypto';
import { encodeCursor } from '../platform/cursor.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  APPROVAL_OUTCOMES,
  APPROVAL_STORE,
  type ApprovalAction,
  type ApprovalCreationOutcome,
  type ApprovalDecisionCommand,
  type ApprovalDecisionOutcome,
  type ApprovalExecutionOutcome,
  type ApprovalExecutors,
  type ApprovalGetOutcome,
  type ApprovalListOutcome,
  type ApprovalListQuery,
  type ApprovalRecord,
  type ApprovalRequestPayload,
  type ApprovalsPort,
  type ApprovalStatus,
  type ApprovalStore,
  type CreateApprovalCommand,
  type McpApprovalCommand,
  type McpApprovalOutcome,
  type McpApprovalValidation,
} from './approval.port.js';
import { Inject } from '@nestjs/common';

export function timingSafeHashMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function canonicalArguments(args: ApprovalAction['arguments']): string {
  const invalid = () =>
    new TypeError('Approval arguments must be plain JSON data');
  const ancestors = new Set<object>();

  function readDataProperty(object: object, key: string): unknown {
    const property = Object.getOwnPropertyDescriptor(object, key);
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) {
      throw invalid();
    }
    return copy(property.value);
  }

  function copy(value: unknown): unknown {
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      return value;
    }
    if (typeof value !== 'object' || ancestors.has(value)) throw invalid();
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      prototype !== null &&
      prototype !== (array ? Array.prototype : Object.prototype)
    ) {
      throw invalid();
    }
    ancestors.add(value);
    try {
      const keys = Reflect.ownKeys(value);
      if (array) {
        if (keys.length !== value.length + 1) throw invalid();
        return Array.from({ length: value.length }, (_, i) =>
          readDataProperty(value, String(i)),
        );
      }
      if (!keys.every((key) => typeof key === 'string')) throw invalid();
      const entries = keys
        .sort()
        .map((key) => [key, readDataProperty(value, key)] as const);
      // Keep every JSON key (including __proto__) without invoking toJSON.
      return Object.setPrototypeOf(Object.fromEntries(entries), null);
    } finally {
      ancestors.delete(value);
    }
  }

  if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalid();
  return JSON.stringify(copy(args));
}

function hashArguments(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

function toPayload(
  approval: ApprovalRecord,
  status = approval.status,
): ApprovalRequestPayload {
  return {
    id: approval.id,
    toolName: approval.toolName,
    riskClass: approval.riskClass,
    argumentsHash: approval.argumentsHash,
    preview: approval.preview,
    status,
    expiresAt: approval.expiresAt.toISOString(),
    createdAt: approval.createdAt.toISOString(),
  };
}

export class ApprovalDecisionRollbackError extends Error {
  public constructor(
    public readonly outcome:
      | 'replayed'
      | 'conflict'
      | 'forbidden'
      | 'invalid_action'
      | 'precondition_failed',
    public readonly status?: number,
    public readonly etag?: string | null,
    public readonly body?: unknown,
  ) {
    super('Approval decision rolled back.');
    this.name = 'ApprovalDecisionRollbackError';
  }
}

export interface ApprovalTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export class ApprovalService implements ApprovalsPort {
  public constructor(
    private readonly tx: ApprovalTransaction,
    @Inject(APPROVAL_STORE) private readonly store: ApprovalStore,
    private readonly idempotency: IdempotencyStore,
    private readonly clock: () => Date = () => new Date(),
    private readonly executors: ApprovalExecutors = new Map(),
  ) {}

  public async createApproval(
    subject: string,
    workspaceId: string,
    { arguments: args, ...command }: CreateApprovalCommand,
  ): Promise<ApprovalCreationOutcome> {
    const canonical = canonicalArguments(args);
    const hash = hashArguments(canonical);
    // Agent confirmation needs the server-validated arguments. The preview is
    // immutable to the application role once inserted and the hash binds it.
    const preview =
      command.channel === 'agent'
        ? {
            ...command.preview,
            arguments: JSON.parse(canonical) as ApprovalAction['arguments'],
          }
        : command.preview;
    const expiresAt = new Date(command.expiresAt.getTime());
    return this.tx.run(subject, async (client) => {
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        !['owner', 'administrator'].includes(role ?? '') &&
        !(role === 'editor' && command.riskClass !== 'administrative')
      ) {
        return { kind: APPROVAL_OUTCOMES.FORBIDDEN };
      }
      const approval = await this.insertPendingApproval(
        client,
        workspaceId,
        { ...command, preview, expiresAt },
        hash,
      );
      return approval
        ? { kind: APPROVAL_OUTCOMES.OK, approval: toPayload(approval) }
        : { kind: APPROVAL_OUTCOMES.CONFLICT };
    });
  }

  private insertPendingApproval(
    client: TransactionClient,
    workspaceId: string,
    command: Parameters<ApprovalStore['insertApproval']>[2],
    hash: string,
  ): Promise<ApprovalRecord | undefined> {
    return command.expiresAt.getTime() > this.clock().getTime()
      ? this.store.insertApproval(client, workspaceId, command, hash)
      : Promise.resolve(undefined);
  }

  public async createMcpProposal(
    subject: string,
    workspaceId: string,
    { arguments: args, grantId, ...command }: McpApprovalCommand,
    key: string,
    authorize: (client: TransactionClient) => Promise<boolean>,
    validate: (client: TransactionClient) => Promise<McpApprovalValidation>,
    snapshot?: () => ApprovalAction['arguments'],
  ): Promise<McpApprovalOutcome> {
    const route = 'POST /v1/mcp/proposals';
    const canonical = canonicalArguments(args);
    const hash = hashArguments(canonical);
    const fingerprint = computeRequestFingerprint({
      grantId,
      toolName: command.toolName,
      hash,
    });
    try {
      return await this.tx.run(subject, async (client) => {
        if (!(await authorize(client))) return { kind: 'forbidden' };
        // PgTransaction serializes writers for the same subject, including this key.
        const existing = await this.idempotency.read(
          client,
          subject,
          route,
          key,
          workspaceId,
        );
        if (existing) {
          return existing.requestFingerprint === fingerprint
            ? { kind: 'ok', body: existing.responseBody }
            : { kind: 'conflict' };
        }
        const kind = await validate(client);
        if (kind !== 'ok') return { kind };
        // A server-resolved snapshot binds mutable inputs to the approval,
        // while proposal replay is still keyed to the caller's original input.
        const bound = snapshot ? canonicalArguments(snapshot()) : canonical;
        const approval = await this.insertPendingApproval(
          client,
          workspaceId,
          {
            ...command,
            channel: 'mcp',
            expiresAt: new Date(this.clock().getTime() + 15 * 60_000),
            mcp: {
              grantId,
              arguments: JSON.parse(bound) as ApprovalAction['arguments'],
            },
          },
          snapshot ? hashArguments(bound) : hash,
        );
        if (!approval) return { kind: 'conflict' };
        const { id, preview, expiresAt } = toPayload(approval);
        const body = { id, preview, expiresAt, status: 'pending' };
        const written = await this.idempotency.write(
          client,
          subject,
          route,
          key,
          fingerprint,
          201,
          null,
          body,
          workspaceId,
        );
        if (!written) throw new ApprovalDecisionRollbackError('conflict');
        return { kind: 'ok', body };
      });
    } catch (error) {
      if (
        error instanceof ApprovalDecisionRollbackError &&
        error.outcome === 'conflict'
      ) {
        return { kind: 'conflict' };
      }
      throw error;
    }
  }

  public async executeApprovedAction<T>(
    subject: string,
    workspaceId: string,
    approvalId: string,
    { toolName, arguments: args }: ApprovalAction,
    execute: (
      client: TransactionClient,
      args: ApprovalAction['arguments'],
    ) => Promise<T>,
  ): Promise<ApprovalExecutionOutcome<T>> {
    const canonical = canonicalArguments(args);
    return this.tx.run(subject, (client) =>
      this.executeApprovedActionWithin(
        client,
        workspaceId,
        approvalId,
        toolName,
        canonical,
        execute,
      ),
    );
  }

  private async executeApprovedActionWithin<T>(
    client: TransactionClient,
    workspaceId: string,
    approvalId: string,
    toolName: string,
    canonical: string,
    execute: (
      client: TransactionClient,
      args: ApprovalAction['arguments'],
    ) => Promise<T>,
  ): Promise<ApprovalExecutionOutcome<T>> {
    const kind = await this.store.claimApproval(
      client,
      workspaceId,
      approvalId,
      toolName,
      hashArguments(canonical),
    );
    if (kind !== APPROVAL_OUTCOMES.OK) return { kind };
    const snapshot = JSON.parse(canonical) as ApprovalAction['arguments'];
    return { kind, result: await execute(client, snapshot) };
  }

  private async executeDecision(
    client: TransactionClient,
    approver: string,
    approval: ApprovalRecord,
  ): Promise<void> {
    const execute = this.executors.get(approval.toolName);
    const args = approval.mcp?.arguments ?? approval.preview.arguments;
    if (!execute || !args || typeof args !== 'object' || Array.isArray(args))
      throw new ApprovalDecisionRollbackError('conflict');
    const canonical = canonicalArguments(args as ApprovalAction['arguments']);
    // The transaction already runs as the confirming creator. The claim
    // rechecks and locks their current workspace membership before writing.
    const result = await this.executeApprovedActionWithin(
      client,
      approval.workspaceId,
      approval.id,
      approval.toolName,
      canonical,
      (transaction, snapshot) =>
        execute(
          transaction,
          approver,
          approval.workspaceId,
          approval.id,
          snapshot,
          approval.mcp?.grantId,
        ),
    );
    if (result.kind !== 'ok')
      throw new ApprovalDecisionRollbackError(result.kind);
    if (result.result !== 'ok')
      throw new ApprovalDecisionRollbackError(result.result);
  }

  public listApprovals(
    subject: string,
    workspaceId: string,
    query: ApprovalListQuery,
  ): Promise<ApprovalListOutcome> {
    return this.tx.runRead(subject, async (client) => {
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        !['owner', 'administrator', 'editor', 'viewer'].includes(role ?? '')
      ) {
        return { kind: APPROVAL_OUTCOMES.FORBIDDEN };
      }
      const rows = await this.store.listApprovals(
        client,
        workspaceId,
        query,
        this.clock(),
      );
      const hasNextPage = rows.length > query.limit;
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        kind: APPROVAL_OUTCOMES.OK,
        page: {
          items: items.map((approval) => toPayload(approval, query.status)),
          pageInfo: {
            hasNextPage,
            nextCursor:
              hasNextPage && last
                ? encodeCursor({
                    workspaceId,
                    filter: query.status,
                    createdAt: last.cursorAt,
                    id: last.id,
                  })
                : null,
          },
        },
      };
    });
  }

  public async getApproval(
    subject: string,
    workspaceId: string,
    approvalId: string,
  ): Promise<ApprovalGetOutcome> {
    return this.tx.runRead(subject, async (client) => {
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        !['owner', 'administrator', 'editor', 'viewer'].includes(role ?? '')
      ) {
        return { kind: APPROVAL_OUTCOMES.FORBIDDEN };
      }

      const approval = await this.store.findApprovalById(
        client,
        workspaceId,
        approvalId,
      );
      if (!approval) {
        return { kind: APPROVAL_OUTCOMES.NOT_FOUND };
      }

      const now = this.clock();
      let effectiveStatus: ApprovalStatus = approval.status;
      if (
        approval.status === 'pending' &&
        approval.expiresAt.getTime() <= now.getTime()
      ) {
        effectiveStatus = 'expired';
      }

      return {
        kind: APPROVAL_OUTCOMES.OK,
        approval: toPayload(approval, effectiveStatus),
      };
    });
  }

  public async confirmApproval(
    subject: string,
    workspaceId: string,
    approvalId: string,
    command: ApprovalDecisionCommand,
    key: string,
  ): Promise<ApprovalDecisionOutcome> {
    return this.decideApproval(
      subject,
      workspaceId,
      approvalId,
      command,
      key,
      'POST /v1/approvals/{approvalId}/confirm',
      'approved',
    );
  }

  public async rejectApproval(
    subject: string,
    workspaceId: string,
    approvalId: string,
    command: ApprovalDecisionCommand,
    key: string,
  ): Promise<ApprovalDecisionOutcome> {
    return this.decideApproval(
      subject,
      workspaceId,
      approvalId,
      command,
      key,
      'POST /v1/approvals/{approvalId}/reject',
      'rejected',
    );
  }

  private async decideApproval(
    subject: string,
    workspaceId: string,
    approvalId: string,
    command: ApprovalDecisionCommand,
    key: string,
    route: string,
    targetStatus: 'approved' | 'rejected',
  ): Promise<ApprovalDecisionOutcome> {
    const fingerprint = computeRequestFingerprint({
      approvalId,
      ...command,
    });

    try {
      return await this.tx.run(subject, async (client) => {
        const role = await this.store.readActiveRole(client, workspaceId);
        const administrator = role === 'owner' || role === 'administrator';
        const confirming = targetStatus === 'approved';
        if (!administrator && !(confirming && role === 'editor')) {
          return { kind: APPROVAL_OUTCOMES.FORBIDDEN };
        }

        const approval = await this.store.findApprovalById(
          client,
          workspaceId,
          approvalId,
        );
        const creatorConfirmation =
          confirming &&
          (approval?.channel === 'agent' || approval?.mcp !== undefined);
        if (
          creatorConfirmation
            ? approval?.createdBy !== subject.toLowerCase()
            : !administrator
        ) {
          return { kind: APPROVAL_OUTCOMES.FORBIDDEN };
        }
        const existing = await this.idempotency.read(
          client,
          subject,
          route,
          key,
          workspaceId,
        );
        if (existing && existing.requestFingerprint !== fingerprint) {
          return {
            kind: APPROVAL_OUTCOMES.CONFLICT,
            reason:
              'Idempotency key already used with different request parameters',
          };
        }

        if (!approval) {
          return { kind: APPROVAL_OUTCOMES.NOT_FOUND };
        }

        const now = this.clock();
        if (approval.status === 'consumed') {
          // A completed MCP write is safe to acknowledge, never to run again.
          if (confirming && approval.mcp && existing) {
            return {
              kind: APPROVAL_OUTCOMES.REPLAYED,
              status: existing.responseStatus,
              etag: existing.responseEtag,
              body: existing.responseBody,
            };
          }
          return {
            kind: APPROVAL_OUTCOMES.CONFLICT,
            reason: 'Approval has already been consumed',
          };
        }

        if (
          approval.status === 'expired' ||
          approval.expiresAt.getTime() <= now.getTime()
        ) {
          return {
            kind: APPROVAL_OUTCOMES.CONFLICT,
            reason: 'Approval has expired',
          };
        }

        if (existing) {
          // This is a deliberate narrowing of idempotency semantics: an idempotency key
          // normally means "safe to repeat". For an authorization decision it must mean
          // "safe to repeat while the decision still stands". A replay is not a fresh grant.
          // If the approval has expired, been consumed, or transitioned to an incompatible terminal status,
          // it must be refused with 409 rather than returning a misleading successful replay.
          if (targetStatus === 'approved' && approval.status === 'rejected') {
            return {
              kind: APPROVAL_OUTCOMES.CONFLICT,
              reason: 'Approval is not pending',
            };
          }
          if (targetStatus === 'rejected' && approval.status === 'approved') {
            return {
              kind: APPROVAL_OUTCOMES.CONFLICT,
              reason: 'Approval is not pending',
            };
          }

          return {
            kind: APPROVAL_OUTCOMES.REPLAYED,
            status: existing.responseStatus,
            etag: existing.responseEtag,
            body: existing.responseBody,
          };
        }

        if (approval.status !== 'pending') {
          return {
            kind: APPROVAL_OUTCOMES.CONFLICT,
            reason: 'Approval is not pending',
          };
        }

        if (
          !timingSafeHashMatch(command.argumentsHash, approval.argumentsHash)
        ) {
          return {
            kind: APPROVAL_OUTCOMES.CONFLICT,
            reason: 'Arguments hash mismatch',
          };
        }

        const updated = await this.store.updateApprovalDecision(
          client,
          workspaceId,
          approvalId,
          targetStatus,
          subject,
          now,
          command.reason ?? null,
        );

        if (!updated) {
          return { kind: APPROVAL_OUTCOMES.CONFLICT };
        }

        if (creatorConfirmation)
          await this.executeDecision(client, subject, updated);
        const responsePayload = toPayload(
          updated,
          creatorConfirmation ? 'consumed' : updated.status,
        );

        const written = await this.idempotency.write(
          client,
          subject,
          route,
          key,
          fingerprint,
          200,
          null,
          responsePayload,
          workspaceId,
        );

        if (!written) {
          const reread = await this.idempotency.read(
            client,
            subject,
            route,
            key,
            workspaceId,
          );
          if (reread) {
            if (reread.requestFingerprint === fingerprint) {
              throw new ApprovalDecisionRollbackError(
                'replayed',
                reread.responseStatus,
                reread.responseEtag,
                reread.responseBody,
              );
            }
            throw new ApprovalDecisionRollbackError('conflict');
          }
          throw new Error(
            'Approval decision idempotency record could not be reread.',
          );
        }

        return {
          kind: APPROVAL_OUTCOMES.OK,
          approval: responsePayload,
        };
      });
    } catch (error) {
      if (error instanceof ApprovalDecisionRollbackError) {
        if (error.outcome === 'replayed') {
          return {
            kind: APPROVAL_OUTCOMES.REPLAYED,
            status: error.status ?? 200,
            etag: error.etag ?? null,
            body: error.body,
          };
        }
        return { kind: error.outcome };
      }
      throw error;
    }
  }
}
