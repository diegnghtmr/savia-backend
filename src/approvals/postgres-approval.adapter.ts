import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  ApprovalClaim,
  ApprovalRecord,
  ApprovalStatus,
  ApprovalStore,
  CreateApprovalCommand,
  RiskClass,
} from './approval.port.js';

interface ApprovalRow extends Record<string, unknown> {
  readonly id: string;
  readonly workspaceId: string;
  readonly toolName: string;
  readonly channel: ApprovalRecord['channel'];
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
    channel: row.channel ?? null,
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

const approvalColumns = `id,
  workspace_id as "workspaceId", tool_name as "toolName", channel,
  risk_class as "riskClass", arguments_hash as "argumentsHash", preview, status,
  expires_at as "expiresAt", decided_by as "decidedBy", decided_at as "decidedAt",
  decision_reason as "decisionReason", created_by as "createdBy", created_at as "createdAt"`;

export class PostgresApprovalAdapter implements ApprovalStore {
  public async insertApproval(
    client: TransactionClient,
    workspaceId: string,
    command: Omit<CreateApprovalCommand, 'arguments'>,
    argumentsHash: string,
  ): Promise<ApprovalRecord | undefined> {
    const { toolName, riskClass, preview, expiresAt, channel } = command;
    const result = await client.query<ApprovalRow>(
      `insert into public.approvals
        (workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by, channel)
       select $1::uuid, $2, $3, $4, $5::jsonb, 'pending', $6::timestamptz,
              nullif(current_setting('app.subject_id', true), '')::uuid, $7
        where $6::timestamptz > clock_timestamp()
       returning ${approvalColumns}`,
      [
        workspaceId,
        toolName,
        riskClass,
        argumentsHash,
        JSON.stringify(preview),
        expiresAt,
        channel,
      ],
    );
    const row = result.rows[0];
    return row ? mapApproval(row) : undefined;
  }

  public async claimApproval(
    client: TransactionClient,
    workspaceId: string,
    approvalId: string,
    toolName: string,
    argumentsHash: string,
  ): Promise<ApprovalClaim> {
    const { rows } = await client.query<{ kind: ApprovalClaim }>(
      'select public.claim_approval($1::uuid, $2::uuid, $3, $4) as kind',
      [workspaceId, approvalId, toolName, argumentsHash],
    );
    if (!rows[0]) throw new Error('Approval claim returned no outcome');
    return rows[0].kind;
  }

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
      `select ${approvalColumns}
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
          and status = 'pending'
          and expires_at > $5::timestamptz
        returning ${approvalColumns}`,
      [workspaceId, approvalId, status, decidedBy, decidedAt, decisionReason],
    );

    const row = result.rows[0];
    return row ? mapApproval(row) : undefined;
  }
}
