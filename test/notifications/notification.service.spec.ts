import { describe, expect, it } from 'vitest';
import type { Cursor } from '../../src/platform/cursor.js';
import type {
  IdempotencyRecord,
  IdempotencyStore,
} from '../../src/platform/idempotency.port.js';
import { computeRequestFingerprint } from '../../src/platform/idempotency.service.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import {
  NOTIFICATION_OUTCOMES,
  type NotificationRow,
  type NotificationStore,
} from '../../src/notifications/notification.port.js';
import {
  NotificationService,
  type NotificationTransaction,
} from '../../src/notifications/notification.service.js';

class RecordingTransaction implements NotificationTransaction {
  public committed = 0;
  public rolledBack = 0;

  public async run<T>(
    _subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    void _subject;
    try {
      const result = await callback({} as TransactionClient);
      this.committed++;
      return result;
    } catch (error) {
      this.rolledBack++;
      throw error;
    }
  }

  public async runRead<T>(
    _subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    void _subject;
    try {
      const result = await callback({} as TransactionClient);
      this.committed++;
      return result;
    } catch (error) {
      this.rolledBack++;
      throw error;
    }
  }
}

class FakeNotificationStore implements NotificationStore {
  public rows: NotificationRow[] = [];
  public markResult = true;
  public markCalls: Array<{
    subject: string;
    notificationId: string;
    now: Date;
  }> = [];

  public async listNotifications(
    _client: TransactionClient,
    _subject: string,
    unreadOnly: boolean,
    limit: number,
    cursor?: Cursor,
  ): Promise<readonly NotificationRow[]> {
    void _client;
    void _subject;
    let filtered = this.rows;
    if (unreadOnly) {
      filtered = filtered.filter((r) => !r.read);
    }
    if (cursor) {
      filtered = filtered.filter(
        (r) =>
          r.createdAt > cursor.createdAt ||
          (r.createdAt === cursor.createdAt && r.id > cursor.id),
      );
    }
    return filtered.slice(0, limit);
  }

  public async markNotificationRead(
    _client: TransactionClient,
    subject: string,
    notificationId: string,
    now: Date,
  ): Promise<boolean> {
    void _client;
    this.markCalls.push({ subject, notificationId, now });
    return this.markResult;
  }
}

class FakeIdempotencyStore implements IdempotencyStore {
  public records = new Map<string, IdempotencyRecord>();
  public writeResult = true;
  public writeCalls: Array<{ key: string; fingerprint: string }> = [];

  public async read(
    _client: TransactionClient,
    subject: string,
    route: string,
    key: string,
  ): Promise<IdempotencyRecord | undefined> {
    void _client;
    return this.records.get(`${subject}:${route}:${key}`);
  }

  public async write(
    _client: TransactionClient,
    subject: string,
    route: string,
    key: string,
    fingerprint: string,
    status: number,
    etag: string | null,
    body: unknown,
  ): Promise<boolean> {
    void _client;
    this.writeCalls.push({ key, fingerprint });
    if (this.writeResult) {
      this.records.set(`${subject}:${route}:${key}`, {
        requestFingerprint: fingerprint,
        responseStatus: status,
        responseEtag: etag,
        responseBody: body,
      });
      return true;
    }
    return false;
  }
}

