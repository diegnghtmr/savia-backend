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
    await new CliDeviceController({ authorize: vi.fn() }).authorize(
      {},
      { ip: '127.0.0.1' } as never,
      r as never,
    );
    expect(r.status).toHaveBeenCalledWith(400);
  });
});
