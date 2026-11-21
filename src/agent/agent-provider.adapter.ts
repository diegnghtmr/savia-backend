import dns from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isAllowedProviderAddress } from './agent-provider-address.js';
import type {
  AgentCredentialResolver,
  AgentMessageCommand,
  AgentProviderChunk,
  AgentProviderPort,
} from './agent-message.port.js';

type Credential = NonNullable<Awaited<ReturnType<AgentCredentialResolver>>>;
export class AgentProviderFailure extends Error {}

function completionUrl(baseUrl: string, local: boolean): URL {
  const url = URL.parse(baseUrl);
  if (
    !url ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
  )
    throw new AgentProviderFailure('Invalid provider URL');
  // Node skips lookup for IP literals, so check those before constructing a request.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isAllowedProviderAddress(host, local))
    throw new AgentProviderFailure('Invalid provider URL');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
  return url;
}

function checkedLookup(local: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true }, (error, addresses) => {
      const denied = ({ address, family }: dns.LookupAddress) =>
        isIP(address) !== family || !isAllowedProviderAddress(address, local);
      if (error || !addresses.length || addresses.some(denied)) {
        callback(new AgentProviderFailure('Invalid provider URL'), '', 0);
      } else if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function requestCompletion(
  credential: Credential,
  message: string,
  signal: AbortSignal,
) {
  const local = credential.credentialType === 'local_endpoint';
  const url = completionUrl(credential.baseUrl, local);
  const transport = url.protocol === 'https:' ? https : http;
  const body = Buffer.from(
    JSON.stringify({
      model: credential.model,
      stream: true,
      messages: [{ role: 'user', content: message }],
    }),
  );
  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: 'POST',
        signal,
        agent: false,
        lookup: checkedLookup(local),
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          'Content-Length': body.byteLength,
          ...(local || credential.secret === null
            ? {}
            : { Authorization: `Bearer ${credential.secret}` }),
        },
      },
      resolve,
    );
    request.once('error', reject);
    request.end(body);
  });
}

function parseDelta(data: string): string {
  const event = JSON.parse(data) as {
    choices?: { delta?: { content?: unknown } }[];
    error?: unknown;
  } | null;
  if (!Array.isArray(event?.choices) || event.error !== undefined)
    throw new AgentProviderFailure('Invalid provider stream');
  if (event.choices.length === 0) return '';
  const delta: { content?: unknown } | undefined = event.choices[0]?.delta;
  if (
    !delta ||
    typeof delta !== 'object' ||
    Array.isArray(delta) ||
    (delta.content != null && typeof delta.content !== 'string')
  )
    throw new AgentProviderFailure('Invalid provider stream');
  return delta.content ?? '';
}

/** Hold a possible credential prefix across deltas without delaying other text. */
function guardCredential(secret: string) {
  const prefix = [0];
  const advance = (matched: number, char: string) => {
    while (matched && secret[matched] !== char) matched = prefix[matched - 1];
    return matched + Number(secret[matched] === char);
  };
  for (let i = 1; i < secret.length; i++)
    prefix.push(advance(prefix[i - 1], secret[i]));
  let matched = 0;
  return (text: string | null): string => {
    if (text === null) return secret.slice(0, matched);
    const combined = secret.slice(0, matched) + text;
    for (let i = 0; i < text.length; i++) {
      matched = advance(matched, text[i]);
      if (matched === secret.length)
        throw new AgentProviderFailure('Invalid provider stream');
    }
    return combined.slice(0, combined.length - matched);
  };
}

function responseFilter(credential: Credential) {
  const raw = credential.secret ?? credential.baseUrl;
  const filterRaw = guardCredential(raw);
  // Node sends header bytes as Latin-1 with a Buffer request body. Protect an
  // upstream's UTF-8 interpretation of those bytes as well as the stored text.
  if (credential.secret === null) return filterRaw;
  const wire = Buffer.from(raw, 'latin1').toString('utf8');
  if (wire === raw) return filterRaw;
  const filterWire = guardCredential(wire);
  return (delta: string | null) =>
    filterWire(filterRaw(delta)) + (delta === null ? filterWire(null) : '');
}

