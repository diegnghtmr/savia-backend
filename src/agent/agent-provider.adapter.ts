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
  AgentProviderTurn,
  AgentToolCall,
} from './agent-message.port.js';

type Credential = NonNullable<Awaited<ReturnType<AgentCredentialResolver>>>;
export class AgentProviderFailure extends Error {}

const maxBodyBytes = 1024 * 1024;
const maxToolCalls = 8;
const maxArgumentBytes = 16 * 1024;
const invalidStream = () => new AgentProviderFailure('Invalid provider stream');

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
  turn?: AgentProviderTurn,
) {
  const local = credential.credentialType === 'local_endpoint';
  const url = completionUrl(credential.baseUrl, local);
  const transport = url.protocol === 'https:' ? https : http;
  const body = Buffer.from(
    JSON.stringify({
      model: credential.model,
      stream: true,
      messages: [
        { role: 'user', content: message },
        ...(turn?.history ?? []).map((entry) =>
          entry.role === 'tool'
            ? {
                role: 'tool',
                tool_call_id: entry.callId,
                content: entry.content,
              }
            : {
                role: 'assistant',
                content: entry.content,
                tool_calls: entry.calls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                })),
              },
        ),
      ],
      ...(turn?.tools.length && {
        tools: turn.tools.map((fn) => ({ type: 'function', function: fn })),
      }),
    }),
  );
  if (body.byteLength > maxBodyBytes)
    throw new AgentProviderFailure('Provider request too large');
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseDelta(data: string) {
  const event: unknown = JSON.parse(data);
  if (
    !isObject(event) ||
    !Array.isArray(event.choices) ||
    event.error !== undefined
  )
    throw invalidStream();
  if (event.choices.length === 0) return null;
  const choice: unknown = event.choices[0];
  if (!isObject(choice) || !isObject(choice.delta)) throw invalidStream();
  const { content, tool_calls } = choice.delta;
  if (
    (content != null && typeof content !== 'string') ||
    (tool_calls != null && !Array.isArray(tool_calls))
  )
    throw invalidStream();
  return {
    text: content ?? '',
    calls: tool_calls ?? [],
    finish: choice.finish_reason,
  };
}

class ToolCallAccumulator {
  private readonly calls = new Map<
    number,
    { id?: string; name?: string; raw: string }
  >();
  private readonly names: ReadonlySet<string>;
  private finish: unknown;

  public constructor(
    turn: AgentProviderTurn | undefined,
    private readonly protectedValue: string,
  ) {
    this.names = new Set(turn?.tools.map(({ name }) => name));
  }

  public add(deltas: readonly unknown[], finish: unknown) {
    if (
      this.names.size &&
      this.finish != null &&
      (deltas.length || finish != null)
    )
      throw invalidStream();
    for (const delta of deltas) {
      if (
        !this.names.size ||
        !isObject(delta) ||
        typeof delta.index !== 'number' ||
        !Number.isInteger(delta.index) ||
        delta.index < 0 ||
        delta.index >= maxToolCalls ||
        (delta.type != null && delta.type !== 'function')
      )
        throw invalidStream();
      const call = this.calls.get(delta.index) ?? { raw: '' };
      if (delta.id != null) {
        if (
          typeof delta.id !== 'string' ||
          !/^[!-~]{1,128}$/.test(delta.id) ||
          this.containsProtected(delta.id) ||
          (call.id !== undefined && call.id !== delta.id)
        )
          throw invalidStream();
        call.id = delta.id;
      }
      if (delta.function != null) {
        if (!isObject(delta.function)) throw invalidStream();
        const { name, arguments: fragment } = delta.function;
        if (name != null) {
          if (
            typeof name !== 'string' ||
            !this.names.has(name) ||
            this.containsProtected(name) ||
            (call.name !== undefined && call.name !== name)
          )
            throw invalidStream();
          call.name = name;
        }
        if (fragment != null) {
          if (typeof fragment !== 'string') throw invalidStream();
          call.raw += fragment;
          if (Buffer.byteLength(call.raw) > maxArgumentBytes)
            throw invalidStream();
        }
      }
      this.calls.set(delta.index, call);
    }
    if (finish != null) this.finish = finish;
  }

  public complete(): AgentToolCall[] {
    if (
      (this.calls.size &&
        this.finish != null &&
        this.finish !== 'tool_calls') ||
      (this.names.size && !this.calls.size && this.finish === 'tool_calls')
    )
      throw invalidStream();
    const ids = new Set<string>();
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, { id, name, raw }]) => {
        if (!id || !name || ids.has(id) || this.containsProtected(raw))
          throw invalidStream();
        ids.add(id);
        const args: unknown = JSON.parse(raw, (key, value: unknown) => {
          if (
            this.containsProtected(key) ||
            (typeof value === 'string' && this.containsProtected(value)) ||
            (typeof value === 'number' && !Number.isFinite(value))
          )
            throw invalidStream();
          return value;
        });
        if (!isObject(args)) throw invalidStream();
        return { id, name, arguments: args };
      });
  }

  private containsProtected(value: string): boolean {
    return (
      this.protectedValue.length > 0 && value.includes(this.protectedValue)
    );
  }
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

async function* readData(body: IncomingMessage) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let line = '';
  let afterCR = false;
  let data: string[] = [];
  for await (const value of body as AsyncIterable<Buffer>) {
    bytes += value.byteLength;
    if (bytes > maxBodyBytes)
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
    turn?: AgentProviderTurn,
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
      const isBearer = credential.credentialType !== 'local_endpoint';
      if (isBearer && (!token || /[^!-~]/.test(token)))
        throw new AgentProviderFailure('Provider failed');
      response = await requestCompletion(
        credential,
        command.message,
        combined,
        turn,
      );
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300)
        throw new AgentProviderFailure(`Provider HTTP ${status}`);
      const mediaType = response.headers['content-type'] ?? '';
      if (!/^text\/event-stream\b/i.test(mediaType))
        throw new AgentProviderFailure('Invalid provider stream');
      const protectedValue = credential.secret ?? credential.baseUrl;
      const filter = guardCredential(protectedValue);
      const tools = new ToolCallAccumulator(turn, protectedValue);
      for await (const data of readData(response)) {
        combined.throwIfAborted();
        if (data === '[DONE]') {
          const calls = tools.complete();
          const text = filter(null);
          if (text) yield { type: 'text_delta', data: { text } };
          combined.throwIfAborted();
          if (calls.length) yield { type: 'tool_calls', data: { calls } };
          return;
        }
        const delta = parseDelta(data);
        if (!delta) continue;
        tools.add(delta.calls, delta.finish);
        const text = filter(delta.text);
        if (text) yield { type: 'text_delta', data: { text } };
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
