import { describe, expect, it, vi } from 'vitest';
import { CliDeviceController } from '../../src/cli-device/cli-device.controller.js';

function reply() {
  return {
    status: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
    request: { id: 'trace', url: '/v1/cli/device/authorize' },
  };
}
describe('CliDeviceController', () => {
  it('maps valid requests to 200 without requiring an authorization header', async () => {
    const r = reply();
    const port = {
      authorize: vi.fn().mockResolvedValue({
        deviceCode: 'secret',
        userCode: 'ABCD2345',
        verificationUri: 'https://app.test/device',
        expiresIn: 600,
        interval: 5,
      }),
      poll: vi.fn(),
      approve: vi.fn(),
    };
    await new CliDeviceController(port).authorize(
      { clientId: 'cli' },
      { ip: '127.0.0.1' } as never,
      r as never,
    );
    expect(port.authorize).toHaveBeenCalledWith(
      { clientId: 'cli', scopes: [] },
      '127.0.0.1',
    );
    expect(r.status).toHaveBeenCalledWith(200);
  });
  it('maps validation to the declared 400 response', async () => {
    const r = reply();
    await new CliDeviceController({
      authorize: vi.fn(),
      poll: vi.fn(),
      approve: vi.fn(),
    }).authorize({}, { ip: '127.0.0.1' } as never, r as never);
    expect(r.status).toHaveBeenCalledWith(400);
  });
  it('does not distinguish an invalid poll from any authorization state', async () => {
    const r = reply();
    const port = {
      authorize: vi.fn(),
      poll: vi.fn().mockResolvedValue({ kind: 'invalid' as const }),
      approve: vi.fn(),
    };
    await new CliDeviceController(port).token(
      { clientId: 'client', deviceCode: 'code' },
      { ip: '127.0.0.1' } as never,
      r as never,
    );
    expect(r.status).toHaveBeenCalledWith(400);
    expect(r.send).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Authorization is pending, denied or expired.',
        status: 400,
      }),
    );
  });
  it('returns 204 for an approved session request', async () => {
    const r = reply();
    const port = {
      authorize: vi.fn(),
      poll: vi.fn(),
      approve: vi.fn().mockResolvedValue({ kind: 'approved' as const }),
    };
    await new CliDeviceController(port).approve(
      { userCode: 'abcd-2345' },
      {
        ip: '127.0.0.1',
        identity: { subject: 'subject', authMethod: 'session' },
      } as never,
      r as never,
    );
    expect(port.approve).toHaveBeenCalledWith('subject', {
      userCode: 'ABCD2345',
    });
    expect(r.status).toHaveBeenCalledWith(204);
  });
  it('uses one fixed problem for invalid approval outcomes', async () => {
    const r = reply();
    await new CliDeviceController({
      authorize: vi.fn(),
      poll: vi.fn(),
      approve: vi.fn().mockResolvedValue({ kind: 'invalid' as const }),
    }).approve(
      { userCode: 'ABCD2345' },
      {
        ip: '127.0.0.1',
        identity: { subject: 'subject', authMethod: 'session' },
      } as never,
      r as never,
    );
    expect(r.send).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'The user code is invalid or expired.',
        status: 400,
      }),
    );
  });
  it('rejects a CLI token from approving a device', async () => {
    const r = reply();
    await expect(
      new CliDeviceController({
        authorize: vi.fn(),
        poll: vi.fn(),
        approve: vi.fn(),
      }).approve(
        { userCode: 'ABCD2345' },
        {
          ip: '127.0.0.1',
          identity: { subject: 'subject', authMethod: 'cli_token' },
        } as never,
        r as never,
      ),
    ).rejects.toThrow('Forbidden');
  });
});