async function* readData(body: IncomingMessage) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let line = '';
  let afterCR = false;
  let data: string[] = [];
  for await (const value of body as AsyncIterable<Buffer>) {
    bytes += value.byteLength;
    if (bytes > 1024 * 1024)
      throw new AgentProviderFailure('Provider response too large');
    const decoded = decoder.decode(value, { stream: true });
    if (!decoded) continue;
    const text = afterCR ? decoded.replace(/^\n/, '') : decoded;
    const lines = (line + text).split(/\r\n|\r|\n/);
    afterCR = decoded.endsWith('\r');
    line = lines.pop() ?? '';
    for (const field of lines) {
      if (field === '' && data.length) {
        yield data.join('\n');
        data = [];
      } else if (field.startsWith('data:') || field === 'data') {
        data.push(field.slice(5).replace(/^ /, ''));
      }
    }
  }
}

/** Deterministic echo used only for an unconfigured test or development workspace. */
export class LocalAgentProviderAdapter implements AgentProviderPort {
  public async *stream(
    command: AgentMessageCommand,
    signal: AbortSignal,
  ): AsyncIterable<AgentProviderChunk> {
    if (!signal.aborted)
      yield { type: 'text_delta', data: { text: command.message } };
  }
}

export class OpenAICompatibleAgentProviderAdapter implements AgentProviderPort {
  public constructor(
    private readonly resolve: AgentCredentialResolver,
    private readonly timeoutMs = 30_000,
  ) {}

  public async *stream(
    command: AgentMessageCommand,
    signal: AbortSignal,
    { subject, workspaceId }: Parameters<AgentProviderPort['stream']>[2],
  ): AsyncIterable<AgentProviderChunk> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const cleanup = new AbortController();
    const combined = AbortSignal.any([signal, timeout, cleanup.signal]);
    let response: IncomingMessage | undefined;
    try {
      combined.throwIfAborted();
      const credential = await this.resolve(subject, workspaceId);
      combined.throwIfAborted();
      if (!credential) {
        if (
          process.env.NODE_ENV === 'test' ||
          process.env.NODE_ENV === 'development'
        ) {
          yield* new LocalAgentProviderAdapter().stream(command, signal);
          return;
        }
        throw new AgentProviderFailure('No workspace AI credential configured');
      }
      const token = credential.secret;
      if (
        credential.credentialType !== 'local_endpoint' &&
        (!token || token !== token.trim() || /\p{Cc}/u.test(token))
      )
        throw new AgentProviderFailure('Provider failed');
      response = await requestCompletion(credential, command.message, combined);
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300)
        throw new AgentProviderFailure(`Provider HTTP ${status}`);
      const mediaType = response.headers['content-type'] ?? '';
      if (!/^text\/event-stream\b/i.test(mediaType))
        throw new AgentProviderFailure('Invalid provider stream');
      const filter = responseFilter(credential);
      for await (const data of readData(response)) {
        combined.throwIfAborted();
        const text = filter(data === '[DONE]' ? null : parseDelta(data));
        if (text) yield { type: 'text_delta', data: { text } };
        if (data === '[DONE]') return;
      }
      throw new AgentProviderFailure('Incomplete provider stream');
    } catch (error) {
      if (signal.aborted) throw new AgentProviderFailure('Provider aborted');
      if (timeout.aborted) throw new AgentProviderFailure('Provider timed out');
      if (error instanceof AgentProviderFailure) throw error;
      if (error instanceof SyntaxError)
        throw new AgentProviderFailure('Invalid provider stream');
      throw new AgentProviderFailure('Provider failed');
    } finally {
      response?.destroy();
      cleanup.abort();
    }
  }
}
