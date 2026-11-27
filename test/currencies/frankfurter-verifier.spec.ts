import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { FrankfurterFxAdapter } from '../../src/currencies/frankfurter-fx.adapter.js';
import { FrankfurterRateJob } from '../../src/currencies/frankfurter-rate-job.js';

it('S10: aborts an open response on stop and discards a previously successful base', async () => {
  let entered!: () => void;
  let disconnected!: () => void;
  const open = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    if (request.url === '/currencies') {
      response.end('{"EUR":"Euro","GBP":"Pound","USD":"Dollar"}');
      return;
    }
    if (request.url === '/latest?from=EUR&to=USD') {
      response.end(
        '{"amount":1,"base":"EUR","date":"2026-08-31","rates":{"USD":1.00100000000000008900}}',
      );
      return;
    }
    response.on('close', disconnected);
    response.write('{');
    entered();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected loopback address');
  const append = vi.fn();
  const job = new FrankfurterRateJob(
    new FrankfurterFxAdapter(`http://127.0.0.1:${address.port}`, 30_000),
    {
      listPairs: async () =>
        ['EUR', 'GBP'].map((base_currency) => ({
          workspace_id: 'a',
          base_currency,
          quote_currency: 'USD',
        })),
      append,
    },
  );
  try {
    job.start();
    await open;
    await job.stop();
    await closed;
    expect(requests).toEqual([
      '/currencies',
      '/latest?from=EUR&to=USD',
      '/currencies',
      '/latest?from=GBP&to=USD',
    ]);
    expect(append).not.toHaveBeenCalled();
  } finally {
    await job.stop();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}, 3_000);

it('S10: the production configuration cannot opt into a plaintext provider', async () => {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits++;
    response.end('{"EUR":"Euro"}');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected loopback address');
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('SAVIA_FRANKFURTER_BASE_URL', `http://127.0.0.1:${address.port}`);
  try {
    const outcome = await Promise.resolve()
      .then(() =>
        new FrankfurterFxAdapter(process.env.SAVIA_FRANKFURTER_BASE_URL).latest(
          'EUR',
          ['USD'],
        ),
      )
      .then(
        () => 'resolved',
        () => 'rejected',
      );
    expect({ hits, outcome }).toEqual({ hits: 0, outcome: 'rejected' });
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

it.each([
  ['test', 'http://example.test', false],
  ['test', 'http://localhost.example.test', false],
  ['test', 'http://[::1]:3210', true],
  ['development', 'http://localhost:3210', false],
  ['production', 'https://example.test', true],
])('S10: %s provider URL policy for %s', (env, url, allowed) => {
  vi.stubEnv('NODE_ENV', env);
  try {
    const construct = () => new FrankfurterFxAdapter(url);
    if (allowed) expect(construct).not.toThrow();
    else expect(construct).toThrow(/^Frankfurter base URL must use https\.$/);
  } finally {
    vi.unstubAllEnvs();
  }
});
