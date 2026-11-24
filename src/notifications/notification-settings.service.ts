import type { IfMatchParse } from '../platform/if-match.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { NotificationTransaction } from './notification.service.js';
import {
  parseNotificationPreferences,
  type NotificationPreferences,
  type PushDeviceRequest,
} from './notification-settings.js';
import type { PostgresNotificationSettingsAdapter } from './postgres-notification-settings.adapter.js';

export class NotificationSettingsService {
  public constructor(
    private readonly tx: NotificationTransaction,
    private readonly store: PostgresNotificationSettingsAdapter,
    private readonly idempotency: IdempotencyStore,
  ) {}

  public read(subject: string) {
    return this.tx.runRead(subject, async (client) => {
      const { preferences, version } = await this.store.readPreferences(
        client,
        subject,
      );
      return { preferences, etag: `"${version}"` };
    });
  }

  public replace(
    subject: string,
    preferences: NotificationPreferences,
    key: string,
    ifMatch: Exclude<IfMatchParse, { kind: 'malformed' }>,
  ) {
    const route = 'PUT /v1/me/notification-preferences';
    const fingerprint = computeRequestFingerprint({
      preferences,
      ifMatch:
        ifMatch.kind === 'versions'
          ? [...new Set(ifMatch.versions)].sort((a, b) => a - b)
          : ifMatch.kind,
    });
    return this.tx.run(subject, async (client) => {
      await this.store.lockPreferences(client, subject);
      const existing = await this.idempotency.read(client, subject, route, key);
      if (existing !== undefined) {
        if (existing.requestFingerprint !== fingerprint)
          return { kind: 'conflict' } as const;
        const body = parseNotificationPreferences(existing.responseBody);
        if (body === undefined || existing.responseEtag === null) {
          throw new Error('Invalid stored notification preferences response.');
        }
        return {
          kind: 'ok',
          preferences: body,
          etag: existing.responseEtag,
        } as const;
      }
      const quiet = preferences.quietHours;
      if (
        quiet !== null &&
        (quiet.start === quiet.end ||
          quiet.timezone === 'posixrules' ||
          quiet.timezone.startsWith('posix/') ||
          quiet.timezone.startsWith('right/') ||
          quiet.timezone.includes('\0') ||
          !(await this.store.isKnownTimezone(client, quiet.timezone)))
      )
        return { kind: 'invalid_quiet_hours' } as const;
      if (ifMatch.kind === 'versions') {
        const { version } = await this.store.readPreferences(client, subject);
        if (!ifMatch.versions.includes(version))
          return { kind: 'stale' } as const;
      }
      const version = await this.store.writePreferences(
        client,
        subject,
        preferences,
      );
      const etag = `"${version}"`;
      if (
        !(await this.idempotency.write(
          client,
          subject,
          route,
          key,
          fingerprint,
          200,
          etag,
          preferences,
        ))
      ) {
        throw new Error(
          'Notification preferences replay record changed while locked.',
        );
      }
      return { kind: 'ok', preferences, etag } as const;
    });
  }

  public registerDevice(subject: string, request: PushDeviceRequest) {
    return this.tx.run(subject, (client) =>
      this.store.registerDevice(client, subject, request),
    );
  }

  public removeDevice(subject: string, id: string) {
    return this.tx.run(subject, (client) =>
      this.store.removeDevice(client, subject, id),
    );
  }
}
