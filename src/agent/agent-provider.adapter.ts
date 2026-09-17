import type {
  AgentMessageCommand,
  AgentProviderChunk,
  AgentProviderPort,
} from './agent-message.port.js';

/** Deterministic local adapter. A real provider adapter can implement this port without changing transport or lifecycle code. */
export class LocalAgentProviderAdapter implements AgentProviderPort {
  public async *stream(
    command: AgentMessageCommand,
    signal: AbortSignal,
  ): AsyncIterable<AgentProviderChunk> {
    if (signal.aborted) return;
    yield { type: 'text_delta', data: { text: command.message } };
  }
}
