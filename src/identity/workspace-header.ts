export type WorkspaceHeaderParse =
  | { readonly kind: 'ok'; readonly workspaceId: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed' };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Épica 2 moved the workspace from a path parameter to a required header. This
// parser mirrors if-match.ts's discipline: unknown shapes are malformed, an
// empty value is malformed, and repeated values are joined and then fail the
// uuid check so a duplicated header can never silently pick one. Missing and
// malformed stay distinct kinds because callers may want different problem
// detail messages; both are transport failures answered with 400.
export function parseWorkspaceHeader(header: unknown): WorkspaceHeaderParse {
  if (header === undefined) {
    return { kind: 'missing' };
  }

  let raw: string;
  if (typeof header === 'string') {
    raw = header;
  } else if (
    Array.isArray(header) &&
    header.length > 0 &&
    header.every((item) => typeof item === 'string')
  ) {
    raw = header.join(', ');
  } else {
    return { kind: 'malformed' };
  }

  const trimmed = raw.trim();
  if (trimmed === '' || !UUID_PATTERN.test(trimmed)) {
    return { kind: 'malformed' };
  }

  return { kind: 'ok', workspaceId: trimmed.toLowerCase() };
}
