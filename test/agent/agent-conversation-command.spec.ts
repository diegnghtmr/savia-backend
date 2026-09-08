import { describe, expect, it } from 'vitest';
import { createAgentConversationCommand } from '../../src/agent/agent-conversation-command.js';
describe('agent conversation command', () => {
  it('accepts empty body with deterministic title', () =>
    expect(createAgentConversationCommand({})).toEqual({
      title: 'New conversation',
      modelRef: null,
      credentialId: null,
    }));
  it('preserves empty title and accepts unconstrained modelRef', () =>
    expect(
      createAgentConversationCommand({ title: '', modelRef: 'provider/model' }),
    ).toMatchObject({ title: '', modelRef: 'provider/model' }));
  it('rejects only unknown and oversized fields', () =>
    expect(() =>
      createAgentConversationCommand({ title: 'x'.repeat(121) }),
    ).toThrow());
});
