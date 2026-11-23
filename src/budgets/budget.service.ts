import { encodeCursor } from '../platform/cursor.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  BUDGET_OUTCOMES,
  type Budget,
  type BudgetCreateOutcome,
  type BudgetGetOutcome,
  type BudgetListOutcome,
  type BudgetListQuery,
  type BudgetStore,
  type BudgetUpdateOutcome,
  type BudgetsPort,
  type CreateBudgetRequest,
  type UpdateBudgetRequest,
  type UpdateBudgetAllocationsRequest,
  type BudgetAllocationsOutcome,
} from './budget.port.js';
import type { IfMatchParse } from '../platform/if-match.js';
import { MAX_BUDGET_ALLOCATION_COUNT } from './budget-limits.js';

function canonicalIfMatch(ifMatch: IfMatchParse): unknown {
  if (ifMatch.kind !== 'versions') return { kind: ifMatch.kind };
  return {
    kind: ifMatch.kind,
    versions: [...new Set(ifMatch.versions)].sort((a, b) => a - b),
  };
}

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
export class BudgetCreateRollbackError extends Error {
  public constructor(
    public readonly outcome: 'replayed' | 'conflict',
    public readonly status?: number,
    public readonly etag?: string | null,
    public readonly body?: unknown,
  ) {
    super('Budget create transaction must be rolled back.');
    this.name = 'BudgetCreateRollbackError';
  }
}
export class BudgetUpdateRollbackError extends Error {
  public constructor(
    public readonly outcome: 'replayed' | 'conflict',
    public readonly status?: number,
    public readonly etag?: string | null,
    public readonly body?: unknown,
  ) {
    super('Budget update transaction must be rolled back.');
    this.name = 'BudgetUpdateRollbackError';
  }
}
export interface BudgetCreateSnapshot {
  readonly currency: string;
  readonly sourceVersion?: number;
}

export class BudgetService implements BudgetsPort {
  public constructor(
    private readonly tx: BudgetTransaction,
    private readonly store: BudgetStore,
    private readonly idempotency: IdempotencyStore,
  ) {}
  public findWithin(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ) {
    return this.store.findBudget(client, workspaceId, id);
  }

  public readCurrencyWithin(client: TransactionClient, workspaceId: string) {
    return this.store.readWorkspaceCurrency(client, workspaceId);
  }

  public async canCreateWithin(
    client: TransactionClient,
    workspaceId: string,
    command: CreateBudgetRequest,
    currency: string | undefined,
    source: Budget | undefined,
  ): Promise<boolean> {
    if (
      !currency ||
      (command.copyFromBudgetId &&
        (!source || source.allocations.length > MAX_BUDGET_ALLOCATION_COUNT))
    )
      return false;
    const allowed = await this.store.canCreateBudget?.(
      client,
      workspaceId,
      command,
      currency,
    );
    return allowed === true;
  }

  public async validateAllocationsWithin(
    client: TransactionClient,
    workspaceId: string,
    command: UpdateBudgetAllocationsRequest,
    currency: string,
  ): Promise<boolean> {
    if (
      command.allocations.some(({ planned }) => planned.currency !== currency)
    )
      return false;
    const missing = await this.store.findMissingAllocationReferences(
      client,
      workspaceId,
      command.allocations,
    );
    return missing.length === 0;
  }

