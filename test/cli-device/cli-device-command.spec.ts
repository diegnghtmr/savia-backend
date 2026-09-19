import { describe, expect, it } from 'vitest';
import {
  createCliDeviceAuthorizationCommand,
  CliDeviceCommandValidationError,
} from '../../src/cli-device/cli-device-command.js';
import { createCliDeviceApprovalCommand } from '../../src/cli-device/cli-device-approval-command.js';
import { SAVIA_SCOPES } from '../../src/platform/savia-scopes.js';

describe('CLI device command', () => {
  it('accepts optional unique scopes and rejects unknown fields', () => {
    expect(
      createCliDeviceAuthorizationCommand({
        clientId: 'cli',
        scopes: [SAVIA_SCOPES.ACCOUNTS_READ],
      }),
    ).toEqual({ clientId: 'cli', scopes: [SAVIA_SCOPES.ACCOUNTS_READ] });
    expect(() =>
      createCliDeviceAuthorizationCommand({ clientId: 'cli', extra: true }),
    ).toThrow(CliDeviceCommandValidationError);
  });
  it('rejects missing client IDs, invalid scopes, and duplicates', () => {
    expect(() =>
      createCliDeviceAuthorizationCommand({ scopes: [1] }),
    ).toThrowError(/validation/);
    expect(() =>
      createCliDeviceAuthorizationCommand({
        clientId: 'cli',
        scopes: ['read', 'read'],
      }),
    ).toThrowError(/validation/);
    expect(() =>
      createCliDeviceAuthorizationCommand({
        clientId: 'cli',
        scopes: ['unknown:scope'],
      }),
    ).toThrowError(/validation/);
  });
  it('reports violations at original indices for non-string and unknown scopes', () => {
    try {
      createCliDeviceAuthorizationCommand({
        clientId: 'cli',
        scopes: [42, 'bogus:scope'],
      });
      expect.unreachable('should have thrown CliDeviceCommandValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(CliDeviceCommandValidationError);
      expect((error as CliDeviceCommandValidationError).violations).toEqual([
        {
          code: 'invalid-type',
          field: 'scopes[0]',
          message: 'must be a string',
        },
        {
          code: 'invalid-value',
          field: 'scopes[1]',
          message: 'must be a valid Savia scope',
        },
      ]);
    }
  });
  it('normalizes approval codes by ignoring case, hyphens, and whitespace', () => {
    expect(createCliDeviceApprovalCommand({ userCode: ' abcd-2345 ' })).toEqual(
      { userCode: 'ABCD2345' },
    );
  });
});
