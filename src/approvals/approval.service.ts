import { timingSafeEqual } from 'node:crypto';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  APPROVAL_OUTCOMES,
  APPROVAL_STORE,
  type ApprovalDecisionCommand,
  type ApprovalDecisionOutcome,
  type ApprovalGetOutcome,
  type ApprovalRequestPayload,
  type ApprovalsPort,
  type ApprovalStatus,
  type ApprovalStore,
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

      const payload: ApprovalRequestPayload = {
        id: approval.id,
        toolName: approval.toolName,
        riskClass: approval.riskClass,
        argumentsHash: approval.argumentsHash,
        preview: approval.preview,
        status: effectiveStatus,
        expiresAt: approval.expiresAt.toISOString(),
        createdAt: approval.createdAt.toISOString(),
      };

      return {
        kind: APPROVAL_OUTCOMES.OK,
        approval: payload,
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

        const responsePayload: ApprovalRequestPayload = {
          id: updated.id,
          toolName: updated.toolName,
          riskClass: updated.riskClass,
          argumentsHash: updated.argumentsHash,
          preview: updated.preview,
          status: updated.status,
          expiresAt: updated.expiresAt.toISOString(),
          createdAt: updated.createdAt.toISOString(),
        };

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
