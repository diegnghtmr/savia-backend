import { encodeCursor } from '../platform/cursor.js';
import type { Cursor } from '../platform/cursor.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import {
  createRecurringRuleCommand,
  RecurringCommandValidationError,
} from './recurring-command.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  RECURRING_CREATE_OUTCOMES,
  RECURRING_LIST_OUTCOMES,
  SUBSCRIPTION_LIST_OUTCOMES,
  type CreateRecurringRuleCommand,
  type RecurringCreateOutcome,
  type RecurringListOutcome,
  type RecurringRuleListQuery,
  type RecurringRulesPort,
  type RecurringRule,
  type Subscription,
  type SubscriptionDecisionCommand,
  type SubscriptionDecisionOutcome,
  type SubscriptionListOutcome,
  type SubscriptionListQuery,
  type SubscriptionStatus,
} from './recurring.port.js';

export interface RecurringTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export class RecurringAccountNotFoundError extends Error {
  public constructor(message = 'Account not found in workspace.') {
    super(message);
    this.name = 'RecurringAccountNotFoundError';
  }
}

export interface RecurringRuleItem {
  readonly rule: RecurringRule;
  readonly cursorAt: string;
}

export interface SubscriptionItem {
  readonly subscription: Subscription;
  readonly cursorAt: string;
}

interface LockedSubscriptionCandidate {
  readonly subscription: Subscription;
  readonly accountId: string | null;
  readonly version: number;
}

export interface RecurringStore {
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;

  categoryBelongsToWorkspace(
    client: TransactionClient,
    workspaceId: string,
    categoryId: string,
  ): Promise<boolean>;

  payeeBelongsToWorkspace(
    client: TransactionClient,
    workspaceId: string,
    payeeId: string,
  ): Promise<boolean>;

  tagsBelongToWorkspace(
    client: TransactionClient,
    workspaceId: string,
    tagIds: readonly string[],
  ): Promise<boolean>;

  createRecurringRule(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateRecurringRuleCommand,
  ): Promise<RecurringRule>;

  listRecurringRules(
    client: TransactionClient,
    workspaceId: string,
    cursor: Cursor | undefined,
    limit: number,
  ): Promise<readonly RecurringRuleItem[]>;

