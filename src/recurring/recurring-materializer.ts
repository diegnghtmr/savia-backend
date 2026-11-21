import { randomUUID } from 'node:crypto';
import type {
  CreateTransactionCommand,
  LedgerWriter,
} from '../platform/ledger-writer.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  computeNextOccurrence,
  type RecurringBehavior,
  type RecurringFrequency,
} from './occurrence.js';

export interface DueOccurrence {
  readonly workspaceId: string;
  readonly subject: string;
  readonly ruleId: string;
  readonly scheduledAt: string;
  readonly asOf: string;
}

export interface DueRule {
  readonly frequency: RecurringFrequency;
  readonly rrule: string | null;
  readonly behavior: RecurringBehavior;
  readonly template: CreateTransactionCommand;
  readonly startsAt: Date | string;
  readonly endsAt: Date | string | null;
  readonly anchorDayOfMonth: number;
}

export interface MaterializedOccurrence {
  readonly id: string;
  readonly behavior: RecurringBehavior;
  readonly transactionId: string | null;
  readonly nextOccurrenceAt: string | null;
}

export interface OccurrenceStore {
  lockDue(
    client: TransactionClient,
    due: DueOccurrence,
  ): Promise<DueRule | undefined>;
  record(
    client: TransactionClient,
    due: DueOccurrence,
    occurrence: MaterializedOccurrence,
  ): Promise<void>;
}

const statusByBehavior = {
  remind: null,
  create_draft: 'draft',
  create_pending: 'pending',
  confirm_automatically: 'confirmed',
} as const satisfies Record<
  RecurringBehavior,
  CreateTransactionCommand['status'] | null
>;

export class RecurringMaterializer {
  public constructor(
    private readonly store: OccurrenceStore,
    private readonly ledger: Pick<LedgerWriter, 'createTransaction'>,
  ) {}

  // The caller owns the creator-scoped write transaction (including job completion).
  public async materialize(
    client: TransactionClient,
    due: DueOccurrence,
  ): Promise<string | null> {
    const rule = await this.store.lockDue(client, due);
    if (!rule) return null;

    const scheduledAt = new Date(due.scheduledAt);
    const { nextOccurrenceAt } = computeNextOccurrence({
      frequency: rule.frequency,
      rrule: rule.rrule,
      currentOccurrence: scheduledAt,
      anchorDayOfMonth: rule.anchorDayOfMonth,
      anchorMonth: new Date(rule.startsAt).getUTCMonth(),
    });
    const isLast =
      rule.endsAt !== null && nextOccurrenceAt > new Date(rule.endsAt);
    const id = randomUUID();
    const status = statusByBehavior[rule.behavior];
    const transactionId =
      status === null
        ? null
        : requireCreatedId(
            await this.ledger.createTransaction(
              client,
              due.subject,
              due.workspaceId,
              {
                ...rule.template,
                status,
                occurredAt: scheduledAt.toISOString(),
              },
              id,
            ),
          );

    // A persisted reminder occurrence (without a transaction) is the B4 producer seam.
    await this.store.record(client, due, {
      id,
      behavior: rule.behavior,
      transactionId,
      nextOccurrenceAt: isLast ? null : nextOccurrenceAt.toISOString(),
    });
    return id;
  }
}

function requireCreatedId(outcome: unknown): string {
  if (
    typeof outcome === 'object' &&
    outcome !== null &&
    'kind' in outcome &&
    outcome.kind === 'created' &&
    'transaction' in outcome &&
    typeof outcome.transaction === 'object' &&
    outcome.transaction !== null &&
    'id' in outcome.transaction &&
    typeof outcome.transaction.id === 'string'
  ) {
    return outcome.transaction.id;
  }
  throw new Error('Recurring occurrence transaction was not created.');
}
