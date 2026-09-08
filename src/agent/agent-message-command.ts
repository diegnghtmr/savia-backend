import {
  add,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import type { AgentMessageCommand } from './agent-message.port.js';

const FIELDS = ['message', 'modelRef', 'credentialId'] as const;
export class AgentMessageValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Agent message validation failed.');
  }
}
export function createAgentMessageCommand(input: unknown): AgentMessageCommand {
  const violations: FieldViolation[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new AgentMessageValidationError(sortViolations(violations));
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body))
    if (!FIELDS.includes(key as (typeof FIELDS)[number]))
      add(violations, key, 'not-allowed', 'is not allowed');
  if (typeof body.message !== 'string')
    add(violations, 'message', 'required', 'is required and must be a string');
  else if (body.message.length === 0)
    add(violations, 'message', 'min-length', 'must be at least 1 character');
  else if ([...body.message].length > 20000)
    add(
      violations,
      'message',
      'max-length',
      'must be at most 20000 characters',
    );
  for (const field of ['modelRef', 'credentialId'] as const) {
    const value = body[field];
    if (value !== undefined && value !== null && typeof value !== 'string')
      add(violations, field, 'invalid-type', 'must be a string or null');
  }
  if (violations.length)
    throw new AgentMessageValidationError(
      Object.freeze(sortViolations(violations)),
    );
  return {
    message: body.message as string,
    modelRef: (body.modelRef as string | null | undefined) ?? null,
    credentialId: (body.credentialId as string | null | undefined) ?? null,
  };
}
