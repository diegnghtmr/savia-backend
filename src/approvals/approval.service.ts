import { createHash, timingSafeEqual } from 'node:crypto';
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
  type ApprovalGetOutcome,
  type ApprovalRecord,
  type ApprovalRequestPayload,
  type ApprovalsPort,
  type ApprovalStatus,
  type ApprovalStore,
  type CreateApprovalCommand,
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
    public readonly outcome: 'replayed' | 'conflict',
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
  ) {}

  public async createApproval(
    subject: string,
    workspaceId: string,
    { arguments: args, ...command }: CreateApprovalCommand,
  ): Promise<ApprovalCreationOutcome> {
    const hash = hashArguments(canonicalArguments(args));
    const expiresAt = new Date(command.expiresAt.getTime());
    return this.tx.run(subject, async (client) => {
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        !['owner', 'administrator'].includes(role ?? '') &&
        !(role === 'editor' && command.riskClass !== 'administrative')
      ) {
        return { kind: APPROVAL_OUTCOMES.FORBIDDEN };
      }
      if (!(expiresAt.getTime() > this.clock().getTime())) {
        return { kind: APPROVAL_OUTCOMES.CONFLICT };
      }
      const approval = await this.store.insertApproval(
        client,
        workspaceId,
        { ...command, expiresAt },
        hash,
      );
      return approval
        ? { kind: APPROVAL_OUTCOMES.OK, approval: toPayload(approval) }
        : { kind: APPROVAL_OUTCOMES.CONFLICT };
    });
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
    const hash = hashArguments(canonical);
    const snapshot = JSON.parse(canonical) as ApprovalAction['arguments'];
    return this.tx.run(subject, async (client) => {
      const kind = await this.store.claimApproval(
        client,
        workspaceId,
        approvalId,
        toolName,
        hash,
      );
      if (kind !== APPROVAL_OUTCOMES.OK) return { kind };
      return { kind, result: await execute(client, snapshot) };
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
        if (!['owner', 'administrator'].includes(role ?? '')) {
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

        const approval = await this.store.findApprovalById(
          client,
          workspaceId,
          approvalId,
        );
        if (!approval) {
          return { kind: APPROVAL_OUTCOMES.NOT_FOUND };
        }

        const now = this.clock();
        if (approval.status === 'consumed') {
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

        const responsePayload = toPayload(updated);

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
        return { kind: APPROVAL_OUTCOMES.CONFLICT };
      }
      throw error;
    }
  }
}
