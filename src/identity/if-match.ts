export type IfMatchParse =
  | { readonly kind: 'absent' }
  | { readonly kind: 'any' } // the header was "*"
  | { readonly kind: 'version'; readonly version: number }
  | { readonly kind: 'malformed' };

export function parseIfMatch(header: unknown): IfMatchParse {
  if (header === undefined) {
    return { kind: 'absent' };
  }

  if (typeof header !== 'string') {
    return { kind: 'malformed' };
  }

  const trimmed = header.trim();
  if (trimmed === '*') {
    return { kind: 'any' };
  }

  // Leading zeros are rejected because RFC 9110 compares entity-tags by
  // octet equality: "007" is simply not "7", and parsing it as 7 would let
  // a client match a version it was never given. The int32 ceiling is not
  // cosmetic -- `version` is an integer column, and a larger value reaches
  // PostgreSQL as `value "100000000000000000000" is out of range for type
  // integer` (SQLSTATE 22003), which escapes to the filter's catch-all and
  // answers 500. A client-supplied header must never be able to do that.
  const match = /^"(0|[1-9][0-9]*)"$/.exec(trimmed);
  if (!match || Number(match[1]) > 2_147_483_647) {
    return { kind: 'malformed' };
  }

  return {
    kind: 'version',
    version: Number.parseInt(match[1], 10),
  };
}
