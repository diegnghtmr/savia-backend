import { randomUUID } from 'node:crypto';
import { encodeCursor, type Cursor } from '../platform/cursor.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { IfMatchParse } from '../platform/if-match.js';
import type { OccurrenceLedgerWriter } from '../platform/ledger-writer.port.js';
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
export interface OccurrenceCommand extends RuleTarget {
  readonly occurrenceId: string;
  readonly action: OccurrenceAction;
  readonly key: string;
  readonly ifMatch: Exclude<IfMatchParse, { kind: 'malformed' }>;
}

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
        | 'invalid';
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
    originalScheduledAt: occurrence.scheduledAt.toISOString(),
    scheduledAt: occurrence.scheduledAt.toISOString(),
    status: occurrence.status,
    transactionId: occurrence.transactionId,
    amount: occurrence.amount,
    description: occurrence.description,
    categoryId: occurrence.categoryId,
    etag: `"${occurrence.version}"`,
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
      if (!(await this.store.readRule(client, workspaceId, ruleId)))
        return { kind: 'notFound' };
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
          ruleEtag: '"1"',
        },
      };
    });
  }

  public run(
    subject: string,
    command: OccurrenceCommand,
  ): Promise<ActionOutcome> {
    const { workspaceId, ruleId, occurrenceId, key, action, ifMatch } = command;
    const route = `POST /v1/recurring-rules/:ruleId/occurrences/:occurrenceId/${action}`;
    const fingerprint = computeRequestFingerprint({
      ruleId,
      occurrenceId,
      ifMatch:
        ifMatch.kind === 'versions'
          ? [...new Set(ifMatch.versions)].sort((a, b) => a - b)
          : ifMatch.kind,
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

      const target = { id: occurrenceId, limit: 1 };
      const [before] = await this.store.readOccurrences(
        client,
        workspaceId,
        ruleId,
        target,
      );
      if (!before) return { kind: 'notFound' };
      const stale =
        ifMatch.kind === 'versions' &&
        !ifMatch.versions.includes(before.version);
      if (stale) return { kind: 'precondition' };
      const { status, bookingVersion, template, scheduledAt } = before;
      let transactionId = before.transactionId;
      if (status === 'draft' || status === 'pending') {
        if (transactionId === null || bookingVersion === null)
          throw new Error('Occurrence booking is missing.');
        const booking = {
          id: transactionId,
          accountId: template.accountId,
          status,
          version: bookingVersion,
        };
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
              occurredAt: scheduledAt.toISOString(),
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
        const slot = scheduledAt.toISOString();
        await this.store.record(
          client,
          { workspaceId, ruleId, subject, scheduledAt: slot, asOf: slot },
          {
            id: occurrenceId,
            behavior: rule.behavior,
            transactionId: null,
            nextOccurrenceAt: followingSlot(rule, scheduledAt),
            skipped: true,
          },
        );
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
      const [after] = await this.store.readOccurrences(
        client,
        workspaceId,
        ruleId,
        target,
      );
      if (!after) throw new Error('Updated occurrence is missing.');
      const body = present(ruleId, after);
      // PgTransaction serializes same-subject writes. An unexpected conflict here must roll back the booking.
      const written = await this.idempotency.write(
        client,
        subject,
        route,
        key,
        fingerprint,
        200,
        body.etag,
        body,
        workspaceId,
      );
      if (!written) throw new Error('Occurrence idempotency write failed.');
      return { kind: 'ok', status: 200, body, etag: body.etag };
    });
  }
}
