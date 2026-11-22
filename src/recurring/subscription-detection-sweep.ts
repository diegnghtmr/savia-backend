import { Logger } from '@nestjs/common';
import type { NotificationWriter } from '../platform/notification-writer.port.js';
import type {
  PgTransaction,
  TransactionClient,
} from '../platform/pg-transaction.js';
import { updateDetectedSubscriptions } from './subscription-detection.js';

interface Target extends Record<string, unknown> {
  readonly workspaceId: string;
  readonly subject: string;
}

interface PriceIncrease {
  readonly subscriptionId: string;
  readonly payeeName: string;
  readonly increasePercent: number;
}

export class SubscriptionDetectionSweep {
  public readonly intervalMs = 5 * 60_000;
  private readonly logger = new Logger(SubscriptionDetectionSweep.name);
  private afterId: string | null = null;

  public constructor(
    private readonly transaction: Pick<
      PgTransaction,
      'run' | 'runAsQueueConsumer'
    >,
    private readonly notifications: NotificationWriter,
    private readonly priceIncreases: (
      client: TransactionClient,
      workspace: string,
    ) => Promise<readonly PriceIncrease[]>,
    private readonly timeoutMs: number,
  ) {}

  public async sweep(cutoff = new Date()): Promise<number> {
    const end = performance.now() + this.timeoutMs;
    const remaining = () => Math.floor(end - performance.now());
    const discover = (timeoutMs: number) =>
      this.transaction.runAsQueueConsumer(
        async (client) =>
          (
            await client.query<Target>(
              'select * from public.find_subscription_detection_targets($1::uuid)',
              [this.afterId],
            )
          ).rows,
        timeoutMs,
      );
    let targets = await discover(this.timeoutMs);
    if (targets.length === 0 && this.afterId !== null) {
      this.afterId = null;
      const timeoutMs = remaining();
      if (timeoutMs > 0) targets = await discover(timeoutMs);
    }
    let evaluated = 0;
    for (const { workspaceId, subject } of targets) {
      const timeoutMs = remaining();
      if (timeoutMs <= 0) break;
      this.afterId = workspaceId;
      try {
        await this.transaction.run(
          subject,
          async (client) => {
            const changes = await updateDetectedSubscriptions(
              client,
              workspaceId,
              subject,
              cutoff,
            );
            for (const {
              resourceId,
              payeeName,
              previousFrequency,
              frequency,
            } of changes) {
              await this.notifications.publish(client, {
                workspaceId,
                recipientId: subject,
                resourceId,
                type: 'subscription_frequency_change',
                title: `Subscription “${payeeName}” changed from ${previousFrequency} to ${frequency}`,
              });
            }
            const increases = await this.priceIncreases(client, workspaceId);
            if (increases.length === 0) return;
            const { rows } = await client.query<{
              id: string;
              resourceId: string;
            }>(
              `select id, case when detection_observation_id is not null
                  then md5(jsonb_build_array(id, detection_observation_id)::text)::uuid
                  else md5(jsonb_build_array(id, current_amount_minor, current_currency,
                      previous_amount_minor, previous_currency)::text)::uuid
                end as "resourceId"
             from public.subscriptions where workspace_id = $1 and id = any($2::uuid[])`,
              [workspaceId, increases.map((item) => item.subscriptionId)],
            );
            const keys = new Map(rows.map((row) => [row.id, row.resourceId]));
            for (const {
              subscriptionId,
              payeeName,
              increasePercent,
            } of increases) {
              const resourceId = keys.get(subscriptionId);
              if (resourceId !== undefined)
                await this.notifications.publish(client, {
                  workspaceId,
                  recipientId: subject,
                  resourceId,
                  type: 'subscription_price_increase',
                  title: `Subscription “${payeeName}” increased by ${increasePercent}%`,
                });
            }
          },
          undefined,
          undefined,
          timeoutMs,
        );
        evaluated++;
      } catch {
        this.logger.warn(
          'Subscription detection failed; it will retry on a later sweep.',
        );
      }
    }
    return evaluated;
  }
}
