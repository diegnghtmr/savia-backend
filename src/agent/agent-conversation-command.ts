import {
  add,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import type { CreateAgentConversationCommand } from './agent-conversation.port.js';

const FIELDS = ['title', 'modelRef', 'credentialId'] as const;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class AgentConversationValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Agent conversation validation failed.');
  }
}
export function createAgentConversationCommand(
  input: unknown,
): CreateAgentConversationCommand {
  const violations: FieldViolation[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new AgentConversationValidationError(sortViolations(violations));
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body))
    if (!FIELDS.includes(key as (typeof FIELDS)[number]))
      add(violations, key, 'not-allowed', 'is not allowed');
  const rawTitle = body.title;
  let title = 'New conversation';
  if (rawTitle !== undefined && rawTitle !== null) {
    if (typeof rawTitle !== 'string')
      add(violations, 'title', 'invalid-type', 'must be a string or null');
    else if (rawTitle.length > 120)
      add(violations, 'title', 'max-length', 'must be at most 120 characters');
    else title = rawTitle;
  }
  const rawModel = body.modelRef;
  let modelRef: string | null = null;
  if (rawModel !== undefined && rawModel !== null) {
    if (typeof rawModel !== 'string')
      add(violations, 'modelRef', 'invalid-type', 'must be a string or null');
    else modelRef = rawModel;
  }
  const rawCredential = body.credentialId;
  let credentialId: string | null = null;
  if (rawCredential !== undefined && rawCredential !== null) {
    if (typeof rawCredential !== 'string' || !UUID.test(rawCredential))
      add(
        violations,
        'credentialId',
        'invalid-value',
        'must be a UUID or null',
      );
    else credentialId = rawCredential.toLowerCase();
  }
  if (violations.length)
    throw new AgentConversationValidationError(
      Object.freeze(sortViolations(violations)),
    );
  return { title, modelRef, credentialId };
}
