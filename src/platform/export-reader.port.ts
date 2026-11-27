import type { Cursor } from './cursor.js';
import type { TransactionClient } from './pg-transaction.js';

export interface ExportReaderQuery {
  readonly workspaceId: string;
  readonly cursor?: Cursor;
  readonly limit: number;
  readonly from?: string;
  readonly to?: string;
}

export interface ExportReader {
  readExportPage(
    client: TransactionClient,
    query: ExportReaderQuery,
  ): Promise<
    readonly {
      readonly id: string;
      readonly cursorAt: string;
      readonly row: Record<string, unknown>;
    }[]
  >;
}

export type ExportReaders = Readonly<Record<'budgets' | 'debts', ExportReader>>;
