import { randomUUID } from 'node:crypto';
import { encodeCursor, type Cursor } from '../platform/cursor.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { IfMatchParse } from '../platform/if-match.js';
import type { OccurrenceLedgerWriter } from '../platform/ledger-writer.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  OccurrenceEdit,
  TemplateChanges,
} from './occurrence-edit-command.js';
import { isCadenceSlot } from './occurrence.js';
import type {
  PostgresOccurrenceActionsAdapter,
  OccurrenceStatus,
  OccurrenceRow,
} from './postgres-occurrence-actions.adapter.js';
import type { PostgresRecurringAdapter } from './postgres-recurring.adapter.js';
import {
  createdTransactionId,
  followingSlot,
} from './recurring-materializer.js';
import type { RecurringTransaction } from './recurring.service.js';

export type OccurrenceAction = 'confirm' | 'skip';
export interface RuleTarget {
  readonly workspaceId: string;
  readonly ruleId: string;
}
export interface OccurrenceQuery extends RuleTarget {
  readonly status?: OccurrenceStatus;
  readonly cursor?: Cursor;
  readonly limit: number;
}
interface CommandHeaders extends RuleTarget {
  readonly key: string;
  readonly ifMatch: Exclude<IfMatchParse, { kind: 'malformed' }>;
}
type SlotAction =
  | { readonly action: OccurrenceAction }
  | Exclude<OccurrenceEdit, { action: 'edit-series' }>;
type SlotCommand = CommandHeaders & {
  readonly occurrenceId: string;
} & SlotAction;
export type OccurrenceCommand =
  | SlotCommand
  | (CommandHeaders & Extract<OccurrenceEdit, { action: 'edit-series' }>);
type Rule = NonNullable<
  Awaited<ReturnType<PostgresOccurrenceActionsAdapter['readRule']>>
>;

export type ActionOutcome =
  | {
      readonly kind: 'ok';
      readonly body: unknown;
      readonly status: number;
      readonly etag: string | null;
    }
  | {
      readonly kind:
        | 'forbidden'
        | 'notFound'
        | 'state'
        | 'precondition'
        | 'idempotency'
        | 'invalid'
        | 'invalidChange';
    };

export function occurrenceFilter(
  ruleId: string,
  status?: OccurrenceStatus,
): string {
  return `${ruleId}:${status ?? ''}`;
}

function present(ruleId: string, occurrence: OccurrenceRow) {
  return {
    id: occurrence.id,
    ruleId,
    originalScheduledAt: occurrence.originalScheduledAt,
    scheduledAt: occurrence.scheduledAt,
    status: occurrence.status,
    transactionId: occurrence.transactionId,
    amount: occurrence.amount,
    description: occurrence.description,
    categoryId: occurrence.categoryId,
    etag: `"${occurrence.version}"`,
  };
}

function actionRoute(command: OccurrenceCommand): string {
  const root = '/v1/recurring-rules/:ruleId';
  const occurrence = `${root}/occurrences/:occurrenceId`;
  switch (command.action) {
    case 'edit-series':
      return `POST ${root}/edit-series`;
    case 'edit-one':
      return `PATCH ${occurrence}`;
    default:
      return `POST ${occurrence}/${command.action}`;
  }
}

function stale(command: OccurrenceCommand, version: number): boolean {
  return (
    command.ifMatch.kind === 'versions' &&
    !command.ifMatch.versions.includes(version)
  );
}

function bookingOf(row: OccurrenceRow) {
  const { status, transactionId, bookingVersion, template } = row;
  if (status !== 'draft' && status !== 'pending') return undefined;
  if (transactionId === null || bookingVersion === null)
    throw new Error('Occurrence booking is missing.');
  return {
    id: transactionId,
    accountId: template.accountId,
    status,
    version: bookingVersion,
  };
}

export class RecurringOccurrenceActionsService {
  public constructor(
    private readonly transaction: RecurringTransaction,
    private readonly roles: Pick<PostgresRecurringAdapter, 'readActiveRole'>,
    private readonly store: PostgresOccurrenceActionsAdapter,
    private readonly ledger: OccurrenceLedgerWriter,
    private readonly idempotency: IdempotencyStore,
  ) {}

