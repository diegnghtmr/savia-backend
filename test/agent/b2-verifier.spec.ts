import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OpenAICompatibleAgentProviderAdapter } from '../../src/agent/agent-provider.adapter.js';
import type { AgentCredentialResolver } from '../../src/agent/agent-message.port.js';

type Credential = NonNullable<Awaited<ReturnType<AgentCredentialResolver>>>;
const token = 'synthetic-bearer';
const base = 'https://provider.example.test/v1';
const invalidUrl = new Error('Invalid provider URL');
const frame = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const done = 'data: [DONE]\n\n';

function stream(baseUrl: string, overrides?: Partial<Credential>) {
  const adapter = new OpenAICompatibleAgentProviderAdapter(async () => ({
    baseUrl,
    model: 'demo',
    credentialType: 'gateway_token',
    secret: token,
    ...overrides,
  }));
  const chunks = adapter.stream(
    { message: 'prompt', modelRef: null, credentialId: null },
    new AbortController().signal,
    { subject: 'subject', workspaceId: 'workspace' },
  );
  return chunks[Symbol.asyncIterator]();
}

beforeEach(() => {
  const noNetwork = () => {
    throw new Error('Unexpected socket');
  };
  vi.spyOn(http, 'request').mockImplementation(noNetwork);
  vi.spyOn(https, 'request').mockImplementation(noNetwork);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const blockedPublic = [
  '127.0.0.1',
  '10.0.0.1',
  '172.16.0.1',
  '192.168.0.1',
  '100.127.0.1',
  '169.254.10.1',
  '0.0.0.0',
  '224.0.0.1',
  '255.255.255.255',
  '192.0.2.1',
  '198.19.0.1',
  '198.51.100.1',
  '203.0.113.1',
  '[::1]',
  '[fc00::1]',
  '[fe80::1]',
  '[::]',
  '[ff02::1]',
  '[2001:db8::1]',
  '[2001:2::1]',
  '[::ffff:7f00:1]',
  '[::a00:1]',
];
it.each(blockedPublic)(
  'blocks nonpublic HTTPS destination %s',
  async (host) => {
    const url = `https://${host}/v1`;
    const api = stream(url, { credentialType: 'api_key' });
    await expect(stream(url).next()).rejects.toThrow(invalidUrl);
    await expect(api.next()).rejects.toThrow(invalidUrl);
    expect(https.request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

const blockedLocal = [
  '169.254.0.1',
  '[fe80::1]',
  '[::ffff:a9fe:1]',
  '[fd00:ec2::254]',
  '0.0.0.0',
  '[ff02::1]',
];
it.each(blockedLocal)('blocks unsafe local endpoint %s', async (host) => {
  const response = stream(`http://${host}/v1`, {
    credentialType: 'local_endpoint',
    secret: null,
  });
  await expect(response.next()).rejects.toThrow(invalidUrl);
  expect(http.request).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

function answers(...ips: dns.LookupAddress[]) {
  const resolve = (
    host: string,
    options: dns.LookupOptions,
    callback: (error: null, addresses: dns.LookupAddress[]) => void,
  ) => {
    expect(host).toBe('provider.example.test');
    expect(options).toEqual({ all: true });
    callback(null, ips);
  };
  const lookup = vi.spyOn(dns, 'lookup');
  return lookup.mockImplementation(resolve as unknown as typeof dns.lookup);
}

function fakeHttps(body: string) {
  const connected = vi.fn();
  const makeRequest = (
    url: URL,
    options: https.RequestOptions,
    respond: (message: unknown) => void,
  ) => {
    const request = new EventEmitter();
    return Object.assign(request, {
      end() {
        expect(options.agent).toBe(false);
        if (!options.lookup) throw new Error('Missing socket lookup');
        options.lookup(url.hostname, { all: true }, (error, addresses) => {
          if (error) {
            request.emit('error', error);
            return;
          }
          connected(addresses, options.headers);
          const response = Object.assign(Readable.from([Buffer.from(body)]), {
            statusCode: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
          respond(response);
        });
      },
    });
  };
  const request = vi.spyOn(https, 'request');
  request.mockImplementation(makeRequest as unknown as typeof https.request);
  return connected;
}

it('rejects mixed DNS answers at socket lookup', async () => {
  const lookup = answers(
    { address: '1.1.1.1', family: 4 },
    { address: '127.0.0.1', family: 4 },
  );
  const connected = fakeHttps('');
  await expect(stream(base).next()).rejects.toThrow(invalidUrl);
  expect(lookup).toHaveBeenCalledOnce();
  expect(connected).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('uses vetted DNS results and sends the bearer unchanged', async () => {
  const address = { address: '2606:4700:4700::1111', family: 6 };
  const lookup = answers(address);
  const connected = fakeHttps(frame('safe text') + done);
  const response = stream(base);
  await expect(response.next()).resolves.toEqual({
    done: false,
    value: { type: 'text_delta', data: { text: 'safe text' } },
  });
  await expect(response.next()).resolves.toMatchObject({ done: true });
  expect(lookup).toHaveBeenCalledOnce();
  expect(connected).toHaveBeenCalledExactlyOnceWith(
    [address],
    expect.objectContaining({ Authorization: `Bearer ${token}` }),
  );
});

it('allows private DNS answers for explicit local endpoints', async () => {
  const address = { address: '192.168.0.1', family: 4 };
  answers(address);
  const connected = fakeHttps(done);
  const response = stream(base, {
    credentialType: 'local_endpoint',
    secret: null,
  });
  await expect(response.next()).resolves.toMatchObject({ done: true });
  expect(connected).toHaveBeenCalledOnce();
  expect(connected.mock.calls[0][0]).toEqual([address]);
  expect(connected.mock.calls[0][1]).not.toHaveProperty('Authorization');
});

it.each([` ${token}`, `${token} `, `${token}\u007f`])(
  'refuses an unusable bearer before dispatch',
  async (secret) => {
    const response = stream(base, { secret });
    await expect(response.next()).rejects.toThrow(new Error('Provider failed'));
    expect(https.request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each(['raw', 'wire'] as const)(
  'filters the %s bearer across deltas before yielding',
  async (encoding) => {
    const stored = 'synthetic-Ã©-bearer';
    const wire = Buffer.from(stored, 'latin1').toString('utf8');
    const echoed = encoding === 'raw' ? stored : wire;
    answers({ address: '1.1.1.1', family: 4 });
    fakeHttps(frame(echoed.slice(0, 11)) + frame(echoed.slice(11)));
    const response = stream(base, { secret: stored });
    await expect(response.next()).rejects.toThrow(
      new Error('Invalid provider stream'),
    );
  },
);
