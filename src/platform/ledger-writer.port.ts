import type { TransactionClient } from './pg-transaction.js';

export const LEDGER_WRITER = Symbol('LedgerWriter');

export interface AdjustmentTransactionCommand {
  readonly accountId: string;
  readonly currency: string;
  readonly amountMinor: string;
  readonly occurredAt: string;
  readonly description: string | null;
}

export interface LedgerWriter {
  createAdjustmentTransaction(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: AdjustmentTransactionCommand,
  ): Promise<void>;
}
