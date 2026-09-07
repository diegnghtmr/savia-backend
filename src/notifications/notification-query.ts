import { parseListQuery } from '../platform/list-query.js';
import type { FieldViolation } from '../platform/problem-details.js';
import type { NotificationListQuery } from './notification.port.js';

export class NotificationQueryValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Notification list query validation failed.');
    this.name = 'NotificationQueryValidationError';
  }
}

export interface NotificationListQueryInput {
  readonly cursorParam?: string;
  readonly limitParam?: string;
  readonly unreadOnlyParam?: string;
}

export function createNotificationListQuery(
  subject: string,
  input: NotificationListQueryInput,
): NotificationListQuery {
  const violations: FieldViolation[] = [];

  const base = parseListQuery({
    cursorParam: input.cursorParam,
    limitParam: input.limitParam,
  });
  violations.push(...base.violations);

  let unreadOnly = false;
  if (input.unreadOnlyParam !== undefined && input.unreadOnlyParam !== '') {
    if (input.unreadOnlyParam === 'true') {
      unreadOnly = true;
    } else if (input.unreadOnlyParam === 'false') {
      unreadOnly = false;
    } else {
      violations.push(
        Object.freeze({
          field: 'unreadOnly',
          code: 'invalid',
          message: 'unreadOnly must be a boolean.',
        }),
      );
    }
  }

  if (violations.length > 0) {
    throw new NotificationQueryValidationError(Object.freeze(violations));
  }

  return {
    subject,
    limit: base.limit,
    ...(base.cursor !== undefined ? { cursor: base.cursor } : {}),
    unreadOnly,
  };
}
