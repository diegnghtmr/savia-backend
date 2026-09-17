import { describe, expect, it } from 'vitest';
import {
  AgentConversationValidationError,
  createAgentConversationCommand,
} from '../../src/agent/agent-conversation-command.js';

function violation(input: unknown, field: string): void {
  try {
    createAgentConversationCommand(input);
    throw new Error('expected validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(AgentConversationValidationError);
    expect((error as AgentConversationValidationError).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ field })]),
    );
  }
}

describe('agent conversation command', () => {
  it('accepts an empty body with the deterministic default title', () =>
    expect(createAgentConversationCommand({})).toEqual({
      title: 'New conversation',
      modelRef: null,
      credentialId: null,
    }));
  it('uses the default for an absent or null title but preserves an empty title', () => {
    expect(createAgentConversationCommand({}).title).toBe('New conversation');
    expect(createAgentConversationCommand({ title: null }).title).toBe(
      'New conversation',
    );
    expect(createAgentConversationCommand({ title: '' }).title).toBe('');
    expect(
      createAgentConversationCommand({ title: 'x'.repeat(120) }).title,
    ).toHaveLength(120);
    violation({ title: 'x'.repeat(121) }, 'title');
    expect(
      createAgentConversationCommand({ title: '\u{1F600}'.repeat(120) }).title,
    ).toBe('\u{1F600}'.repeat(120));
    violation({ title: '\u{1F600}'.repeat(121) }, 'title');
    violation({ title: 1 }, 'title');
  });

  it('accepts any modelRef string and null, and rejects other types', () => {
    expect(
      createAgentConversationCommand({ modelRef: 'not a provider/ref' })
        .modelRef,
    ).toBe('not a provider/ref');
    expect(
      createAgentConversationCommand({ modelRef: null }).modelRef,
    ).toBeNull();
    violation({ modelRef: 1 }, 'modelRef');
  });

  it('accepts UUID or null credentials and reports the credential field', () => {
    const id = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
    expect(
      createAgentConversationCommand({ credentialId: id }).credentialId,
    ).toBe(id.toLowerCase());
    expect(
      createAgentConversationCommand({ credentialId: null }).credentialId,
    ).toBeNull();
    violation({ credentialId: 'not-a-uuid' }, 'credentialId');
    violation({ credentialId: 1 }, 'credentialId');
  });

  it('rejects unknown top-level keys and names the key', () => {
    violation({ unexpected: true }, 'unexpected');
  });
});
