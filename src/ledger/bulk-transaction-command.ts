import { UUID_PATTERN } from '../platform/uuid.js';

export type BulkAction =
  | { readonly type: 'categorize'; readonly categoryId: string | null }
  | { readonly type: 'setPayee'; readonly payeeId: string | null }
  | { readonly type: 'tag'; readonly tagIds: readonly string[] }
  | {
      readonly type: 'convertImported';
      readonly targetType: 'income' | 'expense';
    }
  | { readonly type: 'setExtraordinary'; readonly extraordinary: boolean }
  | {
      readonly type:
        | 'confirm'
        | 'archive'
        | 'unarchive'
        | 'excludeFromReports'
        | 'includeInReports';
    };

export interface BulkTransactionCommand {
  readonly action: BulkAction;
  readonly targets: readonly {
    readonly id: string;
    readonly expectedVersion: number;
  }[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function parseAction(value: unknown): BulkAction | undefined {
  if (!record(value)) return undefined;
  const size = Object.keys(value).length;
  const { type, categoryId, payeeId, tagIds, targetType, extraordinary } =
    value;
  switch (type) {
    case 'confirm':
    case 'archive':
    case 'unarchive':
    case 'excludeFromReports':
    case 'includeInReports':
      return size === 1 ? { type } : undefined;
    case 'categorize':
      if (size === 2 && (categoryId === null || uuid(categoryId)))
        return { type, categoryId: categoryId?.toLowerCase() ?? null };
      break;
    case 'setPayee':
      if (size === 2 && (payeeId === null || uuid(payeeId)))
        return { type, payeeId: payeeId?.toLowerCase() ?? null };
      break;
    case 'tag':
      if (
        size === 2 &&
        Array.isArray(tagIds) &&
        tagIds.length > 0 &&
        tagIds.every(uuid)
      ) {
        const ids = tagIds.map((id) => id.toLowerCase());
        if (new Set(ids).size === ids.length) return { type, tagIds: ids };
      }
      break;
    case 'convertImported':
      if (size === 2 && (targetType === 'income' || targetType === 'expense'))
        return { type, targetType };
      break;
    case 'setExtraordinary':
      if (size === 2 && typeof extraordinary === 'boolean')
        return { type, extraordinary };
  }
  return undefined;
}

export function parseBulkTransactionCommand(
  body: unknown,
): BulkTransactionCommand | undefined {
  if (!record(body) || Object.keys(body).length !== 2) return undefined;
  const action = parseAction(body.action);
  const { targets } = body;
  if (
    !action ||
    !Array.isArray(targets) ||
    targets.length < 1 ||
    targets.length > 100
  )
    return undefined;

  const ids = new Set<string>();
  const normalized: BulkTransactionCommand['targets'][number][] = [];
  for (const target of targets as unknown[]) {
    if (!record(target) || Object.keys(target).length !== 2) return undefined;
    const { id, expectedVersion } = target;
    if (
      !uuid(id) ||
      typeof expectedVersion !== 'number' ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1
    )
      return undefined;
    const canonicalId = id.toLowerCase();
    if (ids.has(canonicalId)) return undefined;
    ids.add(canonicalId);
    normalized.push({ id: canonicalId, expectedVersion });
  }
  return { targets: normalized, action };
}
