import { Logger } from '@nestjs/common';
import type {
  BudgetThreshold,
  BudgetThresholdNotificationWriter,
} from '../platform/notification-writer.port.js';
import type { PgTransaction } from '../platform/pg-transaction.js';
import type { BudgetStore } from './budget.port.js';

interface Target extends Record<string, unknown> {
  readonly budgetId: string;
  readonly workspaceId: string;
  readonly subject: string;
}

const THRESHOLDS = [80, 100] as const satisfies readonly BudgetThreshold[];

export class BudgetAlertSweep {
  public readonly intervalMs = 60_000;
  private readonly logger = new Logger(BudgetAlertSweep.name);
  private afterId: string | null = null;

  public constructor(
    private readonly transaction: Pick<
      PgTransaction,
      'runRead' | 'runAsQueueConsumer'
    >,
    private readonly budgets: Pick<BudgetStore, 'findBudget'>,
    private readonly notifications: BudgetThresholdNotificationWriter,
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
        const crossed = await this.transaction.runRead(
          subject,
          async (client) => {
            const budget = await this.budgets.findBudget(
              client,
              workspaceId,
              budgetId,
            );
            if (budget === undefined) return undefined;
            let actual = 0n;
            let planned = 0n;
            for (const allocation of budget.allocations) {
              actual += BigInt(allocation.actual.amountMinor);
              planned += BigInt(allocation.planned.amountMinor);
            }
            return THRESHOLDS.filter(
              (threshold) =>
                planned > 0n && actual * 100n >= planned * BigInt(threshold),
            );
          },
          timeoutMs,
        );
        if (crossed === undefined) continue;
        if (crossed.length > 0) {
          const publishTimeout = remaining();
          if (publishTimeout <= 0) break;
          await this.transaction.runAsQueueConsumer(
            (client) =>
              this.notifications.publishBudgetThresholds(
                client,
                workspaceId,
                budgetId,
                day,
                crossed,
              ),
            publishTimeout,
          );
        }
        evaluated++;
      } catch {
        this.logger.warn(
          'Budget evaluation failed; it will retry on a later sweep.',
        );
      }
    }
    return evaluated;
  }
}
