import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenAICompatibleAgentProviderAdapter } from '../../src/agent/agent-provider.adapter.js';
import type { AgentCredentialResolver } from '../../src/agent/agent-message.port.js';

const secret = 'synthetic-provider-key';
const command = { message: 'hola', modelRef: null, credentialId: null };
const context = { subject: 'subject', workspaceId: 'workspace' };
const headers = { 'Content-Type': 'text/event-stream' };
const frame = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const done = 'data: [DONE]\n\n';
let server: ReturnType<typeof createServer> | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (!server) return;
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
  server = undefined;
});

async function listen(listener: RequestListener) {
  server = createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP port');
  return `http://127.0.0.1:${address.port}/v1/`;
}

function resolveAt(
  baseUrl: string,
  credentialType: 'local_endpoint' | 'gateway_token' = 'local_endpoint',
): AgentCredentialResolver {
  return async () => ({
    baseUrl,
    model: 'demo',
    credentialType,
    secret: credentialType === 'local_endpoint' ? null : secret,
  });
}
const stream = (
  resolve: AgentCredentialResolver,
  timeout = 2_000,
  signal = new AbortController().signal,
) =>
  new OpenAICompatibleAgentProviderAdapter(resolve, timeout).stream(
    command,
    signal,
    context,
  );

async function collect(resolve: AgentCredentialResolver) {
  const events = [];
  for await (const event of stream(resolve)) events.push(event);
  return events;
}

it.each(['local_endpoint'] as const)(
  'sends the workspace model and streams fragmented SSE for %s',
  async (credentialType) => {
    let sendRest!: () => void;
    const request = Promise.withResolvers<unknown>();
    const baseUrl = await listen((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        request.resolve([
          req.method,
          req.url,
          req.headers.authorization,
          JSON.parse(body),
        ]);
        res.writeHead(200, headers);
        const bytes = Buffer.from(
          ': keepalive\r\n\r\n' + frame('🧪').replaceAll('\n', '\r\n'),
        );
        const split = bytes.indexOf(Buffer.from('🧪')) + 1;
        res.write(bytes.subarray(0, split));
        setImmediate(() => res.write(bytes.subarray(split)));
        const rest = 'data: {"choices":[]}\n\n' + frame('!') + done;
        sendRest = () => res.end(rest);
      });
    });
    const resolve = vi.fn<AgentCredentialResolver>(async () => ({
      baseUrl,
      model: 'model:variant',
      credentialType,
      secret: null,
    }));
    const events = [];
    for await (const event of stream(resolve)) {
      events.push(event);
      if (events.length === 1) sendRest();
    }
    expect(events).toEqual([
      { type: 'text_delta', data: { text: '🧪' } },
      { type: 'text_delta', data: { text: '!' } },
    ]);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(
      context.subject,
      context.workspaceId,
    );
    expect(await request.promise).toEqual([
      'POST',
      '/v1/chat/completions',
      undefined,
      {
        model: 'model:variant',
        stream: true,
        messages: [{ role: 'user', content: 'hola' }],
      },
    ]);
  },
);

it.each([
  [401, secret, 'Provider HTTP 401'],
  [429, secret, 'Provider HTTP 429'],
  [500, secret, 'Provider HTTP 500'],
  [200, `data: ${secret}\n\n`, 'Invalid provider stream'],
  [
    200,
    `data: {"error":{"message":"${secret}"}}\n\n`,
    'Invalid provider stream',
  ],
  [200, 'data: {"choices":[]}\n\n', 'Incomplete provider stream'],
  [200, ' '.repeat(1024 * 1024 + 1), 'Provider response too large'],
] as const)(
  'rejects provider response %# without leaking credentials',
  async (status, body, message) => {
    const baseUrl = await listen((_req, res) =>
      res.writeHead(status, headers).end(body),
    );
    await expect(
      stream(resolveAt(baseUrl))[Symbol.asyncIterator]().next(),
    ).rejects.toThrow(new Error(message));
  },
);

it('rejects remote cleartext and does not follow redirects', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Unexpected fetch'));
  try {
    for (const base of ['http://127.example.test/v1', 'http://127.0.0.1/v1']) {
      const result = collect(resolveAt(base, 'gateway_token'));
      await expect(result).rejects.toThrow('Invalid provider URL');
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
  const requests = vi.fn();
  const baseUrl = await listen((req, res) => {
    requests(req.url);
    res.writeHead(307, { Location: '/other' }).end();
  });
  const failure = collect(resolveAt(baseUrl));
  await expect(failure).rejects.toThrow('Provider HTTP 307');
  expect(requests.mock.calls).toEqual([['/v1/chat/completions']]);
});

it.each(['timeout', 'abort'] as const)(
  'closes an open SSE response on %s',
  async (mode) => {
    const closed = Promise.withResolvers<void>();
    const baseUrl = await listen((_req, res) => {
      res.once('close', closed.resolve);
      res.writeHead(200, headers).write(frame('first'));
    });
    const controller = new AbortController();
    const consume = async () => {
      const timeout = mode === 'timeout' ? 500 : 2_000;
      for await (const event of stream(
        resolveAt(baseUrl),
        timeout,
        controller.signal,
      )) {
        expect(event).toEqual({ type: 'text_delta', data: { text: 'first' } });
        if (mode === 'abort') controller.abort(new Error(secret));
      }
    };
    const message =
      mode === 'timeout' ? 'Provider timed out' : 'Provider aborted';
    await expect(consume()).rejects.toThrow(new Error(message));
    await closed.promise;
  },
);

it.each(['test', 'development', 'production'])(
  'uses echo only for an unconfigured test/dev provider (%s)',
  async (env) => {
    vi.stubEnv('NODE_ENV', env);
    const result = collect(async () => null);
    const echo = [{ type: 'text_delta', data: { text: 'hola' } }];
    const missing = 'No workspace AI credential configured';
    if (env === 'production') await expect(result).rejects.toThrow(missing);
    else expect(await result).toEqual(echo);
  },
);
