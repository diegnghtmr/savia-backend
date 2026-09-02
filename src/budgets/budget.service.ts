import { encodeCursor } from '../platform/cursor.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  BUDGET_OUTCOMES,
  type BudgetCreateOutcome,
  type BudgetGetOutcome,
  type BudgetListOutcome,
  type BudgetListQuery,
  type BudgetStore,
  type BudgetsPort,
  type CreateBudgetRequest,
} from './budget.port.js';
export interface BudgetTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}
export class BudgetService implements BudgetsPort {
  public constructor(
    private readonly tx: BudgetTransaction,
    private readonly store: BudgetStore,
    private readonly idempotency: IdempotencyStore,
  ) {}
  public async createBudget(
    subject: string,
    workspaceId: string,
    command: CreateBudgetRequest,
    key: string,
  ): Promise<BudgetCreateOutcome> {
    const route = 'POST /v1/budgets';
    const fingerprint = computeRequestFingerprint(command);
    return this.tx.run(subject, async (client) => {
      const role = await this.store.readActiveRole(client, workspaceId);
      if (!['owner', 'administrator', 'editor'].includes(role ?? ''))
        return { kind: BUDGET_OUTCOMES.FORBIDDEN };
      const existing = await this.idempotency.read(
        client,
        subject,
        route,
        key,
        workspaceId,
      );
      if (existing)
        return existing.requestFingerprint === fingerprint
          ? {
              kind: BUDGET_OUTCOMES.REPLAYED,
              status: existing.responseStatus,
              etag: existing.responseEtag,
              body: existing.responseBody,
            }
          : { kind: BUDGET_OUTCOMES.CONFLICT };
      const currency = await this.store.readWorkspaceCurrency(
        client,
        workspaceId,
      );
      if (!currency) return { kind: BUDGET_OUTCOMES.INVALID_SOURCE };
      let source = [] as readonly import('./budget.port.js').BudgetAllocation[];
      if (command.copyFromBudgetId) {
        source = await this.store.findSourceAllocations(
          client,
          workspaceId,
          command.copyFromBudgetId,
        );
        const sourceBudget = await this.store.findBudget(
          client,
          workspaceId,
          command.copyFromBudgetId,
        );
        if (!sourceBudget) return { kind: BUDGET_OUTCOMES.INVALID_SOURCE };
      }
      const budget = await this.store.createBudget(
        client,
        workspaceId,
        subject,
        command,
        currency,
      );
      if (source.length)
        await this.store.insertCopiedAllocations(
          client,
          workspaceId,
          budget.id,
          source,
        );
      const written = await this.idempotency.write(
        client,
        subject,
        route,
        key,
        fingerprint,
        201,
        null,
        budget,
        workspaceId,
      );
      if (!written) {
        const reread = await this.idempotency.read(
          client,
          subject,
          route,
          key,
          workspaceId,
        );
        if (reread)
          return reread.requestFingerprint === fingerprint
            ? {
                kind: BUDGET_OUTCOMES.REPLAYED,
                status: reread.responseStatus,
                etag: reread.responseEtag,
                body: reread.responseBody,
              }
            : { kind: BUDGET_OUTCOMES.CONFLICT };
      }
      return {
        kind: BUDGET_OUTCOMES.CREATED,
        budget:
          (await this.store.findBudget(client, workspaceId, budget.id)) ??
          budget,
      };
    });
  }
  public getBudget(
    subject: string,
    workspaceId: string,
    id: string,
  ): Promise<BudgetGetOutcome> {
    return this.tx.runRead(subject, async (client) => {
      const role = await this.store.readActiveRole(client, workspaceId);
      if (!['owner', 'administrator', 'editor', 'viewer'].includes(role ?? ''))
        return { kind: BUDGET_OUTCOMES.FORBIDDEN };
      const budget = await this.store.findBudget(client, workspaceId, id);
      return budget
        ? { kind: BUDGET_OUTCOMES.FOUND, budget }
        : { kind: BUDGET_OUTCOMES.NOT_FOUND };
    });
  }
  public listBudgets(
    subject: string,
    query: BudgetListQuery,
  ): Promise<BudgetListOutcome> {
    return this.tx.runRead(subject, async (client) => {
      const role = await this.store.readActiveRole(client, query.workspaceId);
      if (!['owner', 'administrator', 'editor', 'viewer'].includes(role ?? ''))
        return { kind: BUDGET_OUTCOMES.FORBIDDEN };
      const rows = await this.store.listBudgets(client, query, query.limit + 1);
      const hasNextPage = rows.length > query.limit;
      const visible = hasNextPage ? rows.slice(0, query.limit) : rows;
      const last = visible[visible.length - 1];
      return {
        kind: 'ok',
        page: {
          items: visible.map((r) => r.budget),
          pageInfo: {
            hasNextPage,
            nextCursor:
              hasNextPage && last
                ? encodeCursor({
                    workspaceId: query.workspaceId,
                    createdAt: last.cursorAt,
                    id: last.budget.id,
                    filter: JSON.stringify([
                      query.from ?? null,
                      query.to ?? null,
                    ]),
                  })
                : null,
          },
        },
      };
    });
  }
}
