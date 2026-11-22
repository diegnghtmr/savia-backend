import type { Cursor, PageInfo } from '../platform/cursor.js';
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
  readonly channel: 'agent' | 'mcp' | null;
  readonly mcp?: McpApprovalSnapshot;
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

export interface ApprovalAction {
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type ApprovalExecutor = (
  client: TransactionClient,
  subject: string,
  workspaceId: string,
  approvalId: string,
  args: ApprovalAction['arguments'],
  mcpGrantId?: string,
) => Promise<'ok' | 'forbidden' | 'conflict' | 'invalid_action'>;
export type ApprovalExecutors = ReadonlyMap<string, ApprovalExecutor>;

export interface CreateApprovalCommand extends ApprovalAction {
  readonly channel: 'agent' | 'mcp';
  readonly riskClass: RiskClass;
  readonly preview: Record<string, unknown>;
  readonly expiresAt: Date;
}

export interface McpApprovalSnapshot {
  readonly grantId: string;
  readonly arguments: ApprovalAction['arguments'];
}

export interface McpApprovalCommand extends ApprovalAction {
  readonly grantId: string;
  readonly riskClass: RiskClass;
  readonly preview: Record<string, unknown>;
}

export type McpApprovalOutcome =
  | { readonly kind: 'ok'; readonly body: unknown }
  | { readonly kind: 'forbidden' | 'conflict' };

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

export interface ApprovalListQuery {
  readonly status: ApprovalStatus;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export type ApprovalListOutcome =
  | {
      readonly kind: typeof APPROVAL_OUTCOMES.OK;
      readonly page: {
        readonly items: readonly ApprovalRequestPayload[];
        readonly pageInfo: PageInfo;
      };
    }
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
  | { readonly kind: typeof APPROVAL_OUTCOMES.NOT_FOUND }
  | { readonly kind: 'invalid_action' };

export type ApprovalExecutionOutcome<T> =
  | { readonly kind: typeof APPROVAL_OUTCOMES.OK; readonly result: T }
  | { readonly kind: typeof APPROVAL_OUTCOMES.FORBIDDEN }
  | { readonly kind: typeof APPROVAL_OUTCOMES.CONFLICT };

export type ApprovalCreationOutcome =
  | Extract<ApprovalGetOutcome, { kind: 'ok' | 'forbidden' }>
  | { readonly kind: typeof APPROVAL_OUTCOMES.CONFLICT };

export type ApprovalClaim = ApprovalExecutionOutcome<never>['kind'];

export interface ApprovalStore {
  insertApproval(
    client: TransactionClient,
    workspaceId: string,
    command: Omit<CreateApprovalCommand, 'arguments'> & {
      readonly mcp?: McpApprovalSnapshot;
    },
    argumentsHash: string,
  ): Promise<ApprovalRecord | undefined>;

  claimApproval(
    client: TransactionClient,
    workspaceId: string,
    approvalId: string,
    toolName: string,
    argumentsHash: string,
  ): Promise<ApprovalClaim>;

  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;

  listApprovals(
    client: TransactionClient,
    workspaceId: string,
    query: ApprovalListQuery,
    now: Date,
  ): Promise<readonly (ApprovalRecord & { readonly cursorAt: string })[]>;

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
  createApproval(
    subject: string,
    workspaceId: string,
    command: CreateApprovalCommand,
  ): Promise<ApprovalCreationOutcome>;

  // The action uses the supplied arguments and transaction, not a nested
  // transaction or external side effects. A thrown error rolls back the claim.
  executeApprovedAction<T>(
    subject: string,
    workspaceId: string,
    approvalId: string,
    action: ApprovalAction,
    execute: (
      client: TransactionClient,
      args: ApprovalAction['arguments'],
    ) => Promise<T>,
  ): Promise<ApprovalExecutionOutcome<T>>;

  listApprovals(
    subject: string,
    workspaceId: string,
    query: ApprovalListQuery,
  ): Promise<ApprovalListOutcome>;

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
