import { once } from 'node:events';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExpoPushAdapter,
  ResendEmailAdapter,
} from '../../src/notifications/notification-providers.adapter.js';

const secret = 'fake-provider-secret';
const sender = 'Savia <notifications@example.test>';
const content = {
  title: 'Report ready',
  body: '<b>Budget summary</b>',
  idempotencyKey: 'notification/123',
};

let server: Server | undefined;
const requests: unknown[] = [];

async function fakeProvider(respond: (response: ServerResponse) => void) {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request as AsyncIterable<Buffer>)
      chunks.push(chunk);
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      key: request.headers['idempotency-key'],
      contentType: request.headers['content-type'],
      body: JSON.parse(Buffer.concat(chunks).toString()) as unknown,
    });
    respond(response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Missing loopback address');
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(() => {
  requests.length = 0;
  vi.stubEnv('SAVIA_EXPO_ACCESS_TOKEN', secret);
  vi.stubEnv('SAVIA_RESEND_API_KEY', secret);
  vi.stubEnv('SAVIA_NOTIFICATION_FROM_EMAIL', sender);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (server !== undefined) {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    server = undefined;
  }
});

const providers = [
  {
    name: 'Expo',
    Adapter: ExpoPushAdapter,
    message: { ...content, to: 'ExponentPushToken[fake]' },
    success: { data: { status: 'ok', id: 'ticket-1' } },
    path: '/--/api/v2/push/send',
    key: undefined,
    payload: {
      to: 'ExponentPushToken[fake]',
      title: content.title,
      body: content.body,
    },
  },
  {
    name: 'Resend',
    Adapter: ResendEmailAdapter,
    message: { ...content, to: 'user@example.test' },
    success: { id: 'email-1' },
    path: '/emails',
    key: content.idempotencyKey,
    payload: {
      from: sender,
      to: ['user@example.test'],
      subject: content.title,
      text: content.body,
    },
  },
];

describe.each(providers)(
  '$name',
  ({ Adapter, message, success, path, key, payload }) => {
    it('posts the expected payload and accepts a valid provider acknowledgement', async () => {
      const baseUrl = await fakeProvider((response) =>
        response.end(JSON.stringify({ ...success, echoed: secret })),
      );
      await expect(new Adapter({ baseUrl }).deliver(message)).resolves.toBe(
        'accepted',
      );
      expect(requests).toEqual([
        {
          method: 'POST',
          path,
          authorization: `Bearer ${secret}`,
          key,
          contentType: 'application/json',
          body: payload,
        },
      ]);
    });

    it.each([
      [400, 'rejected'],
      [401, 'rejected'],
      [408, 'retryable'],
      [429, 'retryable'],
      [503, 'retryable'],
    ])(
      'classifies HTTP %s without returning or logging response text',
      async (status, result) => {
        const baseUrl = await fakeProvider((response) =>
          response.writeHead(status).end(secret),
        );
        const stdout = vi.spyOn(process.stdout, 'write');
        const stderr = vi.spyOn(process.stderr, 'write');
        try {
          await expect(new Adapter({ baseUrl }).deliver(message)).resolves.toBe(
            result,
          );
          expect(stdout).not.toHaveBeenCalled();
          expect(stderr).not.toHaveBeenCalled();
          expect(requests).toHaveLength(1);
        } finally {
          stdout.mockRestore();
          stderr.mockRestore();
        }
      },
    );

    it('times out even after headers and the start of the body have arrived', async () => {
      const baseUrl = await fakeProvider((response) =>
        response.write('{"id":'),
      );
      await expect(
        new Adapter({ baseUrl, timeoutMs: 250 }).deliver(message),
      ).resolves.toBe('retryable');
      expect(requests).toHaveLength(1);
    });

    it('never follows redirects, even to the same origin', async () => {
      const baseUrl = await fakeProvider((response) =>
        response.writeHead(307, { location: '/redirect' }).end(),
      );
      await expect(new Adapter({ baseUrl }).deliver(message)).resolves.toBe(
        'rejected',
      );
      expect(requests).toHaveLength(1);
    });

    it('rejects an oversized streamed acknowledgement without buffering the whole response', async () => {
      const baseUrl = await fakeProvider((response) => {
        response.write(
          JSON.stringify({ ...success, padding: 'x'.repeat(32_768) }),
        );
        // No end: resolving promptly proves the byte limit, rather than JSON validation.
      });
      await expect(
        new Adapter({ baseUrl, timeoutMs: 3_000 }).deliver(message),
      ).resolves.toBe('rejected');
      expect(requests).toHaveLength(1);
    });

    it('retries a malformed success because provider acceptance is unknown', async () => {
      const baseUrl = await fakeProvider((response) => response.end('{'));
      await expect(new Adapter({ baseUrl }).deliver(message)).resolves.toBe(
        'retryable',
      );
      expect(requests).toHaveLength(1);
    });

    it.each([
      'http://192.0.2.10',
      `https://user:${secret}@example.test`,
      `not-a-url-${secret}`,
    ])('rejects unsafe URL configuration without echoing it', (baseUrl) => {
      expect(() => new Adapter({ baseUrl })).toThrow(
        'Notification provider base URL must use HTTPS without credentials.',
      );
    });

    it('rejects loopback HTTP outside the test environment', () => {
      vi.stubEnv('NODE_ENV', 'production');
      expect(() => new Adapter({ baseUrl: 'http://127.0.0.1:1234' })).toThrow(
        'Notification provider base URL must use HTTPS without credentials.',
      );
    });
  },
);

it.each([
  ['DeviceNotRegistered', 'rejected'],
  ['MessageRateExceeded', 'retryable'],
])(
  'classifies an Expo ticket error %s even on HTTP 200',
  async (error, result) => {
    const baseUrl = await fakeProvider((response) =>
      response.end(
        JSON.stringify({
          data: { status: 'error', message: secret, details: { error } },
        }),
      ),
    );
    await expect(
      new ExpoPushAdapter({ baseUrl }).deliver(providers[0].message),
    ).resolves.toBe(result);
    expect(requests).toHaveLength(1);
  },
);

it('does not contact Resend without an API key and sender', () => {
  vi.stubEnv('SAVIA_RESEND_API_KEY', undefined);
  expect(() => new ResendEmailAdapter()).toThrow(
    'Resend requires an API key and sender.',
  );
  vi.stubEnv('SAVIA_RESEND_API_KEY', secret);
  vi.stubEnv('SAVIA_NOTIFICATION_FROM_EMAIL', undefined);
  expect(() => new ResendEmailAdapter()).toThrow(
    'Resend requires an API key and sender.',
  );
});
