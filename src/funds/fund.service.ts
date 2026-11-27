import { encodeCursor } from '../platform/cursor.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  FUND_OUTCOMES,
  type CreateFundContributionRequest,
  type CreateFundRequest,
  type CreateFundWithdrawalRequest,
  type FundCreateOutcome,
  type FundDetailOutcome,
  type FundMovementOutcome,
  type FundListOutcome,
  type FundListQuery,
  type FundsPort,
  type FundStore,
  type FundUpdateOutcome,
  type UpdateFundRequest,
} from './fund.port.js';

export class FundCreateRollbackError extends Error {
  public constructor(
    public readonly outcome: 'replayed' | 'conflict',
    public readonly status?: number,
    public readonly etag?: string | null,
    public readonly body?: unknown,
  ) {
    super(`Fund create rollback: ${outcome}`);
    this.name = 'FundCreateRollbackError';
  }
}

export class FundContributionRollbackError extends Error {
  public constructor(
    public readonly outcome: 'replayed' | 'conflict',
    public readonly status?: number,
    public readonly etag?: string | null,
    public readonly body?: unknown,
  ) {
    super(`Fund contribution rollback: ${outcome}`);
    this.name = 'FundContributionRollbackError';
  }
}

export interface FundTransactionRunner {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export class FundService implements FundsPort {
  public constructor(
    private readonly tx: FundTransactionRunner,
    private readonly store: FundStore,
    private readonly idempotency: IdempotencyStore,
  ) {}

  public async getFund(
    subject: string,
    workspaceId: string,
    id: string,
  ): Promise<FundDetailOutcome> {
    return this.tx.runRead(subject, async (client) => {
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        !['owner', 'administrator', 'editor', 'viewer'].includes(role ?? '')
      ) {
        return { kind: FUND_OUTCOMES.FORBIDDEN };
      }
      const detail = await this.store.readFundDetail(client, workspaceId, id);
      return detail
        ? { kind: 'ok', fund: detail.fund }
        : { kind: FUND_OUTCOMES.NOT_FOUND };
    });
  }

  public readDetailWithin(
    client: TransactionClient,
    workspaceId: string,
    fundId: string,
  ) {
    return this.store.readFundDetail(client, workspaceId, fundId);
  }

  public async checkUpdateWithin(
    client: TransactionClient,
    workspaceId: string,
    fundId: string,
    command: UpdateFundRequest,
    ifMatch: string,
  ) {
    await this.store.lockFund(client, workspaceId, fundId);
    const current = await this.readDetailWithin(client, workspaceId, fundId);
    if (!current) return { kind: FUND_OUTCOMES.NOT_FOUND } as const;
    if (current.fund.etag !== ifMatch) return { kind: 'stale' } as const;
    if (
      command.targetAmount &&
      command.targetAmount.currency !== current.fund.currency
    ) {
      return { kind: FUND_OUTCOMES.CURRENCY_MISMATCH } as const;
    }
    if (
      !(await this.checkLinkedAccountWithin(
        client,
        workspaceId,
        command.linkedAccountId,
      ))
    ) {
      return { kind: FUND_OUTCOMES.LINKED_ACCOUNT_NOT_FOUND } as const;
    }
    if (
      command.responsibleMemberIds &&
      !(await this.store.hasActiveMembers(
        client,
        workspaceId,
        command.responsibleMemberIds,
      ))
    ) {
      return { kind: 'inactive-members' } as const;
    }
    return { kind: 'ok', version: current.version } as const;
  }

  public async updateFund(
    subject: string,
    workspaceId: string,
    fundId: string,
    command: UpdateFundRequest,
    ifMatch: string,
    key: string,
    boundClient?: TransactionClient,
  ): Promise<FundUpdateOutcome> {
    const route = 'PATCH /v1/funds/{fundId}';
    const fingerprint = computeRequestFingerprint({
      fundId,
      ifMatch,
      command,
    });
    // Both entry points hold the subject lock, including for idempotency records.
    const apply = async (
      client: TransactionClient,
    ): Promise<FundUpdateOutcome> => {
      const role = await this.store.readActiveRole(client, workspaceId);
      if (!['owner', 'administrator', 'editor'].includes(role ?? '')) {
        return { kind: FUND_OUTCOMES.FORBIDDEN };
      }
      const existing = await this.idempotency.read(
        client,
        subject,
        route,
        key,
        workspaceId,
      );
      if (existing) {
        return existing.requestFingerprint !== fingerprint
          ? { kind: FUND_OUTCOMES.CONFLICT }
          : {
              kind: FUND_OUTCOMES.REPLAYED,
              status: existing.responseStatus,
              etag: existing.responseEtag,
              body: existing.responseBody,
            };
      }

      const current = await this.checkUpdateWithin(
        client,
        workspaceId,
        fundId,
        command,
        ifMatch,
      );
      if (current.kind !== 'ok') return current;
      if (
        !(await this.store.updateFund(
          client,
          workspaceId,
          fundId,
          command,
          current.version,
        ))
      ) {
        return { kind: 'stale' };
      }
      const updated = await this.store.readFundDetail(
        client,
        workspaceId,
        fundId,
      );
      if (
        !updated ||
        !(await this.idempotency.write(
          client,
          subject,
          route,
          key,
          fingerprint,
          200,
          updated.fund.etag,
          updated.fund,
          workspaceId,
        ))
      ) {
        throw new Error('Updated fund response could not be recorded.');
      }
      return { kind: 'ok', fund: updated.fund };
    };
    return boundClient ? apply(boundClient) : this.tx.run(subject, apply);
  }

