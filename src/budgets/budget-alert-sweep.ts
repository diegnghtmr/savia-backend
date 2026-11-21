import { Logger } from '@nestjs/common';
import type { NotificationWriter } from '../platform/notification-writer.port.js';
import type { PgTransaction } from '../platform/pg-transaction.js';
import type { BudgetStore } from './budget.port.js';

interface Target extends Record<string, unknown> {
  readonly budgetId: string;
  readonly workspaceId: string;
  readonly subject: string;
}

const THRESHOLDS = [80n, 100n] as const;

export class BudgetAlertSweep {
  public readonly intervalMs = 60_000;
  private readonly logger = new Logger(BudgetAlertSweep.name);
  private afterId: string | null = null;

  public constructor(
    private readonly transaction: Pick<
      PgTransaction,
      'run' | 'runAsQueueConsumer'
    >,
    private readonly budgets: Pick<BudgetStore, 'findBudget'>,
    private readonly notifications: NotificationWriter,
    private readonly timeoutMs: number,
  ) {}

  public async sweep(cutoff = new Date()): Promise<number> {
    const day = cutoff.toISOString().slice(0, 10);
    const end = performance.now() + this.timeoutMs;
    const remaining = () => Math.floor(end - performance.now());
    const discover = async (timeoutMs: number) =>
      this.transaction.runAsQueueConsumer(
        async (client) =>
          (
            await client.query<Target>(
              'select * from public.find_budget_alert_targets($1::date, $2::uuid)',
              [day, this.afterId],
            )
          ).rows,
        timeoutMs,
      );
    let targets = await discover(this.timeoutMs);
    // Cycle through the active budgets without starving later pages on re-evaluation.
    if (targets.length === 0 && this.afterId !== null) {
      this.afterId = null;
      const timeoutMs = remaining();
      if (timeoutMs > 0) targets = await discover(timeoutMs);
    }
    let evaluated = 0;
    for (const { budgetId, workspaceId, subject } of targets) {
      const timeoutMs = remaining();
      if (timeoutMs <= 0) break;
      this.afterId = budgetId;
      try {
        evaluated += await this.transaction.run(
          subject,
          async (client) => {
            const budget = await this.budgets.findBudget(
              client,
              workspaceId,
              budgetId,
            );
            if (budget === undefined) return 0;
            let actual = 0n;
            let planned = 0n;
            for (const allocation of budget.allocations) {
              actual += BigInt(allocation.actual.amountMinor);
              planned += BigInt(allocation.planned.amountMinor);
            }
            // A budget ID identifies one immutable period. B4 deduplicates by
            // workspace, recipient, event type (including threshold), and budget ID.
            for (const threshold of THRESHOLDS) {
              if (planned > 0n && actual * 100n >= planned * threshold) {
                await this.notifications.publish(client, {
                  workspaceId,
                  recipientId: subject,
                  resourceId: budgetId,
                  type: `budget_threshold_${threshold}`,
                  title: `Budget “${budget.name}” reached ${threshold}%`,
                });
              }
            }
            return 1;
          },
          undefined,
          undefined,
          timeoutMs,
        );
      } catch {
        this.logger.warn(
          'Budget evaluation failed; it will retry on a later sweep.',
        );
      }
    }
    return evaluated;
  }
}
