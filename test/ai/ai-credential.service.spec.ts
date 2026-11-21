import https from 'node:https';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  AgentMessageStore,
} from '../../src/agent/agent-message.port.js';
import { AgentMessageService } from '../../src/agent/agent-message.service.js';
import { OpenAICompatibleAgentProviderAdapter } from '../../src/agent/agent-provider.adapter.js';
import { AICredentialValidationError } from '../../src/ai/ai-credential-command.js';
import { CredentialCrypto } from '../../src/platform/credential-crypto.js';
import {
  CommitOutcomeUnknownError,
  type TransactionClient,
} from '../../src/platform/pg-transaction.js';
import type {
  IdempotencyRecord,
  IdempotencyStore,
} from '../../src/platform/idempotency.port.js';
import { AICredentialService } from '../../src/ai/ai-credential.service.js';
import type {
  CreateCredentialCommand,
  CredentialMetadata,
  Store,
  UpdateCredentialCommand,
} from '../../src/ai/ai-credential.port.js';

const subject = '11111111-1111-4111-8111-111111111111';
const workspace = '22222222-2222-4222-8222-222222222222';
const metadata: CredentialMetadata = {
  id: '33333333-3333-4333-8333-333333333333',
  ownerType: 'user',
  ownerSubjectId: subject,
  providerId: 'openai',
  credentialType: 'api_key',
  maskedIdentifier: '••••1234',
  alias: 'primary',
  status: 'active',
  lastUsedAt: null,
  expiresAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const command: CreateCredentialCommand = {
  ownerType: 'user',
  providerId: 'openai',
  credentialType: 'api_key',
  secret: 'secret-1234',
  alias: 'primary',
  metadata: {},
};

class RecordingTransaction {
  public committed = 0;
  public rolledBack = 0;
  public returned = 0;
  public thrown = 0;
  public commitError: Error | undefined;
  public async run<T>(
    _subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      const result = this.commitError
        ? undefined
        : await callback({
            query: async () => ({ rows: [], rowCount: 0 }),
          } as never);
      this.returned++;
      this.committed++;
      if (this.commitError) throw this.commitError;
      return result as T;
    } catch (error) {
      this.thrown++;
      if (!this.commitError) this.rolledBack++;
      throw error;
    }
  }
  public async runRead<T>(
    _subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    return callback({
      query: async () => ({ rows: [], rowCount: 0 }),
    } as never);
  }
}
class FakeStore implements Store {
  public updateResult: CredentialMetadata | undefined = metadata;
  public revokeResult = true;
  public setDefaultResult = true;
  public createError: unknown;
  public updateError: unknown;
  public createId() {
    return metadata.id;
  }
  public async list() {
    return [];
  }
  public async create() {
    if (this.createError) throw this.createError;
    return metadata;
  }
  public findResult: Awaited<ReturnType<Store['find']>>;
  public async find() {
    return this.findResult;
  }
  public async update() {
    if (this.updateError) throw this.updateError;
    return this.updateResult;
  }
  public async revoke() {
    return this.revokeResult;
  }
  public defaultRow: Awaited<ReturnType<Store['readDefault']>>;
  public async readDefault() {
    return this.defaultRow;
  }
  public async setDefault() {
    return this.setDefaultResult;
  }
}
class FakeIdempotency implements IdempotencyStore {
  public record: IdempotencyRecord | undefined;
  public writeResult = true;
  public async read() {
    return this.record;
  }
  public async write(
    _client: TransactionClient,
    _subject: string,
    _route: string,
    _key: string,
    fingerprint: string,
    status: number,
    etag: string | null,
    body: unknown,
  ) {
    if (this.writeResult)
      this.record = {
        requestFingerprint: fingerprint,
        responseStatus: status,
        responseEtag: etag,
        responseBody: body,
      };
    return this.writeResult;
  }
}
function harness() {
  const tx = new RecordingTransaction();
  const idempotency = new FakeIdempotency();
  const store = new FakeStore();
  const crypto = new CredentialCrypto(Buffer.alloc(32, 1).toString('base64'));
  return {
    tx,
    idempotency,
    store,
    crypto,
    service: new AICredentialService(tx as never, store, crypto, idempotency),
  };
}

