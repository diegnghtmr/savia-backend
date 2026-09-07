import { describe, expect, it } from 'vitest';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';
import {
  NOTIFICATION_OUTCOMES,
  type NotificationListOutcome,
  type NotificationMarkReadOutcome,
  type NotificationPort,
} from '../../src/notifications/notification.port.js';
import { NotificationsController } from '../../src/notifications/notifications.controller.js';

class FakeReply {
  public statusCode = 200;
  public sentBody: unknown = null;
  public headers: Record<string, string> = {};
  public request = { id: 'test-req-id', url: '/v1/notifications' };

  public status(code: number): this {
    this.statusCode = code;
    return this;
  }

  public type(_contentType?: string): this {
    void _contentType;
    return this;
  }

  public send(payload?: unknown): this {
    this.sentBody = payload;
    return this;
  }

  public header(name: string, value: string): this {
    this.headers[name] = value;
    return this;
  }
}

class FakeNotificationPort implements NotificationPort {
  public listResult: NotificationListOutcome = {
    kind: NOTIFICATION_OUTCOMES.OK,
    page: {
      items: [],
      pageInfo: { hasNextPage: false, nextCursor: null },
    },
  };

  public markResult: NotificationMarkReadOutcome = {
    kind: NOTIFICATION_OUTCOMES.NO_CONTENT,
  };

  public listCalls: unknown[] = [];
  public markCalls: unknown[] = [];

  public async listNotifications(
    subject: string,
    query: unknown,
  ): Promise<NotificationListOutcome> {
    this.listCalls.push({ subject, query });
    return this.listResult;
  }

  public async markNotificationRead(
    subject: string,
    notificationId: string,
    idempotencyKey: string,
  ): Promise<NotificationMarkReadOutcome> {
    this.markCalls.push({ subject, notificationId, idempotencyKey });
    return this.markResult;
  }
}

describe('NotificationsController', () => {
  const subject = '11111111-0000-4000-8000-000000000001';
  const notificationId = '22222222-0000-4000-8000-000000000002';
  const idempotencyKey = '33333333-0000-4000-8000-000000000003';

  it('lists notifications returning 200', async () => {
    const port = new FakeNotificationPort();
    const controller = new NotificationsController(port);
    const reply = new FakeReply() as unknown as FastifyReply;
    const req = {
      identity: { subject },
      headers: {},
    } as unknown as AuthenticatedRequest;

    await controller.listNotifications(req, reply, undefined, '10', 'true');

    expect((reply as unknown as FakeReply).statusCode).toBe(200);
    expect((reply as unknown as FakeReply).sentBody).toEqual(
      port.listResult.page,
    );
    expect(port.listCalls).toHaveLength(1);
  });

  it('returns 400 when list query is invalid', async () => {
    const port = new FakeNotificationPort();
    const controller = new NotificationsController(port);
    const reply = new FakeReply() as unknown as FastifyReply;
    const req = {
      identity: { subject },
      headers: {},
    } as unknown as AuthenticatedRequest;

    await controller.listNotifications(
      req,
      reply,
      undefined,
      'invalid-limit',
      undefined,
    );

    expect((reply as unknown as FakeReply).statusCode).toBe(400);
    expect(port.listCalls).toHaveLength(0);
  });

  it('returns 400 on missing or invalid idempotency key', async () => {
    const port = new FakeNotificationPort();
    const controller = new NotificationsController(port);
    const reply = new FakeReply() as unknown as FastifyReply;
    const req = {
      identity: { subject },
      headers: {}, // missing idempotency-key
    } as unknown as AuthenticatedRequest;

    await controller.markNotificationRead(notificationId, req, reply);

    expect((reply as unknown as FakeReply).statusCode).toBe(400);
    expect(port.markCalls).toHaveLength(0);
  });

  it('returns 400 on invalid UUID notificationId', async () => {
    const port = new FakeNotificationPort();
    const controller = new NotificationsController(port);
    const reply = new FakeReply() as unknown as FastifyReply;
    const req = {
      identity: { subject },
      headers: { 'idempotency-key': idempotencyKey },
    } as unknown as AuthenticatedRequest;

    await controller.markNotificationRead('not-a-uuid', req, reply);

    expect((reply as unknown as FakeReply).statusCode).toBe(400);
    expect(port.markCalls).toHaveLength(0);
  });

  it('returns 204 on successful mark read', async () => {
    const port = new FakeNotificationPort();
    port.markResult = { kind: NOTIFICATION_OUTCOMES.NO_CONTENT };
    const controller = new NotificationsController(port);
    const reply = new FakeReply() as unknown as FastifyReply;
    const req = {
      identity: { subject },
      headers: { 'idempotency-key': idempotencyKey },
    } as unknown as AuthenticatedRequest;

    await controller.markNotificationRead(notificationId, req, reply);

    expect((reply as unknown as FakeReply).statusCode).toBe(204);
    expect((reply as unknown as FakeReply).sentBody).toBeUndefined();
  });

  it('returns 204 on replayed mark read', async () => {
    const port = new FakeNotificationPort();
    port.markResult = { kind: NOTIFICATION_OUTCOMES.REPLAYED, status: 204 };
    const controller = new NotificationsController(port);
    const reply = new FakeReply() as unknown as FastifyReply;
    const req = {
      identity: { subject },
      headers: { 'idempotency-key': idempotencyKey },
    } as unknown as AuthenticatedRequest;

    await controller.markNotificationRead(notificationId, req, reply);

    expect((reply as unknown as FakeReply).statusCode).toBe(204);
  });

  it('returns 404 when notification is not found', async () => {
    const port = new FakeNotificationPort();
    port.markResult = { kind: NOTIFICATION_OUTCOMES.NOT_FOUND };
    const controller = new NotificationsController(port);
    const reply = new FakeReply() as unknown as FastifyReply;
    const req = {
      identity: { subject },
      headers: { 'idempotency-key': idempotencyKey },
    } as unknown as AuthenticatedRequest;

    await controller.markNotificationRead(notificationId, req, reply);

    expect((reply as unknown as FakeReply).statusCode).toBe(404);
  });

  it('returns 409 on idempotency conflict', async () => {
    const port = new FakeNotificationPort();
    port.markResult = { kind: NOTIFICATION_OUTCOMES.CONFLICT };
    const controller = new NotificationsController(port);
    const reply = new FakeReply() as unknown as FastifyReply;
    const req = {
      identity: { subject },
      headers: { 'idempotency-key': idempotencyKey },
    } as unknown as AuthenticatedRequest;

    await controller.markNotificationRead(notificationId, req, reply);

    expect((reply as unknown as FakeReply).statusCode).toBe(409);
  });
});
