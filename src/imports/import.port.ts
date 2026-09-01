import type { TransactionClient } from '../platform/pg-transaction.js';
type Job = Record<string, unknown>;

export const IMPORTS_PORT = Symbol('ImportsPort');
export const IMPORT_FORMATS = ['csv', 'xlsx', 'qif', 'ofx', 'qfx'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];
export const IMPORT_STATUSES = [
  'uploaded',
  'analyzing',
  'awaiting_mapping',
  'awaiting_confirmation',
  'processing',
  'completed',
  'failed',
  'rolled_back',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
export type ImportClassification = 'valid' | 'duplicate' | 'error';
export interface ParsedImportRow {
  readonly rowNumber: number;
  readonly rawValues: readonly unknown[];
  readonly parsedDate: string | null;
  readonly parsedAmountMinor: number | null;
  readonly parsedDescription: string | null;
  readonly classification: ImportClassification;
  readonly error: Record<string, unknown> | null;
  readonly sourceColumns: readonly string[];
}
export interface ImportJob {
  readonly id: string;
  readonly status: ImportStatus;
  readonly fileName: string;
  readonly accountId: string | null;
  readonly detectedFormat: ImportFormat | null;
  readonly totalRows: number | null;
  readonly validRows: number | null;
  readonly duplicateRows: number | null;
  readonly errorRows: number | null;
  readonly createdAt: string;
  readonly sourceColumns: readonly string[];
}
export const DEBIT_SIGNS = {
  NEGATIVE: 'negative',
  POSITIVE: 'positive',
  SEPARATE_COLUMN: 'separate_column',
} as const;
export type DebitSign = (typeof DEBIT_SIGNS)[keyof typeof DEBIT_SIGNS];
export interface CommitImportCommand {
  readonly accountId: string;
  readonly columnMapping: Readonly<Record<string, string>>;
  readonly dateFormat?: string | null;
  readonly debitSign?: DebitSign;
  readonly skipDuplicateCandidates?: boolean;
}
export interface ImportCommitRow {
  readonly rowNumber: number;
  readonly rawValues: readonly unknown[];
  readonly parsedDate: string | null;
  readonly parsedAmountMinor: number | null;
  readonly parsedDescription: string | null;
  readonly classification: ImportClassification;
}
export interface ImportedTransaction {
  readonly id: string;
  readonly accountId: string;
  readonly status: string;
  readonly version: number;
}
export interface ImportCommand {
  readonly fileName: string;
  readonly bytes: Buffer;
  readonly formatHint: ImportFormat | null;
}
export const IMPORT_OUTCOMES = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  FORBIDDEN: 'forbidden',
  CONFLICT: 'conflict',
  FAILED: 'failed',
} as const;
export type ImportCreateOutcome =
  | { readonly kind: typeof IMPORT_OUTCOMES.CREATED; readonly job: ImportJob }
  | {
      readonly kind: typeof IMPORT_OUTCOMES.REPLAYED;
      readonly status: number;
      readonly body: unknown;
    }
  | { readonly kind: typeof IMPORT_OUTCOMES.FORBIDDEN }
  | { readonly kind: typeof IMPORT_OUTCOMES.CONFLICT }
  | { readonly kind: typeof IMPORT_OUTCOMES.FAILED; readonly detail: string };
export const IMPORT_MUTATION_OUTCOMES = {
  OK: 'ok',
  REPLAYED: 'replayed',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not-found',
  CONFLICT: 'conflict',
  INVALID: 'invalid',
  ACCOUNT_CLOSED: 'account-closed',
} as const;
export type ImportMutationOutcome =
  | { readonly kind: typeof IMPORT_MUTATION_OUTCOMES.OK; readonly job: Job }
  | {
      readonly kind: typeof IMPORT_MUTATION_OUTCOMES.REPLAYED;
      readonly status: number;
      readonly body: unknown;
    }
  | {
      readonly kind:
        | typeof IMPORT_MUTATION_OUTCOMES.FORBIDDEN
        | typeof IMPORT_MUTATION_OUTCOMES.NOT_FOUND
        | typeof IMPORT_MUTATION_OUTCOMES.CONFLICT
        | typeof IMPORT_MUTATION_OUTCOMES.INVALID
        | typeof IMPORT_MUTATION_OUTCOMES.ACCOUNT_CLOSED;
      readonly detail?: string;
    };
export type ImportGetOutcome =
  | { readonly kind: 'found'; readonly job: ImportJob }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'forbidden' };
export interface ImportStore {
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;
  createId(): string;
  createJob(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    id: string,
    fileName: string,
    detectedFormat: ImportFormat | null,
    rows: readonly ParsedImportRow[],
    sourceColumns: readonly string[],
    counts: { total: number; valid: number; duplicate: number; errors: number },
    error: Record<string, unknown> | null,
  ): Promise<ImportJob>;
  lockAccount(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
  ): Promise<{ status: string; currency: string } | undefined>;
  findRows(
    client: TransactionClient,
    workspaceId: string,
    importJobId: string,
  ): Promise<readonly ImportCommitRow[]>;
  findExisting(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
    date: string,
    amountMinor: string,
    description: string,
  ): Promise<boolean>;
  findImportedTransactions(
    client: TransactionClient,
    workspaceId: string,
    importJobId: string,
  ): Promise<readonly ImportedTransaction[]>;
  complete(
    client: TransactionClient,
    workspaceId: string,
    importJobId: string,
    accountId: string,
    status: 'completed' | 'rolled_back',
  ): Promise<ImportJob | undefined>;
  find(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<ImportJob | undefined>;
}
export interface ImportsPort {
  createImportJob(
    subject: string,
    workspaceId: string,
    command: ImportCommand,
    key: string,
  ): Promise<ImportCreateOutcome>;
  getImportJob(
    subject: string,
    workspaceId: string,
    id: string,
  ): Promise<ImportGetOutcome>;
  commitImport(
    subject: string,
    workspaceId: string,
    id: string,
    command: CommitImportCommand,
    key: string,
  ): Promise<ImportMutationOutcome>;
  rollbackImport(
    subject: string,
    workspaceId: string,
    id: string,
    key: string,
  ): Promise<ImportMutationOutcome>;
}
