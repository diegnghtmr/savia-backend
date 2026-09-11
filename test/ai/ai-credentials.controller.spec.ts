import { describe, expect, it, vi } from 'vitest';
import { AICredentialsController } from '../../src/ai/ai-credentials.controller.js';
import {
  AI_OUTCOMES,
  type AIServicePort,
} from '../../src/ai/ai-credential.port.js';

const subject = '11111111-1111-4111-8111-111111111111';
const workspace = '22222222-2222-4222-8222-222222222222';
const credentialId = '33333333-3333-4333-8333-333333333333';
const key = '44444444-4444-4444-8444-444444444444';
const credential = {
  id: credentialId,
  ownerType: 'user' as const,
  ownerSubjectId: subject,
  providerId: 'openai',
  credentialType: 'api_key' as const,
  maskedIdentifier: '••••1234',
  alias: null,
  status: 'active' as const,
  lastUsedAt: null,
  expiresAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

class Reply {
  public statusCode = 200;
  public body: unknown = undefined;
  public request = { id: 'trace', url: '/v1/ai/credentials' };
  public status(code: number): this {
    this.statusCode = code;
    return this;
  }
  public type(): this {
    return this;
  }
  public send(body?: unknown): this {
    this.body = body;
    return this;
  }
}
function request(
  headers: Record<string, string> = {
    'x-workspace-id': workspace,
    'idempotency-key': key,
    'if-match': '"1"',
  },
) {
  return { headers, identity: { subject } } as never;
}
function service(
  overrides: Partial<
    Record<keyof AIServicePort, ReturnType<typeof vi.fn>>
  > = {},
): AIServicePort {
  return {
    listProviders: vi.fn().mockReturnValue([]),
    listCredentials: vi.fn().mockResolvedValue([]),
    createCredential: vi.fn(),
    updateCredential: vi.fn(),
    revokeCredential: vi.fn(),
    setDefaultModel: vi.fn(),
    ...overrides,
  } as unknown as AIServicePort;
}
function expectProblem(reply: Reply, status: number, field?: string): void {
  expect(reply.statusCode).toBe(status);
  expect(reply.body).toMatchObject({
    status,
    traceId: 'trace',
    instance: '/v1/ai/credentials',
  });
  if (field)
    expect(
      (reply.body as { errors: Array<{ field: string }> }).errors.map(
        (x) => x.field,
      ),
    ).toContain(field);
}

describe('AICredentialsController', () => {
  it('maps provider and credential listing success and forbidden access', async () => {
    const p = service();
    const c = new AICredentialsController(p);
    const providers = new Reply();
    await c.providers(
      request({ 'x-workspace-id': workspace }),
      providers as never,
    );
    expect(providers.statusCode).toBe(200);
    const list = new Reply();
    await c.list(request({ 'x-workspace-id': workspace }), list as never);
    expect(list.statusCode).toBe(200);
    for (const run of [
      (r: Reply) => c.providers(request({}), r as never),
      (r: Reply) => c.list(request({}), r as never),
    ]) {
      const reply = new Reply();
      await run(reply);
      expectProblem(reply, 403);
    }
  });

  it('maps every create outcome and declared success/error status', async () => {
    const outcomes = [
      [{ kind: AI_OUTCOMES.CREATED, credential }, 201],
      [{ kind: AI_OUTCOMES.CONFLICT }, 409],
      [{ kind: AI_OUTCOMES.NOT_FOUND }, 404],
      [{ kind: AI_OUTCOMES.PRECONDITION }, 412],
    ] as const;
    for (const [outcome, status] of outcomes) {
      const reply = new Reply();
      await new AICredentialsController(
        service({ createCredential: vi.fn().mockResolvedValue(outcome) }),
      ).create(
        request(),
        {
          ownerType: 'user',
          providerId: 'openai',
          credentialType: 'api_key',
          secret: 'secret',
        },
        reply as never,
      );
      if (status === 201) expect(reply.body).toEqual(credential);
      else expectProblem(reply, status);
    }
    const invalid = new Reply();
    const p = service();
    await new AICredentialsController(p).create(
      request(),
      { ownerType: 'user', secret: 'secret' },
      invalid as never,
    );
    expectProblem(invalid, 422, 'providerId');
    expect(p.createCredential).not.toHaveBeenCalled();
  });

  it('maps every update outcome, including 422, 412, 404, and 409', async () => {
    for (const [outcome, status] of [
      [{ kind: AI_OUTCOMES.OK, credential }, 200],
      [{ kind: AI_OUTCOMES.PRECONDITION }, 412],
      [{ kind: AI_OUTCOMES.NOT_FOUND }, 404],
      [{ kind: AI_OUTCOMES.CONFLICT }, 409],
    ] as const) {
      const reply = new Reply();
      await new AICredentialsController(
        service({ updateCredential: vi.fn().mockResolvedValue(outcome) }),
      ).update(request(), credentialId, { alias: null }, reply as never);
      if (status === 200) expect(reply.body).toEqual(credential);
      else expectProblem(reply, status);
    }
    const bad = new Reply();
    await new AICredentialsController(service()).update(
      request(),
      'not-a-uuid',
      {},
      bad as never,
    );
    expectProblem(bad, 412);
    const invalidBody = new Reply();
    await new AICredentialsController(service()).update(
      request(),
      credentialId,
      {},
      invalidBody as never,
    );
    expectProblem(invalidBody, 422, 'body');
  });

  it('maps revoke 204 without a body, 404, and 409', async () => {
    for (const [outcome, status] of [
      [{ kind: AI_OUTCOMES.OK }, 204],
      [{ kind: AI_OUTCOMES.NOT_FOUND }, 404],
      [{ kind: AI_OUTCOMES.CONFLICT }, 409],
    ] as const) {
      const reply = new Reply();
      await new AICredentialsController(
        service({ revokeCredential: vi.fn().mockResolvedValue(outcome) }),
      ).revoke(
        request({ 'x-workspace-id': workspace, 'idempotency-key': key }),
        credentialId,
        reply as never,
      );
      expect(reply.statusCode).toBe(status);
      if (status === 204) expect(reply.body).toBeUndefined();
      else expectProblem(reply, status);
    }
  });

  it('maps default-model 204, 409, 422, and forbidden access', async () => {
    const success = new Reply();
    await new AICredentialsController(
      service({
        setDefaultModel: vi.fn().mockResolvedValue({ kind: AI_OUTCOMES.OK }),
      }),
    ).setDefault(
      request({ 'x-workspace-id': workspace, 'idempotency-key': key }),
      { modelRef: 'openai:gpt-5' },
      success as never,
    );
    expect(success.statusCode).toBe(204);
    expect(success.body).toBeUndefined();
    const conflict = new Reply();
    await new AICredentialsController(
      service({
        setDefaultModel: vi
          .fn()
          .mockResolvedValue({ kind: AI_OUTCOMES.CONFLICT }),
      }),
    ).setDefault(
      request({ 'x-workspace-id': workspace, 'idempotency-key': key }),
      { modelRef: 'openai:gpt-5' },
      conflict as never,
    );
    expectProblem(conflict, 409);
    for (const body of [
      {},
      { modelRef: 'bad' },
      { modelRef: 'openai:gpt-5', extra: true },
    ]) {
      const invalid = new Reply();
      await new AICredentialsController(service()).setDefault(
        request({ 'x-workspace-id': workspace, 'idempotency-key': key }),
        body,
        invalid as never,
      );
      expectProblem(invalid, 422, 'extra' in body ? 'extra' : 'modelRef');
    }
    const forbidden = new Reply();
    await new AICredentialsController(service()).setDefault(
      request({}),
      { modelRef: 'openai:gpt-5' },
      forbidden as never,
    );
    expectProblem(forbidden, 403);
  });
});
