import { parseListQuery } from '../platform/list-query.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import { APPROVAL_STATUSES, type ApprovalListQuery } from './approval.port.js';
import type { FieldViolation } from '../platform/problem-details.js';

export class ApprovalQueryValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Approval query validation failed.');
    this.name = 'ApprovalQueryValidationError';
  }
}

export function createApprovalListQuery(
  workspaceId: string,
  statusParam?: unknown,
  cursorParam?: string,
  limitParam?: string,
): ApprovalListQuery {
  const status = APPROVAL_STATUSES.find(
    (allowed) => allowed === (statusParam ?? 'pending'),
  );
  const { violations, limit, cursor } = parseListQuery({
    cursorParam,
    limitParam,
    expectedWorkspaceId: workspaceId,
    expectedFilter: status,
  });
  if (status === undefined) {
    throw new ApprovalQueryValidationError([
      ...violations,
      Object.freeze({
        field: 'status',
        code: 'invalid',
        message: 'status must be a valid approval status.',
      }),
    ]);
  }
  if (violations.length) throw new ApprovalQueryValidationError(violations);
  return { status, limit, ...(cursor === undefined ? {} : { cursor }) };
}

export function validateApprovalId(approvalId: unknown): string {
  if (typeof approvalId !== 'string' || !UUID_PATTERN.test(approvalId.trim())) {
    throw new ApprovalQueryValidationError([
      Object.freeze({
        field: 'approvalId',
        code: 'invalid',
        message: 'approvalId must be a valid UUID.',
      }),
    ]);
  }
  return approvalId.trim().toLowerCase();
}
