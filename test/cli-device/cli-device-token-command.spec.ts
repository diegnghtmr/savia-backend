import { describe, expect, it } from 'vitest';
import {
  CliDeviceTokenCommandValidationError,
  createCliDeviceTokenCommand,
} from '../../src/cli-device/cli-device-token-command.js';

describe('CLI device token command', () => {
  it('accepts exactly the required fields', () => {
    expect(
      createCliDeviceTokenCommand({ clientId: 'client', deviceCode: 'code' }),
    ).toEqual({
      clientId: 'client',
      deviceCode: 'code',
    });
  });
  it('rejects unknown and empty fields with code-point validation', () => {
    expect(() =>
      createCliDeviceTokenCommand({
        clientId: '',
        deviceCode: 'x',
        extra: true,
      }),
    ).toThrow(CliDeviceTokenCommandValidationError);
    try {
      createCliDeviceTokenCommand({
        clientId: '',
        deviceCode: 'x',
        extra: true,
      });
    } catch (error) {
      expect(
        (error as CliDeviceTokenCommandValidationError).violations.map(
          ({ field }) => field,
        ),
      ).toEqual(['clientId', 'extra']);
    }
  });
});
