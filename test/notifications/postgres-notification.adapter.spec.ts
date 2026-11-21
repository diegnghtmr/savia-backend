import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PostgresNotificationAdapter } from '../../src/notifications/postgres-notification.adapter.js';

const event = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  recipientId: '22222222-2222-4222-8222-222222222222',
  resourceId: '33333333-3333-4333-8333-333333333333',
  type: 'report_completed',
  title: 'Report available',
};

describe('PostgresNotificationAdapter publication', () => {
  it('delegates deduplication to PostgreSQL on the complete key without updating the row', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(
      new PostgresNotificationAdapter().publish({ query }, event),
    ).resolves.toBeUndefined();
    expect(query.mock.calls).toEqual([
      ['savepoint notification_publish'],
      [
        expect.stringMatching(
          /on conflict \(workspace_id, subject_id, type, resource_id\) do nothing/,
        ),
        [
          event.workspaceId,
          event.recipientId,
          event.type,
          event.resourceId,
          event.title,
        ],
      ],
      ['release savepoint notification_publish'],
    ]);
  });

  it('rolls back only the failed notification statement and releases the savepoint', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const query = vi.fn().mockResolvedValue({ rows: [] });
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('insert rejected'));
    try {
      await expect(
        new PostgresNotificationAdapter().publish({ query }, event),
      ).resolves.toBeUndefined();
      expect(query.mock.calls.map(([sql]) => sql)).toEqual([
        'savepoint notification_publish',
        expect.stringMatching(/insert into public.notifications/),
        'rollback to savepoint notification_publish',
        'release savepoint notification_publish',
      ]);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'In-app notification insert failed.',
      );
    } finally {
      warn.mockRestore();
    }
  });
});
