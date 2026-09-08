import {
  add,
  currencyValue,
  nameValue,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import type { CreateMcpGrantCommand, Money } from './mcp-grant.port.js';

// Derived from every x-savia-mcp-tool.requiredScopes in docs/savia-openapi.yaml; re-run the brief's Python extraction command.
export const MCP_GRANT_SCOPES = [
  'accounts:read',
  'accounts:write',
  'budgets:read',
  'budgets:write',
  'reports:read',
  'reports:write',
  'transactions:read',
  'transactions:write',
  'workspace:admin',
] as const;
export class McpGrantCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('MCP grant command validation failed.');
    this.name = 'McpGrantCommandValidationError';
  }
}
const FIELDS = [
  'clientName',
  'scopes',
  'workspaceIds',
  'accountIds',
  'maxWriteAmount',
  'expiresAt',
] as const;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uniqueIds(
  value: unknown,
  field: string,
  required: boolean,
  violations: FieldViolation[],
): string[] {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    add(
      violations,
      field,
      'invalid-type',
      required ? 'must be a non-empty array' : 'must be an array',
    );
    return [];
  }
  const ids = value.filter((x): x is string => typeof x === 'string');
  if (ids.length !== value.length || ids.some((x) => !UUID.test(x)))
    add(violations, field, 'invalid-value', 'must contain valid UUIDs');
  if (new Set(ids).size !== ids.length)
    add(violations, field, 'unique-items', 'must not contain duplicates');
  return ids.map((x) => x.toLowerCase());
}
export function createMcpGrantCommand(input: unknown): CreateMcpGrantCommand {
  const violations: FieldViolation[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new McpGrantCommandValidationError(sortViolations(violations));
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body))
    if (!FIELDS.includes(key as (typeof FIELDS)[number]))
      add(violations, key, 'not-allowed', 'is not allowed');
  const clientName = nameValue(body.clientName, 'clientName', violations, 120);
  const scopesRaw = body.scopes;
  const scopes = Array.isArray(scopesRaw)
    ? scopesRaw.filter((v): v is string => typeof v === 'string')
    : [];
  if (
    !Array.isArray(scopesRaw) ||
    scopes.length !== scopesRaw.length ||
    scopes.length === 0
  )
    add(
      violations,
      'scopes',
      'invalid-items',
      'must be a non-empty array of strings',
    );
  if (new Set(scopes).size !== scopes.length)
    add(violations, 'scopes', 'unique-items', 'must not contain duplicates');
  for (const scope of scopes)
    if (!(MCP_GRANT_SCOPES as readonly string[]).includes(scope))
      add(violations, 'scopes', 'unsupported', 'is not supported');
  const workspaceIds = uniqueIds(
    body.workspaceIds,
    'workspaceIds',
    true,
    violations,
  );
  const accountIds =
    body.accountIds === undefined
      ? undefined
      : uniqueIds(body.accountIds, 'accountIds', false, violations);
  let maxWriteAmount: Money | null = null;
  if (body.maxWriteAmount !== undefined && body.maxWriteAmount !== null) {
    const money = body.maxWriteAmount as Record<string, unknown>;
    if (
      typeof money !== 'object' ||
      Array.isArray(money) ||
      typeof money.amountMinor !== 'number' ||
      !Number.isSafeInteger(money.amountMinor)
    )
      add(
        violations,
        'maxWriteAmount',
        'invalid-type',
        'must be Money or null',
      );
    const currency = currencyValue(
      money.currency,
      'maxWriteAmount.currency',
      violations,
    );
    maxWriteAmount = { amountMinor: money.amountMinor as number, currency };
  }
  let expiresAt: Date | null = null;
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    if (
      typeof body.expiresAt !== 'string' ||
      Number.isNaN(Date.parse(body.expiresAt))
    )
      add(
        violations,
        'expiresAt',
        'invalid-value',
        'must be a date-time or null',
      );
    else expiresAt = new Date(body.expiresAt);
  }
  if (violations.length)
    throw new McpGrantCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  return {
    clientName,
    scopes,
    workspaceIds,
    ...(accountIds === undefined ? {} : { accountIds }),
    maxWriteAmount,
    expiresAt,
  };
}
