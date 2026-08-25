import { UUID_PATTERN } from './uuid.js';

export interface PageInfo {
  readonly hasNextPage: boolean;
  readonly nextCursor: string | null;
}

export interface Cursor {
  readonly createdAt: string;
  readonly id: string;
  readonly workspaceId?: string;
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ISO_TIMESTAMP_PATTERN =
  /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export const MAX_CURSOR_LENGTH = 256;

export function encodeCursor(cursor: Cursor): string {
  const payload =
    cursor.workspaceId !== undefined
      ? [cursor.workspaceId, cursor.createdAt, cursor.id]
      : [cursor.createdAt, cursor.id];
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function isValidTimestamp(createdAt: string): boolean {
  if (!ISO_TIMESTAMP_PATTERN.test(createdAt)) {
    return false;
  }
  const parsedDate = new Date(createdAt);
  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 23) !== createdAt.slice(0, 23)
  ) {
    return false;
  }
  return true;
}

export function decodeCursor(
  raw: string,
  expectedWorkspaceId?: string,
): Cursor | undefined {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > MAX_CURSOR_LENGTH ||
    !BASE64URL_PATTERN.test(raw)
  ) {
    return undefined;
  }
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return undefined;
    if (json !== JSON.stringify(parsed)) {
      return undefined;
    }

    if (parsed.length === 2) {
      if (expectedWorkspaceId !== undefined) {
        return undefined;
      }
      const [createdAt, id] = parsed;
      if (typeof createdAt !== 'string' || typeof id !== 'string') {
        return undefined;
      }
      if (!isValidTimestamp(createdAt) || !UUID_PATTERN.test(id)) {
        return undefined;
      }
      return { createdAt, id };
    }

    if (parsed.length === 3) {
      // A caller that did not ask for a binding must not be handed a bound
      // cursor: what the decoder accepts has to equal what the encoder emits.
      // An unbound site emits two elements, so a three-element payload here is
      // a cursor minted somewhere else -- today only the member roster mints
      // bound ones, and replaying one at an unbound list merely shifts that
      // caller's own window, but accepting a shape we never emit is how the
      // binding quietly stops meaning anything.
      if (expectedWorkspaceId === undefined) {
        return undefined;
      }
      const [workspaceId, createdAt, id] = parsed;
      if (
        typeof workspaceId !== 'string' ||
        typeof createdAt !== 'string' ||
        typeof id !== 'string'
      ) {
        return undefined;
      }
      if (!UUID_PATTERN.test(workspaceId)) {
        return undefined;
      }
      if (workspaceId !== expectedWorkspaceId) {
        return undefined;
      }
      if (!isValidTimestamp(createdAt) || !UUID_PATTERN.test(id)) {
        return undefined;
      }
      return { createdAt, id, workspaceId };
    }

    return undefined;
  } catch {
    return undefined;
  }
}
