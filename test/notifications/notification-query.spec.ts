import { describe, expect, it } from 'vitest';
import {
  createNotificationListQuery,
  NotificationQueryValidationError,
} from '../../src/notifications/notification-query.js';

describe('notification-query', () => {
  const subject = '11111111-0000-4000-8000-000000000001';

  it('parses valid defaults when no query params provided', () => {
    const query = createNotificationListQuery(subject, {});
    expect(query).toEqual({
      subject,
      limit: 50,
      unreadOnly: false,
    });
  });

  it('parses valid limit and unreadOnly=true', () => {
    const query = createNotificationListQuery(subject, {
      limitParam: '25',
      unreadOnlyParam: 'true',
    });
    expect(query).toEqual({
      subject,
      limit: 25,
      unreadOnly: true,
    });
  });

  it('parses unreadOnly=false', () => {
    const query = createNotificationListQuery(subject, {
      unreadOnlyParam: 'false',
    });
    expect(query.unreadOnly).toBe(false);
  });

  it('rejects invalid unreadOnly parameter', () => {
    expect(() =>
      createNotificationListQuery(subject, {
        unreadOnlyParam: 'not-a-bool',
      }),
    ).toThrow(NotificationQueryValidationError);

    try {
      createNotificationListQuery(subject, { unreadOnlyParam: 'yes' });
    } catch (error) {
      expect(error).toBeInstanceOf(NotificationQueryValidationError);
      const err = error as NotificationQueryValidationError;
      expect(err.violations).toEqual([
        {
          field: 'unreadOnly',
          code: 'invalid',
          message: 'unreadOnly must be a boolean.',
        },
      ]);
    }
  });

  it('rejects invalid limit parameter', () => {
    expect(() =>
      createNotificationListQuery(subject, {
        limitParam: '0',
      }),
    ).toThrow(NotificationQueryValidationError);

    expect(() =>
      createNotificationListQuery(subject, {
        limitParam: '201',
      }),
    ).toThrow(NotificationQueryValidationError);

    expect(() =>
      createNotificationListQuery(subject, {
        limitParam: 'abc',
      }),
    ).toThrow(NotificationQueryValidationError);
  });

  it('rejects invalid cursor parameter', () => {
    expect(() =>
      createNotificationListQuery(subject, {
        cursorParam: 'invalid-cursor-string',
      }),
    ).toThrow(NotificationQueryValidationError);
  });
});
