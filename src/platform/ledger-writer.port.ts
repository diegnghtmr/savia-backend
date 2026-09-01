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

export interface LedgerWriter {
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
