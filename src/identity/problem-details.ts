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
} as const;
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly violations?: readonly FieldViolation[];
}
export function sendProblem(reply: FastifyReply, problem: Problem): void {
  void reply
    .status(problem.status)
    .type(PROBLEM_CONTENT_TYPE)
    .send({
      type: problem.type,
      title: problem.title,
      status: problem.status,
      instance: reply.request.url,
      ...(problem.violations === undefined
        ? {}
        : { violations: problem.violations }),
    });
}
