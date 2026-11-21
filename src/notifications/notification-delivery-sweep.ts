import { Logger } from '@nestjs/common';
import { computeBackoffBase } from '../platform/job-retry-policy.js';
import type { PgTransaction } from '../platform/pg-transaction.js';
import type {
  NotificationDeliveryPort,
  NotificationDeliveryResult,
} from './notification-delivery.port.js';

const POLL_MS = 5_000;
const DIGEST_POLL_MS = 60_000;
const DB_TIMEOUT_MS = 5_000;
const BATCH_SIZE = 10;

export interface NotificationClaim extends Record<string, unknown> {
  readonly delivery_id: string;
  readonly lease_id: string;
  readonly attempts: number;
  readonly recipient: string;
  readonly title: string;
  readonly body: string | null;
}

export interface NotificationDeliveryStore {
  scheduleDigests(): Promise<void>;
  claim(emailConfigured: boolean): Promise<NotificationClaim | undefined>;
  finish(
    claim: NotificationClaim,
    result: NotificationDeliveryResult,
    seconds: number,
  ): Promise<void>;
}

export class PostgresNotificationDeliveryStore
  implements NotificationDeliveryStore
{
  public constructor(private readonly transaction: PgTransaction) {}

  public async scheduleDigests(): Promise<void> {
    await this.transaction.runAsQueueConsumer(
      (client) => client.query('select public.schedule_notification_digests()'),
      DB_TIMEOUT_MS,
    );
  }

  public claim(
    emailConfigured: boolean,
  ): Promise<NotificationClaim | undefined> {
    return this.transaction.runAsQueueConsumer(async (client) => {
      const { rows } = await client.query<NotificationClaim>(
        'select * from public.claim_notification_delivery($1)',
        [emailConfigured],
      );
      return rows[0];
    }, DB_TIMEOUT_MS);
  }

  public async finish(
    claim: NotificationClaim,
    result: NotificationDeliveryResult,
    seconds: number,
  ): Promise<void> {
    await this.transaction.runAsQueueConsumer(
      (client) =>
        client.query(
          'select public.finish_notification_delivery($1, $2, $3, $4)',
          [claim.delivery_id, claim.lease_id, result, seconds],
        ),
      DB_TIMEOUT_MS,
    );
  }
}

export class NotificationDeliverySweep {
  private readonly logger = new Logger(NotificationDeliverySweep.name);
  private controller?: AbortController;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private nextDigestPoll = 0;

  public constructor(
    private readonly store: NotificationDeliveryStore,
    private readonly email?: NotificationDeliveryPort,
  ) {}

  public start(): void {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    const poll = () => {
      void this.runOnce()
        .catch(() => {
          this.logger.warn('Notification delivery sweep failed.');
        })
        .finally(() => {
          if (!controller.signal.aborted)
            this.timer = setTimeout(poll, POLL_MS).unref();
        });
    };
    poll();
  }

  public async beforeApplicationShutdown(): Promise<void> {
    this.controller?.abort();
    clearTimeout(this.timer);
    await this.inFlight?.catch(() => undefined);
  }

  public runOnce(): Promise<void> {
    this.inFlight ??= this.sweep(this.controller?.signal).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async sweep(signal?: AbortSignal): Promise<void> {
    if (!signal?.aborted && performance.now() >= this.nextDigestPoll) {
      await this.store.scheduleDigests();
      this.nextDigestPoll = performance.now() + DIGEST_POLL_MS;
    }
    for (let index = 0; index < BATCH_SIZE && !signal?.aborted; index++) {
      const claim = await this.store.claim(this.email !== undefined);
      // Without a provider the DB still retires tokenless pushes, but does not lease email.
      if (claim === undefined || this.email === undefined) return;
      const result = await this.email
        .deliver({
          to: claim.recipient,
          title: claim.title,
          body: claim.body,
          idempotencyKey: claim.delivery_id,
        })
        .catch(() => 'retryable' as const);
      await this.store.finish(
        claim,
        result,
        computeBackoffBase(claim.attempts),
      );
    }
  }
}
