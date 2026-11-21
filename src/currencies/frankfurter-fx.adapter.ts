import type { FxProvider, FxSnapshot } from './fx-provider.port.js';

const MAX_RESPONSE_BYTES = 32_768;
const MAX_DECIMAL_EXPONENT = 100;
const CURRENCY_CODE = /^[A-Z]{3}$/;

class JsonNumber {
  public constructor(public readonly source: string) {}
}

function invalidResponse(): Error {
  return new Error('Invalid Frankfurter response.');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof JsonNumber)
  );
}

function rejectDuplicateKeys(json: string): void {
  // JSON.parse validates syntax first, so only object delimiters and string
  // tokens followed by a colon are relevant here. Decode escaped keys too.
  const objects: Set<string>[] = [];
  for (const [token] of json.matchAll(/"(?:[^"\\]|\\.)*"\s*:?|[{}]/gs)) {
    if (token === '{') objects.push(new Set());
    else if (token === '}') objects.pop();
    else if (token.endsWith(':')) {
      const key = JSON.parse(token.slice(0, -1)) as string;
      const keys = objects.at(-1);
      if (keys?.has(key)) throw invalidResponse();
      keys?.add(key);
    }
  }
}

function positiveDecimal(value: unknown): string {
  if (!(value instanceof JsonNumber)) throw invalidResponse();
  const parts = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value.source);
  if (parts === null) throw invalidResponse();
  const [, integer, fraction = '', exponent] = parts;
  const digits = integer + fraction;
  if (!/[1-9]/.test(digits)) throw invalidResponse();
  if (exponent === undefined) return value.source;

  const power = Number(exponent);
  if (Math.abs(power) > MAX_DECIMAL_EXPONENT) throw invalidResponse();
  const point = integer.length + power;
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  const whole = digits.slice(0, point).replace(/^0+(?=\d)/, '');
  if (point >= digits.length) return whole + '0'.repeat(point - digits.length);
  return `${whole}.${digits.slice(point)}`;
}

function publicationTimestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith('0000')
  ) {
    throw invalidResponse();
  }
  const iso = `${value}T00:00:00.000Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== iso) {
    throw invalidResponse();
  }
  return iso;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Plaintext is only for loopback fakes under the test runner; production requires https. */
function assertProviderUrl(baseUrl: string): void {
  const url = new URL(baseUrl);
  if (url.protocol === 'https:') return;
  if (
    url.protocol === 'http:' &&
    process.env.NODE_ENV === 'test' &&
    LOOPBACK_HOSTS.has(url.hostname)
  )
    return;
  throw new Error('Frankfurter base URL must use https.');
}

export class FrankfurterFxAdapter implements FxProvider {
  public constructor(
    private readonly baseUrl = 'https://api.frankfurter.app',
    private readonly timeoutMs = 3_000,
  ) {
    assertProviderUrl(baseUrl);
  }

  public async latest(
    baseCurrency: string,
    quoteCurrencies: readonly string[],
    cancellation?: AbortSignal,
  ): Promise<FxSnapshot | undefined> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = cancellation
      ? AbortSignal.any([timeout, cancellation])
      : timeout;
    const currencies = await this.readJson(
      new URL('/currencies', this.baseUrl),
      signal,
    );
    if (
      !isObject(currencies) ||
      Object.keys(currencies).length === 0 ||
      Object.entries(currencies).some(
        ([code, name]) =>
          !CURRENCY_CODE.test(code) ||
          typeof name !== 'string' ||
          name.trim().length === 0,
      )
    ) {
      throw invalidResponse();
    }
    if (!Object.hasOwn(currencies, baseCurrency)) return undefined;

    const quotes = [...new Set(quoteCurrencies)].filter(
      (code) => code !== baseCurrency && Object.hasOwn(currencies, code),
    );
    if (quotes.length === 0) return undefined;

    const url = new URL('/latest', this.baseUrl);
    url.searchParams.set('from', baseCurrency);
    url.searchParams.set('to', quotes.join(','));
    const snapshot = await this.readJson(url, signal);
    if (!isObject(snapshot)) throw invalidResponse();
    const { amount, base, date, rates: rawRates } = snapshot;
    if (
      base !== baseCurrency ||
      !/^1(?:\.0+)?$/.test(positiveDecimal(amount)) ||
      !isObject(rawRates) ||
      Object.keys(rawRates).length !== quotes.length ||
      quotes.some((code) => !Object.hasOwn(rawRates, code))
    ) {
      throw invalidResponse();
    }
    const effectiveAt = publicationTimestamp(date);
    const rates: Record<string, string> = {};
    for (const code of quotes) rates[code] = positiveDecimal(rawRates[code]);
    return { baseCurrency, effectiveAt, rates };
  }

  private async readJson(url: URL, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(url, { redirect: 'error', signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Frankfurter returned HTTP ${response.status}.`);
    }
    if (response.body === null) throw invalidResponse();

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error(
            `Frankfurter response exceeds ${MAX_RESPONSE_BYTES} bytes.`,
          );
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }

    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks, bytes),
      );
      // Node 24 exposes the original token to the reviver. Do not serialize
      // the already-rounded JavaScript number or use it for validation.
      const value: unknown = JSON.parse(
        text,
        (_key, value: unknown, context?: { source?: string }) => {
          if (typeof value !== 'number') return value;
          if (context?.source === undefined) throw invalidResponse();
          return new JsonNumber(context.source);
        },
      );
      rejectDuplicateKeys(text);
      return value;
    } catch {
      throw invalidResponse();
    }
  }
}