it.each([' sk-legacy', 'sk-legacy ', 'sk-\u007flegacy'])(
  'rejects unusable stored tokens before resolving an endpoint',
  async (secret) => {
    const crypto = new CredentialCrypto(Buffer.alloc(32, 1).toString('base64'));
    const store = new FakeStore();
    store.defaultRow = {
      modelRef: 'openai-compatible:demo',
      credentialType: 'gateway_token',
      encryptedSecret: crypto.encrypt(secret),
      baseUrl: 'https://provider.example.test/v1',
    };
    const service = new AICredentialService(
      new RecordingTransaction() as never,
      store,
      crypto,
      new FakeIdempotency(),
    );
    const resolution = service.resolveAgentCredential(subject, workspace);
    await expect(resolution).rejects.toThrow(
      new Error('Workspace AI credential unavailable'),
    );
  },
);

it('does not persist an invalid bearer supplied directly to creation', async () => {
  const h = harness();
  const create = vi.spyOn(h.store, 'create');
  const credential = { ...command, secret: 'legacy token' };
  const creation = h.service.createCredential(
    subject,
    workspace,
    credential,
    'key',
  );
  await expect(creation).rejects.toBeInstanceOf(AICredentialValidationError);
  expect(create).not.toHaveBeenCalled();
  expect(h.idempotency.record).toBeUndefined();
  expect(h.tx.committed).toBe(0);
});

const invalidReplacements = [
  'internal space',
  'trailing ',
  'embedded\u0000nul',
  'café',
];
it.each(invalidReplacements)(
  'rejects invalid bearer replacements before writing',
  async (replacementSecret) => {
    const h = harness();
    h.store.findResult = { ...metadata, version: 1 };
    const write = vi.spyOn(h.store, 'update');
    const result = h.service.updateCredential(
      subject,
      workspace,
      metadata.id,
      { replacementSecret },
      'key',
      1,
    );
    await expect(result).rejects.toBeInstanceOf(AICredentialValidationError);
    await expect(result).rejects.toMatchObject({
      violations: [
        {
          field: 'replacementSecret',
          code: 'invalid-value',
          message: 'must contain only visible ASCII characters',
        },
      ],
    });
    expect(write).not.toHaveBeenCalled();
    expect(h.idempotency.record).toBeUndefined();
    expect(h.tx.committed).toBe(0);
  },
);

it.each([
  ['api_key', 'A-._~+/=z'],
  ['service_account', '{\n  "key": "with spaces"\n}'],
] as const)(
  'rotates %s without changing the supplied secret',
  async (credentialType, replacementSecret) => {
    const h = harness();
    const current = { ...metadata, credentialType, version: 1 };
    h.store.findResult = current;
    h.store.updateResult = current;
    const store: Store = h.store;
    const write = vi.spyOn(store, 'update');
    const result = await h.service.updateCredential(
      subject,
      workspace,
      metadata.id,
      { replacementSecret },
      'key',
      1,
    );
    expect(result.kind).toBe('ok');
    expect(write).toHaveBeenCalledOnce();
    const encrypted = write.mock.calls[0][3].replacementSecret;
    expect(encrypted).toBeDefined();
    expect(h.crypto.decrypt(encrypted ?? '')).toBe(replacementSecret);
    expect(h.tx.committed).toBe(1);
    expect(h.idempotency.record?.responseStatus).toBe(200);
  },
);

it('turns a legacy token with internal space into run_failed without dispatch', async () => {
  const h = harness();
  h.store.defaultRow = {
    modelRef: 'openai-compatible:demo',
    credentialType: 'gateway_token',
    encryptedSecret: h.crypto.encrypt('legacy token'),
    baseUrl: 'https://provider.example.test/v1',
  };
  const request = vi.spyOn(https, 'request').mockImplementation(() => {
    throw new Error('Unexpected outbound request');
  });
  try {
    const events: AgentEvent[] = [];
    const runs = { saveRun: vi.fn(), finalizeIdempotency: vi.fn() };
    const provider = new OpenAICompatibleAgentProviderAdapter((actor, id) =>
      h.service.resolveAgentCredential(actor, id),
    );
    const messages = new AgentMessageService(
      h.tx,
      runs as unknown as AgentMessageStore,
      provider,
    );
    await messages.execute(
      subject,
      workspace,
      'conversation',
      'key',
      'run',
      { message: 'prompt', modelRef: null, credentialId: null },
      new AbortController().signal,
      (event) => events.push(event),
    );
    expect(events.map(({ type, data }) => [type, data])).toEqual([
      ['run_started', {}],
      ['run_failed', { message: 'Provider failed' }],
    ]);
    expect(request).not.toHaveBeenCalled();
    expect(runs.saveRun).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      workspace,
      'conversation',
      subject,
      'run',
      'prompt',
      events,
    );
    expect(runs.finalizeIdempotency).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      subject,
      workspace,
      'conversation',
      'key',
      events,
    );
  } finally {
    request.mockRestore();
  }
});

