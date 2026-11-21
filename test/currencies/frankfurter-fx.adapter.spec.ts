import { once } from 'node:events';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FrankfurterFxAdapter } from '../../src/currencies/frankfurter-fx.adapter.js';
import { isFxRateStale } from '../../src/currencies/fx-provider.port.js';

const catalog = JSON.stringify({
  EUR: 'Euro',
  USD: 'US Dollar',
  GBP: 'British Pound',
});

function snapshot(rates: string, date = '2026-11-20', base = 'EUR'): string {
  return `{"amount":1.0,"base":"${base}","date":"${date}","rates":${rates}}`;
}

describe('FrankfurterFxAdapter', () => {
  let server: Server;
  let baseUrl: string;
  let requests: string[];
  let currencies: string;
  let reply: (res: ServerResponse) => void;

  beforeEach(async () => {
    requests = [];
    currencies = catalog;
    reply = (res) => res.end(snapshot('{"USD":1.0500}'));
    server = createServer((req, res) => {
      requests.push(req.url ?? '');
      if (req.url === '/currencies') res.end(currencies);
      else reply(res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a loopback TCP listener.');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  });

  it('uses the publication date and preserves exact decimal tokens without binary rounding', async () => {
    reply = (res) =>
      res.end(snapshot('{"USD":1.00000000000000008900,"GBP":1.20e-6}'));

    await expect(
      new FrankfurterFxAdapter(baseUrl).latest('EUR', ['USD', 'GBP']),
    ).resolves.toEqual({
      baseCurrency: 'EUR',
      effectiveAt: '2026-11-20T00:00:00.000Z',
      rates: { USD: '1.00000000000000008900', GBP: '0.00000120' },
    });
    expect(requests).toEqual(['/currencies', '/latest?from=EUR&to=USD%2CGBP']);
  });

  it('excludes unsupported, duplicate and same-currency quotes from the request', async () => {
    await expect(
      new FrankfurterFxAdapter(baseUrl).latest('EUR', [
        'COP',
        'EUR',
        'USD',
        'USD',
      ]),
    ).resolves.toEqual({
      baseCurrency: 'EUR',
      effectiveAt: '2026-11-20T00:00:00.000Z',
      rates: { USD: '1.0500' },
    });
    expect(requests).toEqual(['/currencies', '/latest?from=EUR&to=USD']);
  });

  it.each([
    ['unsupported base', 'COP', ['USD']],
    ['no supported quotes', 'EUR', ['COP']],
  ])('does not request rates with %s', async (_case, base, quotes) => {
    await expect(
      new FrankfurterFxAdapter(baseUrl).latest(base, quotes),
    ).resolves.toBeUndefined();
    expect(requests).toEqual(['/currencies']);
  });

  it('rejects a malformed currency catalog before fetching rates', async () => {
    currencies = '{"USD":1}';
    await expect(
      new FrankfurterFxAdapter(baseUrl).latest('EUR', ['USD']),
    ).rejects.toThrow('Invalid Frankfurter response.');
    expect(requests).toEqual(['/currencies']);
  });

  it.each([
    ['invalid JSON', '{'],
    ['rolled-over date', snapshot('{"USD":1}', '2026-02-29')],
    ['mismatched base', snapshot('{"USD":1}', undefined, 'GBP')],
    [
      'wrong amount',
      snapshot('{"USD":1}').replace('1.0', '1.0000000000000001'),
    ],
    ['numeric string', snapshot('{"USD":"1.05"}')],
    ['zero rate', snapshot('{"USD":0.0}')],
    ['negative rate', snapshot('{"USD":-1}')],
    ['unbounded exponent', snapshot('{"USD":1e100000}')],
    ['missing requested rate', snapshot('{}')],
    ['unrequested rate', snapshot('{"USD":1,"GBP":1}')],
    ['duplicate rate key', snapshot('{"USD":1,"U\\u0053D":2}')],
  ])('rejects %s without yielding a snapshot', async (_case, body) => {
    reply = (res) => res.end(body);
    await expect(
      new FrankfurterFxAdapter(baseUrl).latest('EUR', ['USD']),
    ).rejects.toThrow('Invalid Frankfurter response.');
  });

  it('surfaces provider failures instead of treating them as unsupported currencies', async () => {
    reply = (res) => res.writeHead(503).end('Unavailable');
    await expect(
      new FrankfurterFxAdapter(baseUrl).latest('EUR', ['USD']),
    ).rejects.toThrow('Frankfurter returned HTTP 503.');
  });

  it('never follows redirects', async () => {
    reply = (res) => res.writeHead(302, { Location: '/redirected' }).end();
    await expect(
      new FrankfurterFxAdapter(baseUrl).latest('EUR', ['USD']),
    ).rejects.toThrow();
    expect(requests).toEqual(['/currencies', '/latest?from=EUR&to=USD']);
  });

  it('rejects an oversized streamed response without relying on Content-Length', async () => {
    reply = (res) => {
      res.write(' '.repeat(32_768));
      res.end(' ');
    };
    await expect(
      new FrankfurterFxAdapter(baseUrl).latest('EUR', ['USD']),
    ).rejects.toThrow('Frankfurter response exceeds 32768 bytes.');
  });

  it('times out while awaiting the complete response body', async () => {
    reply = (res) => res.write('{');
    await expect(
      new FrankfurterFxAdapter(baseUrl, 500).latest('EUR', ['USD']),
    ).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(requests).toEqual(['/currencies', '/latest?from=EUR&to=USD']);
  });
});

describe('FX freshness', () => {
  it.each([
    ['2026-11-22T23:59:59.999Z', false],
    ['2026-11-23T00:00:00.000Z', true],
    ['2026-11-23T00:00:00.001Z', true],
  ])('detects the 72-hour expiry at %s', (now, stale) => {
    expect(isFxRateStale('2026-11-20T00:00:00.000Z', new Date(now))).toBe(
      stale,
    );
  });
});
