import { describe, expect, it } from 'vitest';
import {
  calculateBackoffDelay,
  classifyJobError,
  computeBackoffBase,
  isPermanentError,
  isTransientError,
  JOB_ERROR_CLASSIFICATIONS,
} from '../../src/platform/job-retry-policy.js';

describe('Job retry policy unit spec (S3)', () => {
  describe('Error classification', () => {
    it('classifies SQLSTATE class 22 (data exceptions) as permanent', () => {
      expect(classifyJobError({ code: '22001' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.PERMANENT,
      );
      expect(classifyJobError({ code: '22003' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.PERMANENT,
      );
      expect(classifyJobError({ code: '22P02' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.PERMANENT,
      );
      expect(isPermanentError({ code: '22001' })).toBe(true);
      expect(isTransientError({ code: '22001' })).toBe(false);
    });

    it('classifies SQLSTATE class 23 (integrity constraint violations) as permanent', () => {
      expect(classifyJobError({ code: '23505' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.PERMANENT,
      );
      expect(classifyJobError({ code: '23503' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.PERMANENT,
      );
      expect(classifyJobError({ code: '23514' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.PERMANENT,
      );
      expect(isPermanentError({ code: '23505' })).toBe(true);
    });

    it('classifies SQLSTATE class 42 (syntax error / access rule violations) as permanent', () => {
      expect(classifyJobError({ code: '42501' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.PERMANENT,
      );
      expect(classifyJobError({ code: '42601' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.PERMANENT,
      );
      expect(classifyJobError({ code: '42P01' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.PERMANENT,
      );
      expect(isPermanentError({ code: '42501' })).toBe(true);
    });

    it('classifies SQLSTATE P0001 (raise_exception wrapper refusals) as permanent', () => {
      expect(classifyJobError({ code: 'P0001' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.PERMANENT,
      );
      expect(isPermanentError({ code: 'P0001' })).toBe(true);
    });

    it('classifies SQLSTATE class 08 (connection exceptions) as transient', () => {
      expect(classifyJobError({ code: '08000' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(classifyJobError({ code: '08003' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(classifyJobError({ code: '08006' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(isTransientError({ code: '08006' })).toBe(true);
      expect(isPermanentError({ code: '08006' })).toBe(false);
    });

    it('classifies SQLSTATE class 53 (insufficient resources) as transient', () => {
      expect(classifyJobError({ code: '53000' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(classifyJobError({ code: '53100' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(classifyJobError({ code: '53200' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(classifyJobError({ code: '53300' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(isTransientError({ code: '53000' })).toBe(true);
    });

    it('classifies concurrency and transient SQLSTATE codes (40001, 40P01, 55P03, 57014) as transient', () => {
      expect(classifyJobError({ code: '40001' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(classifyJobError({ code: '40P01' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(classifyJobError({ code: '55P03' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(classifyJobError({ code: '57014' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(isTransientError({ code: '40001' })).toBe(true);
      expect(isTransientError({ code: '40P01' })).toBe(true);
      expect(isTransientError({ code: '55P03' })).toBe(true);
      expect(isTransientError({ code: '57014' })).toBe(true);
    });

    it('classifies TransactionTimeoutError and wrapped causes as transient', () => {
      expect(classifyJobError({ name: 'TransactionTimeoutError' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(
        classifyJobError({
          name: 'TransactionAcquisitionTimeoutError',
        }),
      ).toBe(JOB_ERROR_CLASSIFICATIONS.TRANSIENT);
      expect(
        classifyJobError(
          new Error('Wrapped failure', { cause: { code: '40001' } }),
        ),
      ).toBe(JOB_ERROR_CLASSIFICATIONS.TRANSIENT);
      expect(
        classifyJobError(
          new Error('Wrapped storage failure', { cause: { status: 503 } }),
        ),
      ).toBe(JOB_ERROR_CLASSIFICATIONS.TRANSIENT);
    });

    it('classifies storage 4xx errors as permanent (except 429)', () => {
      expect(classifyJobError({ status: 400 })).toBe(
        JOB_ERROR_CLASSIFICATIONS.PERMANENT,
      );
      expect(classifyJobError({ status: 401 })).toBe(
        JOB_ERROR_CLASSIFICATIONS.PERMANENT,
      );
      expect(classifyJobError({ status: 403 })).toBe(
        JOB_ERROR_CLASSIFICATIONS.PERMANENT,
      );
      expect(classifyJobError({ status: 404 })).toBe(
        JOB_ERROR_CLASSIFICATIONS.PERMANENT,
      );
      expect(classifyJobError({ statusCode: 404 })).toBe(
        JOB_ERROR_CLASSIFICATIONS.PERMANENT,
      );
      expect(classifyJobError({ status: 422 })).toBe(
        JOB_ERROR_CLASSIFICATIONS.PERMANENT,
      );
    });

    it('classifies storage 429 and 5xx errors as transient', () => {
      expect(classifyJobError({ status: 429 })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(classifyJobError({ statusCode: 429 })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(classifyJobError({ status: 500 })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(classifyJobError({ status: 502 })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(classifyJobError({ status: 503 })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(classifyJobError({ status: 504 })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(classifyJobError({ statusCode: 503 })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
    });

    it('classifies network error codes as transient', () => {
      expect(classifyJobError({ code: 'ECONNRESET' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(classifyJobError({ code: 'ETIMEDOUT' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(classifyJobError({ code: 'ECONNREFUSED' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
    });

    it('classifies typed domain errors and invalid payload as permanent', () => {
      class DomainError extends Error {
        public readonly isDomainError = true;
      }
      expect(classifyJobError(new DomainError('Domain rule violated'))).toBe(
        JOB_ERROR_CLASSIFICATIONS.PERMANENT,
      );
      expect(isPermanentError(new DomainError('Domain rule violated'))).toBe(
        true,
      );
      expect(isTransientError(new DomainError('Domain rule violated'))).toBe(
        false,
      );

      class InvalidPayloadError extends Error {
        public readonly code = 'invalid_payload';
      }
      expect(
        classifyJobError(new InvalidPayloadError('Bad JSON payload')),
      ).toBe(JOB_ERROR_CLASSIFICATIONS.PERMANENT);
      expect(classifyJobError({ code: 'INVALID_PAYLOAD' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.PERMANENT,
      );
      expect(isPermanentError({ code: 'invalid_payload' })).toBe(true);
    });

    it('classifies unknown failures, network variants, and general pg pool errors as transient', () => {
      // EPIPE, ENOTFOUND, EAI_AGAIN
      expect(classifyJobError({ code: 'EPIPE' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(classifyJobError({ code: 'ENOTFOUND' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      expect(classifyJobError({ code: 'EAI_AGAIN' })).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );

      // AbortError
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      expect(classifyJobError(abortError)).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );

      // Plain new Error('boom')
      expect(classifyJobError(new Error('boom'))).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );

      // Wrapped error whose cause is an unknown error
      const wrappedUnknown = new Error('Top-level worker error', {
        cause: new Error('boom'),
      });
      expect(classifyJobError(wrappedUnknown)).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );

      // Pg pool error that is not the known acquisition timeout
      const poolTerminationError = new Error(
        'Connection terminated unexpectedly',
      );
      expect(classifyJobError(poolTerminationError)).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
      const serverClosedError = new Error(
        'server closed the connection unexpectedly',
      );
      expect(classifyJobError(serverClosedError)).toBe(
        JOB_ERROR_CLASSIFICATIONS.TRANSIENT,
      );
    });

    it('classifies two-level nested permanent cause (e.g. 23505) as permanent', () => {
      const inner = { code: '23505' };
      const middle = new Error('Database query failed', { cause: inner });
      const outer = new Error('Service operation failed', { cause: middle });
      expect(classifyJobError(outer)).toBe(JOB_ERROR_CLASSIFICATIONS.PERMANENT);
      expect(isPermanentError(outer)).toBe(true);
    });

    it('classifies outer transient code (ECONNRESET) wrapping permanent cause (42501) as permanent', () => {
      const inner = { code: '42501' };
      const outer = Object.assign(
        new Error('Connection error during migration'),
        {
          code: 'ECONNRESET',
          cause: inner,
        },
      );
      expect(classifyJobError(outer)).toBe(JOB_ERROR_CLASSIFICATIONS.PERMANENT);
      expect(isPermanentError(outer)).toBe(true);
    });

    it('classifies nested storage 404 as permanent', () => {
      const inner = { status: 404 };
      const middle = new Error('Storage client error', { cause: inner });
      const outer = new Error('Asset download failed', { cause: middle });
      expect(classifyJobError(outer)).toBe(JOB_ERROR_CLASSIFICATIONS.PERMANENT);
      expect(isPermanentError(outer)).toBe(true);
    });

    it('terminates and classifies cyclic chains deterministically without infinite loop', () => {
      let aCauseReads = 0;
      const a = new Error('Cycle node A') as Error & { cause?: unknown };
      const b = new Error('Cycle node B') as Error & { cause?: unknown };
      Object.defineProperty(a, 'cause', {
        get() {
          aCauseReads++;
          return b;
        },
      });
      b.cause = a;

      expect(classifyJobError(a)).toBe(JOB_ERROR_CLASSIFICATIONS.TRANSIENT);
      expect(aCauseReads).toBe(1);
      aCauseReads = 0;
      expect(isTransientError(a)).toBe(true);
      expect(aCauseReads).toBe(1);
    }, 500);

    it('stops traversal without throwing when chain exceeds maximum depth', () => {
      const root = new Error('Depth 0');
      let current = root;
      for (let i = 1; i <= 25; i++) {
        const next = new Error(`Depth ${i}`);
        (current as { cause?: unknown }).cause = next;
        current = next;
      }
      expect(() => classifyJobError(root)).not.toThrow();
      expect(classifyJobError(root)).toBe(JOB_ERROR_CLASSIFICATIONS.TRANSIENT);
    });
  });

  describe('Seeded equal-jitter exponential backoff', () => {
    it('computes exact base delay d = min(300, 5 * 2^(n-1)) seconds', () => {
      expect(computeBackoffBase(1)).toBe(5);
      expect(computeBackoffBase(2)).toBe(10);
      expect(computeBackoffBase(3)).toBe(20);
      expect(computeBackoffBase(4)).toBe(40);
      expect(computeBackoffBase(5)).toBe(80);
      expect(computeBackoffBase(6)).toBe(160);
      expect(computeBackoffBase(7)).toBe(300); // capped at 300
      expect(computeBackoffBase(8)).toBe(300);
      expect(computeBackoffBase(10)).toBe(300);
    });

    it('bounds delay in [d/2, d] for any attempt with seeded random values', () => {
      for (let attempt = 1; attempt <= 10; attempt++) {
        const d = computeBackoffBase(attempt);
        const minDelay = d / 2;
        const maxDelay = d;

        // Seed: 0 -> exactly d / 2
        const delayZero = calculateBackoffDelay(attempt, () => 0);
        expect(delayZero).toBe(minDelay);

        // Seed: 1 -> exactly d
        const delayOne = calculateBackoffDelay(attempt, () => 1);
        expect(delayOne).toBe(maxDelay);

        // Seed: 0.5 -> exactly (d/2 + d) / 2 = 0.75 * d
        const delayHalf = calculateBackoffDelay(attempt, () => 0.5);
        expect(delayHalf).toBe(minDelay + 0.5 * (maxDelay - minDelay));

        // Deterministic pseudo-random seeds covering [0, 1]
        for (let s = 0; s <= 100; s++) {
          const pseudoRandom = s / 100;
          const delay = calculateBackoffDelay(attempt, () => pseudoRandom);
          expect(delay).toBeGreaterThanOrEqual(minDelay);
          expect(delay).toBeLessThanOrEqual(maxDelay);
        }
      }
    });

    it('defaults to [d/2, d] range when random generator is omitted', () => {
      for (let attempt = 1; attempt <= 7; attempt++) {
        const d = computeBackoffBase(attempt);
        const delay = calculateBackoffDelay(attempt);
        expect(delay).toBeGreaterThanOrEqual(d / 2);
        expect(delay).toBeLessThanOrEqual(d);
      }
    });
  });
});
