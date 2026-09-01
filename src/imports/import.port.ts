import type { TransactionClient } from '../platform/pg-transaction.js';

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
    counts: { total: number; valid: number; duplicate: number; errors: number },
    error: Record<string, unknown> | null,
  ): Promise<ImportJob>;
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
}
