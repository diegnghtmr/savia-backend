import type {
  AgentCredentialResolver,
  AgentMessageCommand,
  AgentProviderChunk,
  AgentProviderPort,
} from './agent-message.port.js';

type Credential = NonNullable<Awaited<ReturnType<AgentCredentialResolver>>>;
export class AgentProviderFailure extends Error {}

function completionUrl(credential: Credential): URL {
  const url = URL.parse(credential.baseUrl);
  const loopback = /^(localhost|\[::1\]|127(?:\.\d{1,3}){3})$/.test(
    url?.hostname ?? '',
  );
  const allowsHttp = loopback || credential.credentialType === 'local_endpoint';
  if (
    !url ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(allowsHttp && url.protocol === 'http:'))
  )
    throw new AgentProviderFailure('Invalid provider URL');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
  return url;
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

async function* readData(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let line = '';
  let afterCR = false;
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
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
  } finally {
    reader.releaseLock();
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
      const response = await fetch(completionUrl(credential), {
        method: 'POST',
        redirect: 'manual',
        signal: combined,
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          ...(credential.secret === null
            ? {}
            : { Authorization: `Bearer ${credential.secret}` }),
        },
        body: JSON.stringify({
          model: credential.model,
          stream: true,
          messages: [{ role: 'user', content: command.message }],
        }),
      });
      if (!response.ok)
        throw new AgentProviderFailure(`Provider HTTP ${response.status}`);
      const mediaType = response.headers.get('content-type') ?? '';
      if (!response.body || !/^text\/event-stream\b/i.test(mediaType))
        throw new AgentProviderFailure('Invalid provider stream');
      const filter = guardCredential(credential.secret ?? credential.baseUrl);
      for await (const data of readData(response.body)) {
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
      cleanup.abort();
    }
  }
}
