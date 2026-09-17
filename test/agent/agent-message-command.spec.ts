import { describe, expect, it } from 'vitest';
import {
  AgentMessageValidationError,
  createAgentMessageCommand,
} from '../../src/agent/agent-message-command.js';
describe('agent message command', () => {
  it('accepts nullable optional fields and preserves unknown data outside the command', () =>
    expect(
      createAgentMessageCommand({
        message: 'hello',
        modelRef: null,
        credentialId: null,
      }),
    ).toEqual({ message: 'hello', modelRef: null, credentialId: null }));
  it('counts astral characters as characters', () =>
    expect(
      createAgentMessageCommand({ message: '😀'.repeat(20000) }).message,
    ).toHaveLength(40000));
  it('rejects an empty message and unknown fields', () =>
    expect(() =>
      createAgentMessageCommand({ message: '', extra: true }),
    ).toThrow(AgentMessageValidationError));
});
