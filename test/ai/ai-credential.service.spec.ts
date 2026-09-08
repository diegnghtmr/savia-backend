import { describe, expect, it } from 'vitest';
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
} from '../../src/ai/ai-credential.port.js';

const subject = '11111111-1111-4111-8111-111111111111';
const workspace = '22222222-2222-4222-8222-222222222222';
const metadata: CredentialMetadata = {
  id: '33333333-3333-4333-8333-333333333333',
  ownerType: 'user',
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
      if (this.commitError) throw this.commitError;
      return result as T;
    } catch (error) {
      this.thrown++;
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
  public createId() {
    return metadata.id;
  }
  public async list() {
    return [];
  }
  public async create() {
    return metadata;
  }
  public async find() {
    return undefined;
  }
  public async update() {
    return metadata;
  }
  public async revoke() {
    return true;
  }
  public async setDefault() {
    return true;
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
  return {
    tx,
    idempotency,
    service: new AICredentialService(
      tx as never,
      new FakeStore(),
      new CredentialCrypto(Buffer.alloc(32, 1).toString('base64')),
      idempotency,
    ),
  };
}

describe('AICredentialService transaction semantics', () => {
  it('throws after a write when idempotency recording loses its race', async () => {
    const h = harness();
    h.idempotency.writeResult = false;
    await expect(
      h.service.createCredential(subject, workspace, command, 'key'),
    ).resolves.toEqual({ kind: 'conflict' });
    expect(h.tx.thrown).toBe(1);
    expect(h.tx.returned).toBe(0);
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
});
