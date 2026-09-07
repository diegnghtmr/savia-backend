import { encodeCursor } from '../platform/cursor.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  NOTIFICATION_OUTCOMES,
  type NotificationListOutcome,
  type NotificationListQuery,
  type NotificationMarkReadOutcome,
  type NotificationPort,
  type NotificationStore,
} from './notification.port.js';

export interface NotificationTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export class NotificationRollbackError extends Error {
  public constructor(public readonly outcome: 'conflict') {
    super(`Notification transaction rollback: ${outcome}`);
    this.name = 'NotificationRollbackError';
  }
}

export class NotificationService implements NotificationPort {
  public constructor(
    private readonly tx: NotificationTransaction,
    private readonly store: NotificationStore,
    private readonly idempotency: IdempotencyStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async listNotifications(
    subject: string,
    query: NotificationListQuery,
  ): Promise<NotificationListOutcome> {
    return this.tx.runRead(subject, async (client) => {
      const rows = await this.store.listNotifications(
        client,
        subject,
        query.unreadOnly,
        query.limit + 1,
        query.cursor,
      );

      const hasNextPage = rows.length > query.limit;
      const visible = hasNextPage ? rows.slice(0, query.limit) : rows;
      const last = visible[visible.length - 1];

      const nextCursor =
        hasNextPage && last !== undefined
          ? encodeCursor({
              createdAt: last.cursorAt,
              id: last.id,
            })
          : null;

      return {
        kind: NOTIFICATION_OUTCOMES.OK,
        page: {
          items: visible.map((row) => ({
            id: row.id,
            type: row.type,
            title: row.title,
            body: row.body,
            read: row.read,
            actionUrl: row.actionUrl,
            createdAt: row.createdAt,
          })),
          pageInfo: {
            hasNextPage,
            nextCursor,
          },
        },
      };
    });
  }

  public async markNotificationRead(
    subject: string,
    notificationId: string,
    idempotencyKey: string,
  ): Promise<NotificationMarkReadOutcome> {
    const route = 'POST /v1/notifications/{notificationId}/read';
    const fingerprint = computeRequestFingerprint({ notificationId });

    try {
      return await this.tx.run(subject, async (client) => {
        // 1. Check idempotency record first (read-only)
        const existing = await this.idempotency.read(
          client,
          subject,
          route,
          idempotencyKey,
          null,
        );

        if (existing !== undefined) {
          if (existing.requestFingerprint !== fingerprint) {
            return { kind: NOTIFICATION_OUTCOMES.CONFLICT };
          }
          return {
            kind: NOTIFICATION_OUTCOMES.REPLAYED,
            status: existing.responseStatus,
          };
        }

        // 2. Perform atomic UPDATE (zero rows returned -> 404)
        const updated = await this.store.markNotificationRead(
          client,
          subject,
          notificationId,
          this.clock(),
        );

        if (!updated) {
          // Zero rows matched: not found or belongs to another subject.
          // No write was performed on notifications or idempotency store.
          return { kind: NOTIFICATION_OUTCOMES.NOT_FOUND };
        }

        // 3. Persist idempotency record
        const written = await this.idempotency.write(
          client,
          subject,
          route,
          idempotencyKey,
          fingerprint,
          204,
          null,
          null,
          null,
        );

        if (!written) {
          const reread = await this.idempotency.read(
            client,
            subject,
            route,
            idempotencyKey,
            null,
          );

          if (reread !== undefined) {
            if (reread.requestFingerprint === fingerprint) {
              return {
                kind: NOTIFICATION_OUTCOMES.REPLAYED,
                status: reread.responseStatus,
              };
            }
            // Fingerprint mismatch won the race: rollback atomic update!
            throw new NotificationRollbackError('conflict');
          }

          throw new Error(
            'Notification idempotency record could not be reread.',
          );
        }

        return { kind: NOTIFICATION_OUTCOMES.NO_CONTENT };
      });
    } catch (error) {
      if (
        error instanceof NotificationRollbackError &&
        error.outcome === 'conflict'
      ) {
        return { kind: NOTIFICATION_OUTCOMES.CONFLICT };
      }
      throw error;
    }
  }
}
