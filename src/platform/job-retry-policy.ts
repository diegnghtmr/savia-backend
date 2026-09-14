export const JOB_ERROR_CLASSIFICATIONS = {
  TRANSIENT: 'transient',
  PERMANENT: 'permanent',
} as const;

export type JobErrorClassification =
  (typeof JOB_ERROR_CLASSIFICATIONS)[keyof typeof JOB_ERROR_CLASSIFICATIONS];

const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '57014', // query_canceled
]);

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
]);

interface ErrorLike {
  readonly code?: unknown;
  readonly status?: unknown;
  readonly statusCode?: unknown;
  readonly [key: string]: unknown;
}

export function isTransientError(error: unknown): boolean {
  return classifyJobError(error) === JOB_ERROR_CLASSIFICATIONS.TRANSIENT;
}

export function isPermanentError(error: unknown): boolean {
  return classifyJobError(error) === JOB_ERROR_CLASSIFICATIONS.PERMANENT;
}

export function classifyJobError(error: unknown): JobErrorClassification {
  if (error === null || typeof error !== 'object') {
    return JOB_ERROR_CLASSIFICATIONS.PERMANENT;
  }

  const err = error as ErrorLike;

  if (
    err.name === 'TransactionTimeoutError' ||
    err.name === 'TransactionAcquisitionTimeoutError'
  ) {
    return JOB_ERROR_CLASSIFICATIONS.TRANSIENT;
  }

  const candidate =
    typeof err.code === 'string' ||
    err.status !== undefined ||
    err.statusCode !== undefined
      ? err
      : ((err.cause as ErrorLike | undefined) ?? err);

  // 1. SQLSTATE code inspection
  if (typeof candidate.code === 'string') {
    const code = candidate.code.trim().toUpperCase();

    // SQLSTATE classes: 08 (connection) and 53 (insufficient resources)
    if (code.startsWith('08') || code.startsWith('53')) {
      return JOB_ERROR_CLASSIFICATIONS.TRANSIENT;
    }

    // Explicit transient SQLSTATE codes
    if (TRANSIENT_SQLSTATES.has(code)) {
      return JOB_ERROR_CLASSIFICATIONS.TRANSIENT;
    }

    // Network error codes
    if (TRANSIENT_NETWORK_CODES.has(code)) {
      return JOB_ERROR_CLASSIFICATIONS.TRANSIENT;
    }

    // Explicit permanent SQLSTATE classes / codes:
    // class 22 (data exception), class 23 (integrity constraint),
    // class 42 (syntax / access), P0001 (raise_exception wrapper refusals)
    if (
      code.startsWith('22') ||
      code.startsWith('23') ||
      code.startsWith('42') ||
      code === 'P0001'
    ) {
      return JOB_ERROR_CLASSIFICATIONS.PERMANENT;
    }
  }

  // 2. HTTP / Storage status code inspection
  const rawStatus = candidate.status ?? candidate.statusCode;
  if (typeof rawStatus === 'number' || typeof rawStatus === 'string') {
    const statusNum = Number(rawStatus);
    if (!Number.isNaN(statusNum)) {
      if (statusNum === 429) {
        return JOB_ERROR_CLASSIFICATIONS.TRANSIENT;
      }
      if (statusNum >= 500 && statusNum <= 599) {
        return JOB_ERROR_CLASSIFICATIONS.TRANSIENT;
      }
      if (statusNum >= 400 && statusNum < 500) {
        return JOB_ERROR_CLASSIFICATIONS.PERMANENT;
      }
    }
  }

  // Typed domain errors, invalid payload, and arbitrary unclassified errors
  return JOB_ERROR_CLASSIFICATIONS.PERMANENT;
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