  public async createBudget(
    subject: string,
    workspaceId: string,
    command: CreateBudgetRequest,
    key: string,
    boundClient?: TransactionClient,
    snapshot?: BudgetCreateSnapshot,
  ): Promise<BudgetCreateOutcome> {
    const route = 'POST /v1/budgets';
    const fingerprint = computeRequestFingerprint(command);
    try {
      const apply = async (
        client: TransactionClient,
      ): Promise<BudgetCreateOutcome> => {
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
        if (snapshot && currency !== snapshot.currency)
          return { kind: BUDGET_OUTCOMES.PRECONDITION_FAILED };
        let source =
          [] as readonly import('./budget.port.js').BudgetAllocation[];
        if (command.copyFromBudgetId) {
          const sourceId = command.copyFromBudgetId;
          if (!snapshot) {
            source = await this.store.findSourceAllocations(
              client,
              workspaceId,
              sourceId,
            );
          }
          const sourceBudget = snapshot
            ? await this.store.findBudget(client, workspaceId, sourceId, true)
            : await this.store.findBudget(client, workspaceId, sourceId);
          if (snapshot && sourceBudget?.version !== snapshot.sourceVersion)
            return { kind: BUDGET_OUTCOMES.PRECONDITION_FAILED };
          if (!sourceBudget) return { kind: BUDGET_OUTCOMES.INVALID_SOURCE };
          if (snapshot) source = sourceBudget.allocations;
          if (source.length > MAX_BUDGET_ALLOCATION_COUNT)
            return { kind: BUDGET_OUTCOMES.TOO_MANY_ALLOCATIONS };
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
        const materialized =
          (await this.store.findBudget(client, workspaceId, budget.id)) ??
          budget;
        const written = await this.idempotency.write(
          client,
          subject,
          route,
          key,
          fingerprint,
          201,
          null,
          materialized,
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
          if (reread) {
            if (reread.requestFingerprint === fingerprint)
              throw new BudgetCreateRollbackError(
                'replayed',
                reread.responseStatus,
                reread.responseEtag,
                reread.responseBody,
              );
            throw new BudgetCreateRollbackError('conflict');
          }
          throw new Error('Budget idempotency record could not be reread.');
        }
        return {
          kind: BUDGET_OUTCOMES.CREATED,
          budget: materialized,
        };
      };
      return boundClient
        ? await apply(boundClient)
        : await this.tx.run(subject, apply);
    } catch (error) {
      if (error instanceof BudgetCreateRollbackError) {
        return error.outcome === 'replayed'
          ? {
              kind: BUDGET_OUTCOMES.REPLAYED,
              status: error.status ?? 201,
              etag: error.etag ?? null,
              body: error.body,
            }
          : { kind: BUDGET_OUTCOMES.CONFLICT };
      }
      if (isMissingExchangeRateViolation(error)) {
        return { kind: BUDGET_OUTCOMES.CURRENCY_UNSUPPORTED };
      }
      throw error;
    }
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
  public async updateBudget(
    subject: string,
    workspaceId: string,
    id: string,
    command: UpdateBudgetRequest,
    key: string,
    ifMatch: IfMatchParse,
    boundClient?: TransactionClient,
  ): Promise<BudgetUpdateOutcome> {
    const route = 'PATCH /v1/budgets/{budgetId}';
    const fingerprint = computeRequestFingerprint({
      budgetId: id,
      ...command,
      ifMatch: canonicalIfMatch(ifMatch),
    });
    try {
      const apply = async (
        client: TransactionClient,
      ): Promise<BudgetUpdateOutcome> => {
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

        // Existence and workspace containment resolved FIRST (RULING 125)
        const existingBudget = await this.store.findBudget(
          client,
          workspaceId,
          id,
        );
        if (!existingBudget) return { kind: BUDGET_OUTCOMES.NOT_FOUND };

        // Precondition check (RULING 124)
        if (ifMatch.kind === 'versions') {
          if (!ifMatch.versions.includes(existingBudget.version)) {
            return { kind: BUDGET_OUTCOMES.PRECONDITION_FAILED };
          }
        }

        const expectedVersion =
          ifMatch.kind === 'versions' ? existingBudget.version : undefined;

        const updated = await this.store.updateBudget(
          client,
          workspaceId,
          id,
          command,
          expectedVersion,
        );
        if (!updated) {
          return { kind: BUDGET_OUTCOMES.PRECONDITION_FAILED };
        }

        const written = await this.idempotency.write(
          client,
          subject,
          route,
          key,
          fingerprint,
          200,
          null,
          updated,
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
          if (reread) {
            if (reread.requestFingerprint === fingerprint)
              throw new BudgetUpdateRollbackError(
                'replayed',
                reread.responseStatus,
                reread.responseEtag,
                reread.responseBody,
              );
            throw new BudgetUpdateRollbackError('conflict');
          }
          throw new Error('Budget idempotency record could not be reread.');
        }

        return {
          kind: BUDGET_OUTCOMES.UPDATED,
          budget: updated,
        };
      };
      return boundClient
        ? await apply(boundClient)
        : await this.tx.run(subject, apply);
    } catch (error) {
      if (error instanceof BudgetUpdateRollbackError) {
        return error.outcome === 'replayed'
          ? {
              kind: BUDGET_OUTCOMES.REPLAYED,
              status: error.status ?? 200,
              etag: error.etag ?? null,
              body: error.body,
            }
          : { kind: BUDGET_OUTCOMES.CONFLICT };
      }
      throw error;
    }
  }
  public async updateBudgetAllocations(
    subject: string,
    workspaceId: string,
    id: string,
    command: UpdateBudgetAllocationsRequest,
    key: string,
    ifMatch: IfMatchParse,
    boundClient?: TransactionClient,
  ): Promise<BudgetAllocationsOutcome> {
    const route = 'PUT /v1/budgets/{budgetId}/allocations';
    const fingerprint = computeRequestFingerprint({
      budgetId: id,
      ...command,
      ifMatch: canonicalIfMatch(ifMatch),
    });
    try {
      const apply = async (
        client: TransactionClient,
      ): Promise<BudgetAllocationsOutcome> => {
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
        const budget = await this.store.findBudget(client, workspaceId, id);
        if (!budget) return { kind: BUDGET_OUTCOMES.NOT_FOUND };
        if (
          ifMatch.kind === 'versions' &&
          !ifMatch.versions.includes(budget.version)
        )
          return { kind: BUDGET_OUTCOMES.PRECONDITION_FAILED };
        if (
          !(await this.validateAllocationsWithin(
            client,
            workspaceId,
            command,
            budget.currency,
          ))
        )
          return { kind: BUDGET_OUTCOMES.INVALID_ALLOCATIONS };
        const updated = await this.store.replaceBudgetAllocations(
          client,
          workspaceId,
          id,
          command.allocations,
          ifMatch.kind === 'versions' ? budget.version : undefined,
        );
        if (!updated) return { kind: BUDGET_OUTCOMES.PRECONDITION_FAILED };
        const written = await this.idempotency.write(
          client,
          subject,
          route,
          key,
          fingerprint,
          200,
          null,
          updated,
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
          if (reread?.requestFingerprint === fingerprint)
            throw new BudgetUpdateRollbackError(
              'replayed',
              reread.responseStatus,
              reread.responseEtag,
              reread.responseBody,
            );
          throw new BudgetUpdateRollbackError('conflict');
        }
        return { kind: BUDGET_OUTCOMES.UPDATED, budget: updated };
      };
      return boundClient
        ? await apply(boundClient)
        : await this.tx.run(subject, apply);
    } catch (error) {
      if (error instanceof BudgetUpdateRollbackError)
        return error.outcome === 'replayed'
          ? {
              kind: BUDGET_OUTCOMES.REPLAYED,
              status: error.status ?? 200,
              etag: error.etag ?? null,
              body: error.body,
            }
          : { kind: BUDGET_OUTCOMES.CONFLICT };
      throw error;
    }
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

/**
 * The budget currency invariant lives in the database:
 * - 202609020003_budget_currency_invariant.sql: budgets_currency_requires_account_exchange_rates
 * The trigger raises check_violation carrying this explicit constraint name.
 * Matching on this exact name ensures unrelated check violations on public.budgets
 * are not mislabeled as currency problems.
 */
function isMissingExchangeRateViolation(error: unknown): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    String((error as { code: unknown }).code) !== '23514' ||
    !('constraint' in error)
  ) {
    return false;
  }
  const constraint = String((error as { constraint: unknown }).constraint);
  return constraint === 'budgets_currency_requires_account_exchange_rates';
}