describe('NotificationService', () => {
  const subject = '11111111-0000-4000-8000-000000000001';
  const notificationId = '22222222-0000-4000-8000-000000000002';
  const idempotencyKey = '33333333-0000-4000-8000-000000000003';

  it('lists notifications and computes pageInfo nextCursor', async () => {
    const tx = new RecordingTransaction();
    const store = new FakeNotificationStore();
    const idempotency = new FakeIdempotencyStore();
    const service = new NotificationService(tx, store, idempotency);

    store.rows = [
      {
        id: 'a1',
        type: 'system',
        title: 'N1',
        body: null,
        read: false,
        actionUrl: null,
        createdAt: '2026-09-07T12:00:00.000000Z',
        cursorAt: '2026-09-07T12:00:00.000000Z',
      },
      {
        id: 'a2',
        type: 'system',
        title: 'N2',
        body: null,
        read: false,
        actionUrl: null,
        createdAt: '2026-09-07T12:01:00.000000Z',
        cursorAt: '2026-09-07T12:01:00.000000Z',
      },
    ];

    const outcome = await service.listNotifications(subject, {
      subject,
      limit: 1,
      unreadOnly: false,
    });

    expect(outcome.kind).toBe(NOTIFICATION_OUTCOMES.OK);
    expect(outcome.page.items).toHaveLength(1);
    expect(outcome.page.items[0].id).toBe('a1');
    expect(outcome.page.pageInfo.hasNextPage).toBe(true);
    expect(outcome.page.pageInfo.nextCursor).not.toBeNull();
    expect(tx.committed).toBe(1);
  });

  it('marks notification read successfully with 204', async () => {
    const tx = new RecordingTransaction();
    const store = new FakeNotificationStore();
    const idempotency = new FakeIdempotencyStore();
    const now = new Date('2026-09-07T12:00:00.000Z');
    const service = new NotificationService(tx, store, idempotency, () => now);

    const outcome = await service.markNotificationRead(
      subject,
      notificationId,
      idempotencyKey,
    );

    expect(outcome.kind).toBe(NOTIFICATION_OUTCOMES.NO_CONTENT);
    expect(store.markCalls).toHaveLength(1);
    expect(store.markCalls[0]).toEqual({ subject, notificationId, now });
    expect(idempotency.writeCalls).toHaveLength(1);
    expect(tx.committed).toBe(1);
    expect(tx.rolledBack).toBe(0);
  });

  it('returns 404 when notification does not exist or belongs to another subject, writing NO idempotency record', async () => {
    const tx = new RecordingTransaction();
    const store = new FakeNotificationStore();
    store.markResult = false; // 0 rows updated
    const idempotency = new FakeIdempotencyStore();
    const service = new NotificationService(tx, store, idempotency);

    const outcome = await service.markNotificationRead(
      subject,
      notificationId,
      idempotencyKey,
    );

    expect(outcome.kind).toBe(NOTIFICATION_OUTCOMES.NOT_FOUND);
    expect(store.markCalls).toHaveLength(1);
    expect(idempotency.writeCalls).toHaveLength(0); // RULING 92: no partial idempotency record written!
    expect(tx.committed).toBe(1);
    expect(tx.rolledBack).toBe(0);
  });

  it('replays existing idempotency key with same fingerprint', async () => {
    const tx = new RecordingTransaction();
    const store = new FakeNotificationStore();
    const idempotency = new FakeIdempotencyStore();
    const service = new NotificationService(tx, store, idempotency);

    const fingerprint = computeRequestFingerprint({ notificationId });
    idempotency.records.set(
      `${subject}:POST /v1/notifications/{notificationId}/read:${idempotencyKey}`,
      {
        requestFingerprint: fingerprint,
        responseStatus: 204,
        responseEtag: null,
        responseBody: null,
      },
    );

    const outcome = await service.markNotificationRead(
      subject,
      notificationId,
      idempotencyKey,
    );

    expect(outcome.kind).toBe(NOTIFICATION_OUTCOMES.REPLAYED);
    expect(store.markCalls).toHaveLength(0);
    expect(tx.committed).toBe(1);
    expect(tx.rolledBack).toBe(0);
  });

  it('fires 409 conflict when idempotency key is reused with different notificationId', async () => {
    const tx = new RecordingTransaction();
    const store = new FakeNotificationStore();
    const idempotency = new FakeIdempotencyStore();
    const service = new NotificationService(tx, store, idempotency);

    const otherNotificationId = '99999999-0000-4000-8000-000000000099';
    const previousFingerprint = computeRequestFingerprint({
      notificationId: otherNotificationId,
    });
    idempotency.records.set(
      `${subject}:POST /v1/notifications/{notificationId}/read:${idempotencyKey}`,
      {
        requestFingerprint: previousFingerprint,
        responseStatus: 204,
        responseEtag: null,
        responseBody: null,
      },
    );

    const outcome = await service.markNotificationRead(
      subject,
      notificationId,
      idempotencyKey,
    );

    expect(outcome.kind).toBe(NOTIFICATION_OUTCOMES.CONFLICT);
    expect(store.markCalls).toHaveLength(0);
    expect(tx.committed).toBe(1);
    expect(tx.rolledBack).toBe(0);
  });

  it('rolls back transaction when concurrency race results in fingerprint conflict (RULING 92)', async () => {
    const tx = new RecordingTransaction();
    const store = new FakeNotificationStore();
    const idempotency = new FakeIdempotencyStore();
    idempotency.writeResult = false; // race on write
    const otherFingerprint = computeRequestFingerprint({
      notificationId: '88888888-0000-4000-8000-000000000088',
    });

    // When reread happens after race, it returns a record with different fingerprint
    let readCount = 0;
    idempotency.read = async () => {
      readCount++;
      if (readCount === 1) return undefined;
      return {
        requestFingerprint: otherFingerprint,
        responseStatus: 204,
        responseEtag: null,
        responseBody: null,
      };
    };

    const service = new NotificationService(tx, store, idempotency);

    const outcome = await service.markNotificationRead(
      subject,
      notificationId,
      idempotencyKey,
    );

    expect(outcome.kind).toBe(NOTIFICATION_OUTCOMES.CONFLICT);
    // Crucial RULING 92 assertion: the transaction MUST have rolled back because it threw!
    expect(tx.rolledBack).toBe(1);
    expect(tx.committed).toBe(0);
  });
});