  lockSubscriptionWriter(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<boolean>;

  lockSubscriptionCandidate(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<LockedSubscriptionCandidate | undefined>;

  resolveSubscriptionCandidate(
    client: TransactionClient,
    workspaceId: string,
    id: string,
    recurringRuleId: string | null,
  ): Promise<Subscription & { etag: string }>;

  listSubscriptions(
    client: TransactionClient,
    workspaceId: string,
    cursor: Cursor | undefined,
    limit: number,
    status?: SubscriptionStatus,
  ): Promise<readonly SubscriptionItem[]>;
}

export class RecurringService implements RecurringRulesPort {
  public constructor(
    private readonly transaction: RecurringTransaction,
    private readonly store: RecurringStore,
    private readonly idempotencyStore: IdempotencyStore,
  ) {}

  public async createRecurringRule(
    subject: string,
    workspaceId: string,
    command: CreateRecurringRuleCommand,
    idempotencyKey: string,
  ): Promise<RecurringCreateOutcome> {
    const route = 'POST /v1/recurring-rules';
    const fingerprint = computeRequestFingerprint(command);

    return this.transaction.run(subject, async (client) => {
      // 1. Role check: owner, administrator, editor
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        role === undefined ||
        !['owner', 'administrator', 'editor'].includes(role)
      ) {
        return { kind: RECURRING_CREATE_OUTCOMES.FORBIDDEN };
      }

      // 2. Idempotency read
      const existing = await this.idempotencyStore.read(
        client,
        subject,
        route,
        idempotencyKey,
        workspaceId,
      );
      if (existing !== undefined) {
        if (existing.requestFingerprint !== fingerprint) {
          return { kind: RECURRING_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT };
        }
        return {
          kind: RECURRING_CREATE_OUTCOMES.REPLAYED,
          status: existing.responseStatus,
          etag: existing.responseEtag,
          body: existing.responseBody,
        };
      }

      // 3. RULING 53: Validate workspace containment for categoryId, payeeId, tagIds before insert
      if (command.template.categoryId) {
        const catOk = await this.store.categoryBelongsToWorkspace(
          client,
          workspaceId,
          command.template.categoryId,
        );
        if (!catOk) {
          return { kind: RECURRING_CREATE_OUTCOMES.CATEGORY_NOT_FOUND };
        }
      }

      if (command.template.payeeId) {
        const payeeOk = await this.store.payeeBelongsToWorkspace(
          client,
          workspaceId,
          command.template.payeeId,
        );
        if (!payeeOk) {
          return { kind: RECURRING_CREATE_OUTCOMES.PAYEE_NOT_FOUND };
        }
      }

      if (command.template.tagIds && command.template.tagIds.length > 0) {
        const tagsOk = await this.store.tagsBelongToWorkspace(
          client,
          workspaceId,
          command.template.tagIds,
        );
        if (!tagsOk) {
          return { kind: RECURRING_CREATE_OUTCOMES.TAG_NOT_FOUND };
        }
      }

      // 4. Create rule (account_id workspace containment enforced by DB composite FK)
      let rule: RecurringRule;
      try {
        rule = await this.store.createRecurringRule(
          client,
          workspaceId,
          subject,
          command,
        );
      } catch (error) {
        if (error instanceof RecurringAccountNotFoundError) {
          return { kind: RECURRING_CREATE_OUTCOMES.ACCOUNT_NOT_FOUND };
        }
        throw error;
      }

      // 5. Write idempotency record
      const written = await this.idempotencyStore.write(
        client,
        subject,
        route,
        idempotencyKey,
        fingerprint,
        201,
        null,
        rule,
        workspaceId,
      );

      if (!written) {
        const reread = await this.idempotencyStore.read(
          client,
          subject,
          route,
          idempotencyKey,
          workspaceId,
        );
        if (reread !== undefined) {
          if (reread.requestFingerprint !== fingerprint) {
            return { kind: RECURRING_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT };
          }
          return {
            kind: RECURRING_CREATE_OUTCOMES.REPLAYED,
            status: reread.responseStatus,
            etag: reread.responseEtag,
            body: reread.responseBody,
          };
        }
      }

      return {
        kind: RECURRING_CREATE_OUTCOMES.CREATED,
        rule,
      };
    });
  }

  public async listRecurringRules(
    subject: string,
    query: RecurringRuleListQuery,
  ): Promise<RecurringListOutcome> {
    return this.transaction.runRead(subject, async (client) => {
      // 1. Role check: owner, administrator, editor, viewer
      const role = await this.store.readActiveRole(client, query.workspaceId);
      if (
        role === undefined ||
        !['owner', 'administrator', 'editor', 'viewer'].includes(role)
      ) {
        return { kind: RECURRING_LIST_OUTCOMES.FORBIDDEN };
      }

      // 2. Fetch items (limit + 1 for hasNextPage)
      const rows = await this.store.listRecurringRules(
        client,
        query.workspaceId,
        query.cursor,
        query.limit + 1,
      );

      const hasNextPage = rows.length > query.limit;
      const visible = hasNextPage ? rows.slice(0, query.limit) : rows;
      const items = visible.map((entry) => entry.rule);
      const lastItem = visible[visible.length - 1];
      const nextCursor =
        hasNextPage && lastItem !== undefined
          ? encodeCursor({
              workspaceId: query.workspaceId,
              createdAt: lastItem.cursorAt,
              id: lastItem.rule.id,
            })
          : null;

      return {
        kind: RECURRING_LIST_OUTCOMES.OK,
        page: {
          items,
          pageInfo: {
            hasNextPage,
            nextCursor,
          },
        },
      };
    });
  }

  public async decideSubscription(
    subject: string,
    command: SubscriptionDecisionCommand,
  ): Promise<SubscriptionDecisionOutcome> {
    const { workspaceId, subscriptionId, action, idempotencyKey, ifMatch } =
      command;
    const route = `POST /v1/subscriptions/{subscriptionId}/${action}`;
    const fingerprint = computeRequestFingerprint({ subscriptionId, ifMatch });

    return this.transaction.run(subject, async (client) => {
      if (!(await this.store.lockSubscriptionWriter(client, workspaceId))) {
        return { kind: 'forbidden' };
      }
      const existing = await this.idempotencyStore.read(
        client,
        subject,
        route,
        idempotencyKey,
        workspaceId,
      );
      if (existing !== undefined) {
        if (existing.requestFingerprint !== fingerprint) {
          return { kind: 'idempotency_conflict' };
        }
        if (existing.responseEtag === null) {
          throw new Error('Subscription decision replay ETag is missing.');
        }
        return {
          kind: 'ok',
          etag: existing.responseEtag,
          body: existing.responseBody,
        };
      }
      const candidate = await this.store.lockSubscriptionCandidate(
        client,
        workspaceId,
        subscriptionId,
      );
      if (!candidate) return { kind: 'not_found' };
      const { subscription, accountId, version } = candidate;
      if (subscription.status !== 'detected') return { kind: 'resolved' };
      const stale =
        ifMatch !== undefined && ifMatch !== '*' && !ifMatch.includes(version);
      if (stale) {
        return { kind: 'stale' };
      }

      let ruleId: string | null = null;
      if (action === 'confirm') {
        if (
          !accountId ||
          BigInt(subscription.currentAmount.amountMinor) <= 0n
        ) {
          return { kind: 'unprocessable' };
        }
        const startsAt =
          subscription.nextExpectedAt ?? new Date().toISOString();
        let ruleCommand: CreateRecurringRuleCommand;
        try {
          ruleCommand = createRecurringRuleCommand({
            name: subscription.payeeName,
            frequency: subscription.frequency,
            behavior: 'remind',
            startsAt,
            template: {
              type: 'expense',
              accountId,
              amount: subscription.currentAmount,
              occurredAt: startsAt,
              description: subscription.payeeName,
            },
          });
        } catch (error) {
          if (error instanceof RecurringCommandValidationError) {
            return { kind: 'unprocessable' };
          }
          throw error;
        }
        const rule = await this.store.createRecurringRule(
          client,
          workspaceId,
          subject,
          ruleCommand,
        );
        ruleId = rule.id;
      }

      const body = await this.store.resolveSubscriptionCandidate(
        client,
        workspaceId,
        subscriptionId,
        ruleId,
      );
      // PgTransaction serializes commands by subject; a replay row cannot win
      // after this write. Roll back both the decision and the rule if it does.
      const written = await this.idempotencyStore.write(
        client,
        subject,
        route,
        idempotencyKey,
        fingerprint,
        200,
        body.etag,
        body,
        workspaceId,
      );
      if (!written) {
        throw new Error(
          'Subscription decision could not be recorded for replay.',
        );
      }
      return { kind: 'ok', etag: body.etag, body };
    });
  }

  public async listSubscriptions(
    subject: string,
    query: SubscriptionListQuery,
  ): Promise<SubscriptionListOutcome> {
    return this.transaction.runRead(subject, async (client) => {
      // 1. Role check: owner, administrator, editor, viewer
      const role = await this.store.readActiveRole(client, query.workspaceId);
      if (
        role === undefined ||
        !['owner', 'administrator', 'editor', 'viewer'].includes(role)
      ) {
        return { kind: SUBSCRIPTION_LIST_OUTCOMES.FORBIDDEN };
      }

      // 2. Fetch items (limit + 1 for hasNextPage)
      const rows = await this.store.listSubscriptions(
        client,
        query.workspaceId,
        query.cursor,
        query.limit + 1,
        query.status,
      );

      const hasNextPage = rows.length > query.limit;
      const visible = hasNextPage ? rows.slice(0, query.limit) : rows;
      const items = visible.map((entry) => entry.subscription);
      const lastItem = visible[visible.length - 1];
      const nextCursor =
        hasNextPage && lastItem !== undefined
          ? encodeCursor({
              workspaceId: query.workspaceId,
              createdAt: lastItem.cursorAt,
              id: lastItem.subscription.id,
              filter: query.status ?? null,
            })
          : null;

      return {
        kind: SUBSCRIPTION_LIST_OUTCOMES.OK,
        page: {
          items,
          pageInfo: {
            hasNextPage,
            nextCursor,
          },
        },
      };
    });
  }
}
