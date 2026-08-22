export interface IdempotencyKeyValid {
  readonly kind: 'ok';
  readonly key: string;
}

export interface IdempotencyKeyInvalid {
  readonly kind: 'invalid';
  readonly reason: string;
}

export type IdempotencyKeyResult = IdempotencyKeyValid | IdempotencyKeyInvalid;

export function validateIdempotencyKey(input: unknown): IdempotencyKeyResult {
  if (typeof input !== 'string') {
    return {
      kind: 'invalid',
      reason: 'Idempotency-Key must be a string.',
    };
  }

  if (input.includes('\0')) {
    return {
      kind: 'invalid',
      reason: 'Idempotency-Key must not contain NUL characters.',
    };
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return {
      kind: 'invalid',
      reason: 'Idempotency-Key must be a non-empty string.',
    };
  }

  if (trimmed.length > 255) {
    return {
      kind: 'invalid',
      reason: 'Idempotency-Key must be at most 255 characters.',
    };
  }

  return {
    kind: 'ok',
    key: trimmed,
  };
}
