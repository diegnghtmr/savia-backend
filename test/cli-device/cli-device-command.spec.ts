import { describe, expect, it } from 'vitest';
import {
  createCliDeviceAuthorizationCommand,
  CliDeviceCommandValidationError,
} from '../../src/cli-device/cli-device-command.js';

describe('CLI device command', () => {
  it('accepts optional unique scopes and rejects unknown fields', () => {
    expect(
      createCliDeviceAuthorizationCommand({
        clientId: 'cli',
        scopes: ['read'],
      }),
    ).toEqual({ clientId: 'cli', scopes: ['read'] });
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
  });
});
