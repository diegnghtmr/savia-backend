import type { FastifyReply } from 'fastify';

import type { FieldViolation } from './bootstrap-command.js';

const BASE_URI = 'https://savia.app/problems';
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const PROBLEM_TYPES = {
  VALIDATION_FAILED: `${BASE_URI}/validation-failed`,
  UNAUTHORIZED: `${BASE_URI}/unauthorized`,
  ONBOARDING_CONFLICT: `${BASE_URI}/onboarding-conflict`,
  CONFLICT: `${BASE_URI}/conflict`,
  INTERNAL: `${BASE_URI}/internal`,
  OUTCOME_UNKNOWN: `${BASE_URI}/outcome-unknown`,
  BAD_REQUEST: `${BASE_URI}/bad-request`,
  NOT_FOUND: `${BASE_URI}/not-found`,
  UNPROCESSABLE: `${BASE_URI}/unprocessable`,
  PRECONDITION_FAILED: `${BASE_URI}/precondition-failed`,
  FORBIDDEN: `${BASE_URI}/forbidden`,
  PERSONAL_WORKSPACE_MEMBERSHIP: `${BASE_URI}/personal-workspace-membership`,
  LAST_OWNER_REQUIRED: `${BASE_URI}/last-owner-required`,
  PERSONAL_WORKSPACE_INVITATION: `${BASE_URI}/personal-workspace-invitation`,
  WORKSPACE_INVITATION_EXISTING_MEMBER: `${BASE_URI}/workspace-invitation-existing-member`,
  WORKSPACE_INVITATION_ALREADY_PENDING: `${BASE_URI}/workspace-invitation-already-pending`,
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