describe('AICredentialService transaction semantics', () => {
  it('throws after a write when idempotency recording loses its race', async () => {
    const h = harness();
    h.idempotency.writeResult = false;
    await expect(
      h.service.createCredential(subject, workspace, command, 'key'),
    ).resolves.toEqual({ kind: 'conflict' });
    expect(h.tx.thrown).toBe(1);
    expect(h.tx.returned).toBe(0);
    expect(h.tx.rolledBack).toBe(1);
  });
  it('does not swallow commit outcome uncertainty', async () => {
    const h = harness();
    h.tx.commitError = new CommitOutcomeUnknownError(
      new Error('connection reset by peer'),
    );
    await expect(
      h.service.createCredential(subject, workspace, command, 'key'),
    ).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
  });

  it('maps only the named unique constraint to conflict', async () => {
    const h = harness();
    h.idempotency.writeResult = true;
    h.service = new AICredentialService(
      h.tx as never,
      Object.assign(new FakeStore(), {
        createError: Object.assign(new Error('duplicate'), {
          code: '23505',
          constraint: 'ai_credentials_unique_alias',
        }),
      }),
      new CredentialCrypto(Buffer.alloc(32, 1).toString('base64')),
      h.idempotency,
    );
    await expect(
      h.service.createCredential(subject, workspace, command, 'key'),
    ).resolves.toEqual({ kind: 'conflict' });
    const wrong = harness();
    wrong.service = new AICredentialService(
      wrong.tx as never,
      Object.assign(new FakeStore(), {
        createError: Object.assign(new Error('other unique'), {
          code: '23505',
          constraint: 'other_constraint',
        }),
      }),
      new CredentialCrypto(Buffer.alloc(32, 1).toString('base64')),
      wrong.idempotency,
    );
    await expect(
      wrong.service.createCredential(subject, workspace, command, 'key'),
    ).rejects.toThrow('other unique');
  });

  it('maps only the named unique constraint to conflict during update', async () => {
    const h = harness();
    const store = new FakeStore();
    store.updateError = Object.assign(new Error('duplicate'), {
      code: '23505',
      constraint: 'ai_credentials_unique_alias',
    });
    h.service = new AICredentialService(
      h.tx as never,
      store,
      new CredentialCrypto(Buffer.alloc(32, 1).toString('base64')),
      h.idempotency,
    );
    await expect(
      h.service.updateCredential(
        subject,
        workspace,
        metadata.id,
        { alias: 'duplicate' },
        'key',
        7,
      ),
    ).resolves.toEqual({ kind: 'conflict' });
  });

  it.each([
    [
      'create',
      (h: ReturnType<typeof harness>) =>
        h.service.createCredential(subject, workspace, command, 'key'),
    ],
    [
      'update',
      (h: ReturnType<typeof harness>) =>
        h.service.updateCredential(
          subject,
          workspace,
          metadata.id,
          { alias: 'new' } as UpdateCredentialCommand,
          'key',
          1,
        ),
    ],
    [
      'revoke',
      (h: ReturnType<typeof harness>) =>
        h.service.revokeCredential(subject, workspace, metadata.id, 'key'),
    ],
    [
      'default',
      (h: ReturnType<typeof harness>) =>
        h.service.setDefaultModel(
          subject,
          workspace,
          'openai:gpt-5',
          null,
          'key',
        ),
    ],
  ])(
    'rolls back after a %s write when idempotency recording fails',
    async (_name, operation) => {
      const h = harness();
      h.idempotency.writeResult = false;
      await expect(operation(h)).resolves.toEqual({ kind: 'conflict' });
      expect(h.tx.returned).toBe(0);
      expect(h.tx.thrown).toBe(1);
      expect(h.tx.committed).toBe(0);
      expect(h.tx.rolledBack).toBe(1);
    },
  );

  it('rolls back when a post-write store failure throws', async () => {
    const h = harness();
    const store = new FakeStore();
    store.createError = new Error('row write failed');
    const service = new AICredentialService(
      h.tx as never,
      store,
      new CredentialCrypto(Buffer.alloc(32, 1).toString('base64')),
      h.idempotency,
    );
    await expect(
      service.createCredential(subject, workspace, command, 'key'),
    ).rejects.toThrow('row write failed');
    expect(h.tx.rolledBack).toBe(1);
    expect(h.tx.committed).toBe(0);
  });
});
