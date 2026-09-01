import { describe, expect, it } from 'vitest';
import {
  JobQueryValidationError,
  validateJobId,
} from '../../src/jobs/job-query.js';

describe('Job query validation', () => {
  it('accepts a valid UUID and normalizes to lower case', () => {
    const validUuid = 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11';
    const result = validateJobId(validUuid);
    expect(result).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
  });

  it('accepts a valid UUID with leading and trailing whitespace', () => {
    const validUuidWithSpaces = '  00000000-0000-0000-0000-000000000001  ';
    const result = validateJobId(validUuidWithSpaces);
    expect(result).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('rejects non-string inputs', () => {
    for (const input of [123, null, undefined, {}, []]) {
      expect(() => validateJobId(input)).toThrow(JobQueryValidationError);
      try {
        validateJobId(input);
      } catch (error) {
        expect(error).toBeInstanceOf(JobQueryValidationError);
        const err = error as JobQueryValidationError;
        expect(err.violations).toEqual([
          {
            field: 'jobId',
            code: 'invalid',
            message: 'jobId must be a valid UUID.',
          },
        ]);
      }
    }
  });

  it('rejects malformed UUID strings', () => {
    for (const input of [
      '',
      '   ',
      'not-a-uuid',
      '00000000-0000-0000-0000-00000000000',
      '00000000-0000-0000-0000-0000000000000',
      '00000000-0000-0000-0000-00000000000g',
      '00000000_0000_0000_0000_000000000000',
    ]) {
      expect(() => validateJobId(input)).toThrow(JobQueryValidationError);
    }
  });
});
