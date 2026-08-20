import type { FastifyReply } from 'fastify';

import type { FieldViolation } from './bootstrap-command.js';

const BASE_URI = 'https://savia.app/problems';
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const PROBLEM_TYPES = {
  VALIDATION_FAILED: `${BASE_URI}/validation-failed`,
  UNAUTHORIZED: `${BASE_URI}/unauthorized`,
  ONBOARDING_CONFLICT: `${BASE_URI}/onboarding-conflict`,
  INTERNAL: `${BASE_URI}/internal`,
  OUTCOME_UNKNOWN: `${BASE_URI}/outcome-unknown`,
  BAD_REQUEST: `${BASE_URI}/bad-request`,
} as const;
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
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
      ...(problem.errors === undefined ? {} : { errors: problem.errors }),
    });
}
