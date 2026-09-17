import { expect, it, vi } from 'vitest';
import { AgentMessagesController } from '../../src/agent/agent-messages.controller.js';
it('maps invalid message bodies to 422 problem details', async () => {
  const send = vi.fn();
  const status = vi.fn().mockReturnThis();
  const reply = {
    status,
    type: vi.fn().mockReturnThis(),
    send,
    request: { id: 'trace', url: '/x' },
  } as never;
  await new AgentMessagesController({
    prepare: vi.fn(),
    execute: vi.fn(),
  }).send(
    { headers: {}, identity: { subject: 'x' } } as never,
    'bad',
    {},
    reply,
  );
  expect(status).toHaveBeenCalledWith(422);
  expect(send).toHaveBeenCalled();
});
