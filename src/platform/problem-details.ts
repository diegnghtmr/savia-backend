import type { FastifyReply } from 'fastify';

export interface FieldViolation {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

const BASE_URI = 'https://savia.app/problems';
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const PROBLEM_TYPES = {
  VALIDATION_FAILED: `${BASE_URI}/validation-failed`,
  UNAUTHORIZED: `${BASE_URI}/unauthorized`,
  CONFLICT: `${BASE_URI}/conflict`,
  INTERNAL: `${BASE_URI}/internal`,
  OUTCOME_UNKNOWN: `${BASE_URI}/outcome-unknown`,
  BAD_REQUEST: `${BASE_URI}/bad-request`,
  NOT_FOUND: `${BASE_URI}/not-found`,
  UNPROCESSABLE: `${BASE_URI}/unprocessable`,
  PRECONDITION_FAILED: `${BASE_URI}/precondition-failed`,
  FORBIDDEN: `${BASE_URI}/forbidden`,
  ACCOUNT_CURRENCY_UNSUPPORTED: `${BASE_URI}/account-currency-unsupported`,
  BASE_CURRENCY_CHANGE_UNSUPPORTED: `${BASE_URI}/base-currency-change-unsupported`,
  ACCOUNT_HAS_UNSETTLED_TRANSACTIONS: `${BASE_URI}/account-has-unsettled-transactions`,
  ACCOUNT_ALREADY_CLOSED: `${BASE_URI}/account-already-closed`,
  TRANSACTION_SPLITS_UNSUPPORTED: `${BASE_URI}/transaction-splits-unsupported`,
  ACCOUNT_UNRESOLVED: `${BASE_URI}/account-unresolved`,
  ACCOUNT_CLOSED: `${BASE_URI}/account-closed`,
  TRANSACTION_RECONCILED: `${BASE_URI}/transaction-reconciled`,
  TRANSACTION_VOIDED: `${BASE_URI}/transaction-voided`,
  TRANSACTION_DRAFT: `${BASE_URI}/transaction-draft`,
  TRANSFER_CURRENCY_MISMATCH: `${BASE_URI}/transfer-currency-mismatch`,
} as const;
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly errors?: readonly FieldViolation[];
}
export function sendProblem(reply: FastifyReply, problem: Problem): void {
  const code = problem.type.substring(problem.type.lastIndexOf('/') + 1);
  void reply
    .status(problem.status)
    .type(PROBLEM_CONTENT_TYPE)
    .send({
      type: problem.type,
      title: problem.title,
      status: problem.status,
      code,
      traceId: reply.request.id,
      instance: reply.request.url,
      ...(problem.detail === undefined ? {} : { detail: problem.detail }),
      ...(problem.errors === undefined ? {} : { errors: problem.errors }),
    });
}
