export const JOB_ERROR_CLASSIFICATIONS = {
  TRANSIENT: 'transient',
  PERMANENT: 'permanent',
} as const;

export type JobErrorClassification =
  (typeof JOB_ERROR_CLASSIFICATIONS)[keyof typeof JOB_ERROR_CLASSIFICATIONS];

export const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '57014', // query_canceled
]);

export const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

interface ErrorLike {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly status?: unknown;
  readonly statusCode?: unknown;
  readonly isDomainError?: unknown;
  readonly [key: string]: unknown;
}

export function isTransientError(error: unknown): boolean {
  return classifyJobError(error) === JOB_ERROR_CLASSIFICATIONS.TRANSIENT;
}

export function isPermanentError(error: unknown): boolean {
  return classifyJobError(error) === JOB_ERROR_CLASSIFICATIONS.PERMANENT;
}

const MAX_CAUSE_DEPTH = 10;

function isLevelPermanent(err: ErrorLike): boolean {
  // 1. Explicit domain and payload permanent errors
  if (err.isDomainError) {
    return true;
  }

  // 2. SQLSTATE code inspection and explicit codes:
  // class 22 (data exception), class 23 (integrity constraint),
  // class 42 (syntax / access), P0001 (raise_exception wrapper refusals),
  // invalid_payload
  if (typeof err.code === 'string') {
    const code = err.code.trim().toUpperCase();
    if (
      code.startsWith('22') ||
      code.startsWith('23') ||
      code.startsWith('42') ||
      code === 'P0001' ||
      code === 'INVALID_PAYLOAD'
    ) {
      return true;
    }
  }

  // 3. HTTP / Storage status code inspection: storage 4xx except 429
  const rawStatus = err.status ?? err.statusCode;
  if (typeof rawStatus === 'number' || typeof rawStatus === 'string') {
    const statusNum = Number(rawStatus);
    if (!Number.isNaN(statusNum)) {
      if (statusNum >= 400 && statusNum < 500 && statusNum !== 429) {
        return true;
      }
    }
  }

  return false;
}

export function classifyJobError(error: unknown): JobErrorClassification {
  if (error === null || typeof error !== 'object') {
    return JOB_ERROR_CLASSIFICATIONS.TRANSIENT;
  }

  const visited = new Set<object>();
  let current: unknown = error;
  let depth = 0;

  while (
    current !== null &&
    typeof current === 'object' &&
    depth < MAX_CAUSE_DEPTH
  ) {
    if (visited.has(current)) {
      break;
    }
    visited.add(current);

    const err = current as ErrorLike;
    if (isLevelPermanent(err)) {
      return JOB_ERROR_CLASSIFICATIONS.PERMANENT;
    }

    current = 'cause' in err ? err.cause : undefined;
    depth++;
  }

  return JOB_ERROR_CLASSIFICATIONS.TRANSIENT;
}

export function computeBackoffBase(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(300, 5 * Math.pow(2, exponent));
}

export function calculateBackoffDelay(
  attempt: number,
  randomGenerator: () => number = Math.random,
): number {
  const d = computeBackoffBase(attempt);
  const minDelay = d / 2;
  const maxDelay = d;
  const random = Math.max(0, Math.min(1, randomGenerator()));
  return minDelay + random * (maxDelay - minDelay);
}