  public list(subject: string, query: OccurrenceQuery): Promise<ActionOutcome> {
    const { workspaceId, ruleId, limit, status } = query;
    return this.transaction.runRead(subject, async (client) => {
      const role = await this.roles.readActiveRole(client, workspaceId);
      if (!['owner', 'administrator', 'editor', 'viewer'].includes(role ?? ''))
        return { kind: 'forbidden' };
      const rule = await this.store.readRule(client, workspaceId, ruleId);
      if (!rule) return { kind: 'notFound' };
      const pageQuery = { ...query, limit: limit + 1 };
      const rows = await this.store.readOccurrences(
        client,
        workspaceId,
        ruleId,
        pageQuery,
      );
      const hasNextPage = rows.length > limit;
      const visible = rows.slice(0, limit);
      const last = visible.at(-1);
      const nextCursor =
        hasNextPage && last
          ? encodeCursor({
              workspaceId,
              createdAt: last.cursorAt,
              id: last.id,
              filter: occurrenceFilter(ruleId, status),
            })
          : null;
      return {
        kind: 'ok',
        status: 200,
        etag: null,
        body: {
          items: visible.map((row) => present(ruleId, row)),
          pageInfo: { hasNextPage, nextCursor },
          ruleEtag: `"${rule.version}"`,
        },
      };
    });
  }

  public run(
    subject: string,
    command: OccurrenceCommand,
  ): Promise<ActionOutcome> {
    const { workspaceId, ruleId, key, ifMatch } = command;
    const route = actionRoute(command);
    const fingerprint = computeRequestFingerprint({
      ruleId,
      ...('occurrenceId' in command && { occurrenceId: command.occurrenceId }),
      ifMatch:
        ifMatch.kind === 'versions'
          ? [...new Set(ifMatch.versions)].sort((a, b) => a - b)
          : ifMatch.kind,
      ...('changes' in command && { changes: command.changes }),
      ...('effectiveFrom' in command && {
        effectiveFrom: command.effectiveFrom,
      }),
      ...('scheduledAt' in command && { scheduledAt: command.scheduledAt }),
    });
    return this.transaction.run(subject, async (client) => {
      const role = await this.roles.readActiveRole(client, workspaceId);
      if (!['owner', 'administrator', 'editor'].includes(role ?? ''))
        return { kind: 'forbidden' };
      // Same rule lock used by the worker; keep the membership valid through commit.
      const rule = await this.store.readRule(client, workspaceId, ruleId, true);
      if (!rule) return { kind: 'notFound' };
      if (
        rule.creator !== subject.toLowerCase() ||
        !(await this.store.lockCreatorMembership(client, workspaceId))
      )
        return { kind: 'forbidden' };
      const replay = await this.idempotency.read(
        client,
        subject,
        route,
        key,
        workspaceId,
      );
      if (replay)
        return replay.requestFingerprint === fingerprint
          ? {
              kind: 'ok',
              status: replay.responseStatus,
              body: replay.responseBody,
              etag: replay.responseEtag,
            }
          : { kind: 'idempotency' };

      const result =
        command.action === 'edit-series'
          ? await this.editSeries(client, command, rule)
          : await this.applyOccurrence(client, subject, command, rule);
      if (result.kind !== 'ok') return result;
      // PgTransaction serializes same-subject writes; a conflict here must roll back the change.
      const written = await this.idempotency.write(
        client,
        subject,
        route,
        key,
        fingerprint,
        result.status,
        result.etag,
        result.body,
        workspaceId,
      );
      if (!written) throw new Error('Occurrence idempotency write failed.');
      return result;
    });
  }

  private async editSeries(
    client: TransactionClient,
    command: Extract<OccurrenceCommand, { action: 'edit-series' }>,
    rule: Rule,
  ): Promise<ActionOutcome> {
    const { workspaceId, ruleId, effectiveFrom, changes } = command;
    if (stale(command, rule.version)) return { kind: 'precondition' };
    if (
      !(await this.validChanges(
        client,
        workspaceId,
        rule.template.amount.currency,
        changes,
      ))
    )
      return { kind: 'invalidChange' };
    const version = await this.store.editSeries(
      client,
      workspaceId,
      ruleId,
      effectiveFrom,
      changes,
    );
    if (version === undefined) return { kind: 'invalidChange' };
    return {
      kind: 'ok',
      status: 200,
      etag: `"${version}"`,
      body: { ruleId, effectiveFrom, changes },
    };
  }

  private async validChanges(
    client: TransactionClient,
    workspaceId: string,
    currency: string,
    changes: TemplateChanges,
  ): Promise<boolean> {
    return (
      (!changes.amount || changes.amount.currency === currency) &&
      (!changes.categoryId ||
        (await this.store.hasCategory(client, workspaceId, changes.categoryId)))
    );
  }

