import type { TransactionClient } from '../platform/pg-transaction.js';

export const APPROVALS_PORT = Symbol('ApprovalsPort');
export const APPROVAL_STORE = Symbol('ApprovalStore');

export const RISK_CLASSES = [
  'low_risk_write',
  'financial_write',
  'destructive',
  'administrative',
] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'consumed',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface ApprovalRequestPayload {
  readonly id: string;
  readonly toolName: string;
  readonly riskClass: RiskClass;
  readonly argumentsHash: string;
  readonly preview: Record<string, unknown>;
  readonly status: ApprovalStatus;
  readonly expiresAt: string;
  readonly createdAt?: string;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly toolName: string;
  readonly riskClass: RiskClass;
  readonly argumentsHash: string;
  readonly preview: Record<string, unknown>;
  readonly status: ApprovalStatus;
  readonly expiresAt: Date;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly decisionReason: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface ApprovalDecisionCommand {
  readonly argumentsHash: string;
  readonly reason?: string | null;
}

export const APPROVAL_OUTCOMES = {
  OK: 'ok',
  REPLAYED: 'replayed',
  CONFLICT: 'conflict',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
} as const;

export type ApprovalGetOutcome =
  | {
      readonly kind: typeof APPROVAL_OUTCOMES.OK;
      readonly approval: ApprovalRequestPayload;
    }
  | { readonly kind: typeof APPROVAL_OUTCOMES.NOT_FOUND }
  | { readonly kind: typeof APPROVAL_OUTCOMES.FORBIDDEN };

export type ApprovalDecisionOutcome =
  | {
      readonly kind: typeof APPROVAL_OUTCOMES.OK;
      readonly approval: ApprovalRequestPayload;
    }
  | {
      readonly kind: typeof APPROVAL_OUTCOMES.REPLAYED;
      readonly status: number;
      readonly etag?: string | null;
      readonly body: unknown;
    }
  | {
      readonly kind: typeof APPROVAL_OUTCOMES.CONFLICT;
      readonly reason?: string;
    }
  | { readonly kind: typeof APPROVAL_OUTCOMES.FORBIDDEN }
  | { readonly kind: typeof APPROVAL_OUTCOMES.NOT_FOUND };

export interface ApprovalStore {
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;

  findApprovalById(
    client: TransactionClient,
    workspaceId: string,
    approvalId: string,
  ): Promise<ApprovalRecord | undefined>;

  updateApprovalDecision(
    client: TransactionClient,
    workspaceId: string,
    approvalId: string,
    status: 'approved' | 'rejected',
    decidedBy: string,
    decidedAt: Date,
    decisionReason: string | null,
  ): Promise<ApprovalRecord | undefined>;
}

export interface ApprovalsPort {
  getApproval(
    subject: string,
    workspaceId: string,
    approvalId: string,
  ): Promise<ApprovalGetOutcome>;

  confirmApproval(
    subject: string,
    workspaceId: string,
    approvalId: string,
    command: ApprovalDecisionCommand,
    key: string,
  ): Promise<ApprovalDecisionOutcome>;

  rejectApproval(
    subject: string,
    workspaceId: string,
    approvalId: string,
    command: ApprovalDecisionCommand,
    key: string,
  ): Promise<ApprovalDecisionOutcome>;
}
