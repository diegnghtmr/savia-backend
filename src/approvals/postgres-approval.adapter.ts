import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  ApprovalRecord,
  ApprovalStatus,
  ApprovalStore,
  RiskClass,
} from './approval.port.js';

interface ApprovalRow extends Record<string, unknown> {
  readonly id: string;
  readonly workspaceId: string;
  readonly toolName: string;
  readonly riskClass: string;
  readonly argumentsHash: string;
  readonly preview: Record<string, unknown> | string;
  readonly status: string;
  readonly expiresAt: Date | string;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | string | null;
  readonly decisionReason: string | null;
  readonly createdBy: string;
  readonly createdAt: Date | string;
}

function mapApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    toolName: row.toolName,
    riskClass: row.riskClass as RiskClass,
    argumentsHash: row.argumentsHash,
    preview:
      typeof row.preview === 'string'
        ? (JSON.parse(row.preview) as Record<string, unknown>)
        : (row.preview as Record<string, unknown>),
    status: row.status as ApprovalStatus,
    expiresAt:
      row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt),
    decidedBy: row.decidedBy ?? null,
    decidedAt: row.decidedAt
      ? row.decidedAt instanceof Date
        ? row.decidedAt
        : new Date(row.decidedAt)
      : null,
    decisionReason: row.decisionReason ?? null,
    createdBy: row.createdBy,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  };
}

export class PostgresApprovalAdapter implements ApprovalStore {
  public async readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined> {
    const result = await client.query<{ role: string | null }>(
      'select public.workspace_actor_active_role($1::uuid) as role',
      [workspaceId],
    );
    return result.rows[0]?.role ?? undefined;
  }

  public async findApprovalById(
    client: TransactionClient,
    workspaceId: string,
    approvalId: string,
  ): Promise<ApprovalRecord | undefined> {
    const result = await client.query<ApprovalRow>(
      `select id,
              workspace_id as "workspaceId",
              tool_name as "toolName",
              risk_class as "riskClass",
              arguments_hash as "argumentsHash",
              preview,
              status,
              expires_at as "expiresAt",
              decided_by as "decidedBy",
              decided_at as "decidedAt",
              decision_reason as "decisionReason",
              created_by as "createdBy",
              created_at as "createdAt"
         from public.approvals
        where workspace_id = $1::uuid
          and id = $2::uuid`,
      [workspaceId, approvalId],
    );

    const row = result.rows[0];
    return row ? mapApproval(row) : undefined;
  }

  public async updateApprovalDecision(
    client: TransactionClient,
    workspaceId: string,
    approvalId: string,
    status: 'approved' | 'rejected',
    decidedBy: string,
    decidedAt: Date,
    decisionReason: string | null,
  ): Promise<ApprovalRecord | undefined> {
    const result = await client.query<ApprovalRow>(
      `update public.approvals
          set status = $3,
              decided_by = $4::uuid,
              decided_at = $5,
              decision_reason = $6
        where workspace_id = $1::uuid
          and id = $2::uuid
        returning id,
                  workspace_id as "workspaceId",
                  tool_name as "toolName",
                  risk_class as "riskClass",
                  arguments_hash as "argumentsHash",
                  preview,
                  status,
                  expires_at as "expiresAt",
                  decided_by as "decidedBy",
                  decided_at as "decidedAt",
                  decision_reason as "decisionReason",
                  created_by as "createdBy",
                  created_at as "createdAt"`,
      [workspaceId, approvalId, status, decidedBy, decidedAt, decisionReason],
    );

    const row = result.rows[0];
    return row ? mapApproval(row) : undefined;
  }
}