  private async applyOccurrence(
    client: TransactionClient,
    subject: string,
    command: SlotCommand,
    rule: Rule,
  ): Promise<ActionOutcome> {
    const { workspaceId, ruleId, occurrenceId, action } = command;
    const target = { id: occurrenceId, limit: 1 };
    const [before] = await this.store.readOccurrences(
      client,
      workspaceId,
      ruleId,
      target,
    );
    if (!before) return { kind: 'notFound' };
    if (stale(command, before.version)) return { kind: 'precondition' };
    if (action === 'reschedule') {
      const failure = await this.reschedule(client, command, rule, before);
      if (failure) return failure;
    } else if (action === 'edit-one') {
      if (before.status !== 'scheduled' && before.status !== 'reminder')
        return { kind: 'state' };
      if (
        !(await this.validChanges(
          client,
          workspaceId,
          rule.template.amount.currency,
          command.changes,
        ))
      )
        return { kind: 'invalidChange' };
      await this.store.saveSlotEdit(
        client,
        workspaceId,
        ruleId,
        before,
        command.changes,
      );
    } else {
      const failure = await this.settle(
        client,
        subject,
        command,
        rule,
        before,
        action,
      );
      if (failure) return failure;
    }
    const [after] = await this.store.readOccurrences(
      client,
      workspaceId,
      ruleId,
      target,
    );
    if (!after) throw new Error('Updated occurrence is missing.');
    const body = present(ruleId, after);
    return { kind: 'ok', status: 200, body, etag: body.etag };
  }

  private async reschedule(
    client: TransactionClient,
    command: Extract<SlotCommand, { action: 'reschedule' }>,
    rule: Rule,
    before: OccurrenceRow,
  ): Promise<ActionOutcome | undefined> {
    const { workspaceId, ruleId, scheduledAt } = command;
    const booking = bookingOf(before);
    const unbooked =
      before.status === 'scheduled' || before.status === 'reminder';
    if (!booking && !unbooked) return { kind: 'state' };
    const date = new Date(scheduledAt);
    const cadenceCollision =
      rule.active &&
      scheduledAt !== before.originalScheduledAt &&
      scheduledAt === date.toISOString() &&
      (rule.endsAt === null || date <= new Date(rule.endsAt)) &&
      isCadenceSlot({
        frequency: rule.frequency,
        rrule: rule.rrule,
        first: rule.nextOccurrenceAt,
        target: date,
        anchorDayOfMonth: rule.anchorDayOfMonth,
        anchorMonth: new Date(rule.startsAt).getUTCMonth(),
      });
    if (
      cadenceCollision ||
      (await this.store.hasEffectiveSlot(
        client,
        workspaceId,
        ruleId,
        before.id,
        scheduledAt,
      ))
    )
      return { kind: 'state' };
    if (scheduledAt === before.scheduledAt) return undefined;
    if (
      booking &&
      !(await this.ledger.rescheduleOccurrenceBooking(
        client,
        workspaceId,
        booking,
        scheduledAt,
      ))
    )
      return { kind: 'state' };
    await this.store.saveSlotEdit(
      client,
      workspaceId,
      ruleId,
      before,
      {},
      scheduledAt,
    );
    if (before.status === 'scheduled' && !before.detached)
      await this.store.advance(
        client,
        workspaceId,
        ruleId,
        followingSlot(rule, new Date(before.originalScheduledAt)),
      );
    return undefined;
  }

  private async settle(
    client: TransactionClient,
    subject: string,
    command: SlotCommand,
    rule: Rule,
    before: OccurrenceRow,
    action: OccurrenceAction,
  ): Promise<ActionOutcome | undefined> {
    const { workspaceId, ruleId, occurrenceId } = command;
    const { status, template, scheduledAt, cursorAt, detached } = before;
    const booking = bookingOf(before);
    let transactionId = before.transactionId;
    if (booking) {
      if (action === 'confirm') {
        const result = await this.ledger.confirmOccurrenceBooking(
          client,
          workspaceId,
          booking,
        );
        if (result !== 'confirmed')
          return { kind: result === 'invalid' ? 'invalid' : 'state' };
      } else {
        const voided = await this.ledger.voidOccurrenceBooking(
          client,
          workspaceId,
          booking,
        );
        if (!voided) return { kind: 'state' };
      }
    } else if (status === 'reminder') {
      if (action === 'confirm') {
        const created = await this.ledger.createTransaction(
          client,
          subject,
          workspaceId,
          {
            ...template,
            status: 'confirmed',
            occurredAt: scheduledAt,
            receiptId: null,
          },
          randomUUID(),
        );
        transactionId = createdTransactionId(created) ?? null;
        if (transactionId === null) return { kind: 'invalid' };
      }
    } else if (status !== 'scheduled' || action !== 'skip') {
      return { kind: 'state' };
    }

    if (status === 'scheduled') {
      const slot = {
        workspaceId,
        ruleId,
        subject,
        scheduledAt: cursorAt,
        asOf: scheduledAt,
      };
      const nextOccurrenceAt = detached
        ? null
        : followingSlot(rule, new Date(before.originalScheduledAt));
      await this.store.record(client, slot, {
        id: occurrenceId,
        behavior: rule.behavior,
        transactionId: null,
        nextOccurrenceAt,
        skipped: true,
        detached,
      });
    } else {
      await this.store.settle(
        client,
        workspaceId,
        ruleId,
        occurrenceId,
        transactionId,
        action === 'skip',
      );
    }
    return undefined;
  }
}