  public async checkLinkedAccountWithin(
    client: TransactionClient,
    workspaceId: string,
    accountId: string | null | undefined,
  ): Promise<boolean> {
    if (!accountId) return true;
    return !!(await this.store.lockAndReadAccount(
      client,
      workspaceId,
      accountId,
    ));
  }

  public async createFund(
    subject: string,
    workspaceId: string,
    command: CreateFundRequest,
    key: string,
    boundClient?: TransactionClient,
  ): Promise<FundCreateOutcome> {
    const route = 'POST /v1/funds';
    const fingerprint = computeRequestFingerprint(command);

    try {
      const apply = async (
        client: TransactionClient,
      ): Promise<FundCreateOutcome> => {
        const role = await this.store.readActiveRole(client, workspaceId);
        if (!['owner', 'administrator', 'editor'].includes(role ?? '')) {
          return { kind: FUND_OUTCOMES.FORBIDDEN };
        }

        const existing = await this.idempotency.read(
          client,
          subject,
          route,
          key,
          workspaceId,
        );
        if (existing) {
          return existing.requestFingerprint === fingerprint
            ? {
                kind: FUND_OUTCOMES.REPLAYED,
                status: existing.responseStatus,
                etag: existing.responseEtag,
                body: existing.responseBody,
              }
            : { kind: FUND_OUTCOMES.CONFLICT };
        }

        if (
          !(await this.checkLinkedAccountWithin(
            client,
            workspaceId,
            command.linkedAccountId,
          ))
        ) {
          return { kind: FUND_OUTCOMES.LINKED_ACCOUNT_NOT_FOUND };
        }

        const fund = await this.store.createFund(client, workspaceId, command);
        const materialized =
          (await this.store.findFund(client, workspaceId, fund.id)) ?? fund;

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
            if (reread.requestFingerprint === fingerprint) {
              throw new FundCreateRollbackError(
                'replayed',
                reread.responseStatus,
                reread.responseEtag,
                reread.responseBody,
              );
            }
            throw new FundCreateRollbackError('conflict');
          }
          throw new Error('Fund idempotency record could not be reread.');
        }

        return {
          kind: FUND_OUTCOMES.CREATED,
          fund: materialized,
        };
      };
      return boundClient
        ? await apply(boundClient)
        : await this.tx.run(subject, apply);
    } catch (error) {
      if (error instanceof FundCreateRollbackError) {
        return error.outcome === 'replayed'
          ? {
              kind: FUND_OUTCOMES.REPLAYED,
              status: error.status!,
              etag: error.etag!,
              body: error.body,
            }
          : { kind: FUND_OUTCOMES.CONFLICT };
      }
      throw error;
    }
  }

  public async listFunds(
    subject: string,
    query: FundListQuery,
  ): Promise<FundListOutcome> {
    return this.tx.runRead(subject, async (client) => {
      const role = await this.store.readActiveRole(client, query.workspaceId);
      if (
        !['owner', 'administrator', 'editor', 'viewer'].includes(role ?? '')
      ) {
        return { kind: FUND_OUTCOMES.FORBIDDEN };
      }

      const rawItems = await this.store.listFunds(
        client,
        query,
        query.limit + 1,
      );
      const hasNextPage = rawItems.length > query.limit;
      const visible = rawItems.slice(0, query.limit);
      const last = visible[visible.length - 1];

      return {
        kind: 'ok',
        page: {
          items: visible.map((r) => r.fund),
          pageInfo: {
            hasNextPage,
            nextCursor:
              hasNextPage && last
                ? encodeCursor({
                    workspaceId: query.workspaceId,
                    createdAt: last.cursorAt,
                    id: last.fund.id,
                  })
                : null,
          },
        },
      };
    });
  }

  public async checkContributionWithin(
    client: TransactionClient,
    workspaceId: string,
    fundId: string,
    command: Pick<CreateFundContributionRequest, 'accountId' | 'amount'>,
  ) {
    // The transaction runner holds the subject lock; take fund before account.
    await this.store.lockFund(client, workspaceId, fundId);
    const fund = await this.store.findFund(client, workspaceId, fundId);
    if (!fund) return { kind: FUND_OUTCOMES.NOT_FOUND } as const;
    if (fund.currency !== command.amount.currency)
      return { kind: FUND_OUTCOMES.CURRENCY_MISMATCH } as const;
    const account = await this.store.lockAndReadAccount(
      client,
      workspaceId,
      command.accountId,
    );
    if (!account) return { kind: FUND_OUTCOMES.ACCOUNT_NOT_FOUND } as const;
    if (account.status === 'closed')
      return { kind: FUND_OUTCOMES.ACCOUNT_CLOSED } as const;
    if (account.currency !== command.amount.currency)
      return { kind: FUND_OUTCOMES.ACCOUNT_CURRENCY_MISMATCH } as const;
    return { kind: 'ok', fund } as const;
  }

  public contributeToFund(
    subject: string,
    workspaceId: string,
    fundId: string,
    command: CreateFundContributionRequest,
    key: string,
    boundClient?: TransactionClient,
  ): Promise<FundMovementOutcome> {
    return this.moveFund(
      subject,
      workspaceId,
      fundId,
      command,
      key,
      boundClient,
    );
  }

  public withdrawFromFund(
    subject: string,
    workspaceId: string,
    fundId: string,
    command: CreateFundWithdrawalRequest,
    key: string,
    boundClient?: TransactionClient,
  ): Promise<FundMovementOutcome> {
    return this.moveFund(
      subject,
      workspaceId,
      fundId,
      command,
      key,
      boundClient,
    );
  }

  private async moveFund(
    subject: string,
    workspaceId: string,
    fundId: string,
    command: CreateFundContributionRequest | CreateFundWithdrawalRequest,
    key: string,
    boundClient?: TransactionClient,
  ): Promise<FundMovementOutcome> {
    const route =
      'reason' in command
        ? 'POST /v1/funds/{fundId}/withdrawals'
        : 'POST /v1/funds/{fundId}/contributions';
    const fingerprint = computeRequestFingerprint({
      fundId,
      ...command,
    });

    try {
      const apply = async (
        client: TransactionClient,
      ): Promise<FundMovementOutcome> => {
        const role = await this.store.readActiveRole(client, workspaceId);
        if (!['owner', 'administrator', 'editor'].includes(role ?? '')) {
          return { kind: FUND_OUTCOMES.FORBIDDEN };
        }

        const existing = await this.idempotency.read(
          client,
          subject,
          route,
          key,
          workspaceId,
        );
        if (existing) {
          return existing.requestFingerprint === fingerprint
            ? {
                kind: FUND_OUTCOMES.REPLAYED,
                status: existing.responseStatus,
                etag: existing.responseEtag,
                body: existing.responseBody,
              }
            : { kind: FUND_OUTCOMES.CONFLICT };
        }

        const target = await this.checkContributionWithin(
          client,
          workspaceId,
          fundId,
          command,
        );
        if (target.kind !== 'ok') return target;
        const transaction =
          'reason' in command
            ? await this.store.withdrawFromFund(
                client,
                workspaceId,
                subject,
                target.fund,
                command,
              )
            : await this.store.contributeToFund(
                client,
                workspaceId,
                subject,
                target.fund,
                command,
              );
        if (!transaction) return { kind: FUND_OUTCOMES.INSUFFICIENT_SAVED };

        const written = await this.idempotency.write(
          client,
          subject,
          route,
          key,
          fingerprint,
          201,
          null,
          transaction,
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
            if (reread.requestFingerprint === fingerprint) {
              throw new FundContributionRollbackError(
                'replayed',
                reread.responseStatus,
                reread.responseEtag,
                reread.responseBody,
              );
            }
            throw new FundContributionRollbackError('conflict');
          }
          throw new Error(
            'Fund contribution idempotency record could not be reread.',
          );
        }

        return {
          kind: FUND_OUTCOMES.CREATED,
          transaction,
        };
      };
      return boundClient
        ? await apply(boundClient)
        : await this.tx.run(subject, apply);
    } catch (error) {
      if (error instanceof FundContributionRollbackError) {
        return error.outcome === 'replayed'
          ? {
              kind: FUND_OUTCOMES.REPLAYED,
              status: error.status!,
              etag: error.etag!,
              body: error.body,
            }
          : { kind: FUND_OUTCOMES.CONFLICT };
      }
      throw error;
    }
  }
}
