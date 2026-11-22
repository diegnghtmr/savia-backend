import type {
  NotificationDelivery,
  NotificationDeliveryPort,
  NotificationDeliveryResult,
} from './notification-delivery.port.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 32_768;

export interface NotificationProviderOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

function providerEndpoint(baseUrl: string, path: string): URL {
  const invalid = () =>
    new Error(
      'Notification provider base URL must use HTTPS without credentials.',
    );
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw invalid();
  }
  const testLoopback =
    url.protocol === 'http:' &&
    process.env.NODE_ENV === 'test' &&
    LOOPBACK_HOSTS.has(url.hostname);
  if (
    (url.protocol !== 'https:' && !testLoopback) ||
    url.username ||
    url.password
  ) {
    throw invalid();
  }
  return new URL(path, url);
}

function providerTimeout(timeoutMs = MAX_TIMEOUT_MS): number {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      'Notification provider timeout must be between 1 and 3000 ms.',
    );
  }
  return timeoutMs;
}

async function postDelivery(
  endpoint: URL,
  timeoutMs: number,
  body: object,
  headers: Record<string, string>,
  interpret: (payload: unknown) => NotificationDeliveryResult,
): Promise<NotificationDeliveryResult> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const status = response.status;
      return status === 408 || status === 429 || status >= 500
        ? 'retryable'
        : 'rejected';
    }
    if (response.body === null) return 'retryable';

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
          return 'rejected';
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const payload: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks, bytes),
      ),
    );
    return interpret(payload);
  } catch {
    // Never forward provider bodies, URLs, or thrown errors to the worker.
    return 'retryable';
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasProviderId(id: unknown): boolean {
  return typeof id === 'string' && id.trim().length > 0;
}

function expoTicket(payload: unknown): NotificationDeliveryResult {
  const ticket = asRecord(asRecord(payload)?.data);
  if (ticket?.status === 'ok' && hasProviderId(ticket.id)) return 'accepted';
  if (ticket?.status === 'error') {
    const error = asRecord(ticket.details)?.error;
    if (error === 'DeviceNotRegistered') return 'device_not_registered';
    return error === 'MessageRateExceeded' ? 'retryable' : 'rejected';
  }
  return 'retryable';
}

export class ExpoPushAdapter implements NotificationDeliveryPort {
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  readonly #token = process.env.SAVIA_EXPO_ACCESS_TOKEN?.trim();

  public constructor(options: NotificationProviderOptions = {}) {
    this.endpoint = providerEndpoint(
      options.baseUrl ?? 'https://exp.host',
      '/--/api/v2/push/send',
    );
    this.timeoutMs = providerTimeout(options.timeoutMs);
  }

  public deliver(
    message: NotificationDelivery,
  ): Promise<NotificationDeliveryResult> {
    return postDelivery(
      this.endpoint,
      this.timeoutMs,
      { to: message.to, title: message.title, body: message.body ?? undefined },
      this.#token ? { authorization: `Bearer ${this.#token}` } : {},
      expoTicket,
    );
  }
}

export class ResendEmailAdapter implements NotificationDeliveryPort {
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly sender: string;
  readonly #apiKey: string;

  public constructor(options: NotificationProviderOptions = {}) {
    this.endpoint = providerEndpoint(
      options.baseUrl ?? 'https://api.resend.com',
      '/emails',
    );
    this.timeoutMs = providerTimeout(options.timeoutMs);
    const apiKey = process.env.SAVIA_RESEND_API_KEY?.trim();
    const sender = process.env.SAVIA_NOTIFICATION_FROM_EMAIL?.trim();
    if (!apiKey || !sender)
      throw new Error('Resend requires an API key and sender.');
    this.#apiKey = apiKey;
    this.sender = sender;
  }

  public deliver(
    message: NotificationDelivery,
  ): Promise<NotificationDeliveryResult> {
    return postDelivery(
      this.endpoint,
      this.timeoutMs,
      {
        from: this.sender,
        to: [message.to],
        subject: message.title,
        text: message.body ?? message.title,
      },
      {
        authorization: `Bearer ${this.#apiKey}`,
        'idempotency-key': message.idempotencyKey,
      },
      (payload) =>
        hasProviderId(asRecord(payload)?.id) ? 'accepted' : 'retryable',
    );
  }
}
