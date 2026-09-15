import { describe, expect, it } from 'vitest';
import {
  createApprovalDecisionCommand,
  ApprovalCommandValidationError,
} from '../../src/approvals/approval-command.js';

describe('createApprovalDecisionCommand', () => {
  it('accepts a valid payload with argumentsHash and string reason', () => {
    const cmd = createApprovalDecisionCommand({
      argumentsHash: 'hash-abc-123',
      reason: 'Looks good to execute',
    });
    expect(cmd).toEqual({
      argumentsHash: 'hash-abc-123',
      reason: 'Looks good to execute',
    });
  });

  it('accepts a valid payload with argumentsHash and null reason', () => {
    const cmd = createApprovalDecisionCommand({
      argumentsHash: 'hash-abc-123',
      reason: null,
    });
    expect(cmd).toEqual({
      argumentsHash: 'hash-abc-123',
      reason: null,
    });
  });

  it('accepts a valid payload with argumentsHash and undefined reason', () => {
    const cmd = createApprovalDecisionCommand({
      argumentsHash: 'hash-abc-123',
    });
    expect(cmd).toEqual({
      argumentsHash: 'hash-abc-123',
      reason: null,
    });
  });

  it('accepts reason with exactly 500 astral emoji code points', () => {
    const emoji500 = '🚀'.repeat(500);
    expect([...emoji500].length).toBe(500);
    // Note: emoji500.length in UTF-16 code units is 1000!
    expect(emoji500.length).toBe(1000);

    const cmd = createApprovalDecisionCommand({
      argumentsHash: 'hash-abc-123',
      reason: emoji500,
    });
    expect(cmd.reason).toBe(emoji500);
  });

  it('rejects reason with 501 astral emoji code points with max-length violation', () => {
    const emoji501 = '🚀'.repeat(501);
    expect([...emoji501].length).toBe(501);

    expect(() =>
      createApprovalDecisionCommand({
        argumentsHash: 'hash-abc-123',
        reason: emoji501,
      }),
    ).toThrow(ApprovalCommandValidationError);

    try {
      createApprovalDecisionCommand({
        argumentsHash: 'hash-abc-123',
        reason: emoji501,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(ApprovalCommandValidationError);
      const err = e as ApprovalCommandValidationError;
      expect(err.violations.some((v) => v.field === 'reason')).toBe(true);
    }
  });

  it('rejects non-object body', () => {
    expect(() => createApprovalDecisionCommand(null)).toThrow(
      ApprovalCommandValidationError,
    );
    expect(() => createApprovalDecisionCommand('invalid')).toThrow(
      ApprovalCommandValidationError,
    );
    expect(() => createApprovalDecisionCommand([])).toThrow(
      ApprovalCommandValidationError,
    );
  });

  it('rejects payload with extra unknown fields', () => {
    expect(() =>
      createApprovalDecisionCommand({
        argumentsHash: 'hash-abc-123',
        extraField: true,
      }),
    ).toThrow(ApprovalCommandValidationError);
  });

  it('rejects missing or empty argumentsHash', () => {
    expect(() =>
      createApprovalDecisionCommand({
        reason: 'some reason',
      }),
    ).toThrow(ApprovalCommandValidationError);

    expect(() =>
      createApprovalDecisionCommand({
        argumentsHash: 12345,
      }),
    ).toThrow(ApprovalCommandValidationError);
  });
});
