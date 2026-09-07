import type { TransactionClient } from './pg-transaction.js';

export const LEDGER_WRITER = Symbol('LedgerWriter');

export interface AdjustmentTransactionCommand {
  readonly accountId: string;
  readonly currency: string;
  readonly amountMinor: string;
  readonly occurredAt: string;
  readonly description: string | null;
}
export interface ImportedTransactionCommand {
  readonly accountId: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly occurredAt: string;
  readonly description: string;
  readonly importJobId: string;
}

export const TRANSACTION_TYPE = {
  INCOME: 'income',
  EXPENSE: 'expense',
  ADJUSTMENT: 'adjustment',
  REFUND: 'refund',
  DEBT_PAYMENT: 'debt_payment',
  FUND_CONTRIBUTION: 'fund_contribution',
} as const;
export type TransactionType =
  (typeof TRANSACTION_TYPE)[keyof typeof TRANSACTION_TYPE];

export interface Money {
  readonly amountMinor: string;
  readonly currency: string;
}

export interface CreateTransactionCommand {
  readonly type: TransactionType;
  readonly accountId: string;
  readonly amount: Money;
  readonly occurredAt: string;
  readonly status: 'draft' | 'pending' | 'confirmed' | 'reconciled';
  readonly categoryId?: string | null;
  readonly payeeId?: string | null;
  readonly description?: string | null;
  readonly notes?: string | null;
  readonly tagIds?: readonly string[];
  readonly receiptId?: string | null;
  readonly importJobId?: string | null;
}

export interface LedgerWriter {
  createTransaction(
    client: TransactionClient,
    subject: string,
    workspaceId: string,
    command: CreateTransactionCommand,
    idempotencyKey: string,
  ): Promise<unknown>;
  createAdjustmentTransaction(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: AdjustmentTransactionCommand,
  ): Promise<void>;
  createImportedTransaction(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: ImportedTransactionCommand,
  ): Promise<unknown>;
  createImportedTransactions(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    commands: readonly ImportedTransactionCommand[],
  ): Promise<void>;
  voidTransaction(
    client: TransactionClient,
    workspaceId: string,
    transactionId: string,
    accountId: string,
    postingStatus: string,
    expectedVersions?: number | readonly number[],
  ): Promise<unknown>;
}
