export type IfMatchParse =
  | { readonly kind: 'absent' }
  | { readonly kind: 'any' } // the header was "*"
  | { readonly kind: 'versions'; readonly versions: readonly number[] }
  | { readonly kind: 'malformed' };

export function parseIfMatch(header: unknown): IfMatchParse {
  if (header === undefined) {
    return { kind: 'absent' };
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
  if (trimmed === '*') {
    return { kind: 'any' };
  }

  if (trimmed === '') {
    return { kind: 'malformed' };
  }

  // RFC 9110 defines If-Match = "*" / #entity-tag as a comma-separated list of entity-tags.
  // Leading zeros are rejected because RFC 9110 compares entity-tags by
  // octet equality: "007" is simply not "7", and parsing it as 7 would let
  // a client match a version it was never given. The int32 ceiling is not
  // cosmetic -- `version` is an integer column, and a larger value reaches
  // PostgreSQL as `value "100000000000000000000" is out of range for type
  // integer` (SQLSTATE 22003), which escapes to the filter's catch-all and
  // answers 500. A client-supplied header must never be able to do that.
  // Weak validators (e.g. W/"1") are malformed because RFC 9110 requires strong comparison.
  const parts = trimmed.split(',');
  const versions: number[] = [];

  for (const part of parts) {
    const item = part.trim();
    if (item === '') {
      return { kind: 'malformed' };
    }
    const match = /^"(0|[1-9][0-9]*)"$/.exec(item);
    if (!match) {
      return { kind: 'malformed' };
    }
    const num = Number(match[1]);
    if (num > 2_147_483_647) {
      return { kind: 'malformed' };
    }
    versions.push(num);
  }

  if (versions.length === 0) {
    return { kind: 'malformed' };
  }

  return {
    kind: 'versions',
    versions: Object.freeze(versions),
  };
}
