import type { TransactionClient } from '../platform/pg-transaction.js';

export const EXPORTS_PORT = Symbol('ExportsPort');
export const EXPORT_FORMATS = {
  CSV: 'csv',
  JSON_BACKUP: 'json_backup',
  XLSX: 'xlsx',
} as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[keyof typeof EXPORT_FORMATS];
export const EXPORT_RESOURCES = {
  ALL: 'all',
  TRANSACTIONS: 'transactions',
  ACCOUNTS: 'accounts',
  BUDGETS: 'budgets',
  DEBTS: 'debts',
  REPORT: 'report',
} as const;
export type ExportResource =
  (typeof EXPORT_RESOURCES)[keyof typeof EXPORT_RESOURCES];
export const EXPORT_STATUSES = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;
export type ExportStatus =
  (typeof EXPORT_STATUSES)[keyof typeof EXPORT_STATUSES];

export interface CreateExportJobCommand {
  readonly format: ExportFormat;
  readonly resource: ExportResource;
  readonly resourceId: string | null;
  readonly from: string | null;
  readonly to: string | null;
}
export interface ExportJob {
  readonly id: string;
  readonly status: ExportStatus;
  readonly format: ExportFormat;
  readonly downloadUrl: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}
export interface ExportRecord extends ExportJob {
  readonly workspaceId: string;
  readonly resource: ExportResource;
  readonly resourceId: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly objectPath: string | null;
  readonly error: Record<string, unknown> | null;
  readonly completedAt: string | null;
}
export const EXPORT_OUTCOMES = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  FORBIDDEN: 'forbidden',
  IDEMPOTENCY_CONFLICT: 'idempotency-conflict',
  NOT_FOUND: 'not-found',
  UNSUPPORTED_RESOURCE: 'unsupported-resource',
  FAILED: 'failed',
} as const;
export type ExportCreateOutcome =
  | { readonly kind: typeof EXPORT_OUTCOMES.CREATED; readonly job: ExportJob }
  | {
      readonly kind: typeof EXPORT_OUTCOMES.REPLAYED;
      readonly status: number;
      readonly body: unknown;
    }
  | { readonly kind: typeof EXPORT_OUTCOMES.FORBIDDEN }
  | { readonly kind: typeof EXPORT_OUTCOMES.IDEMPOTENCY_CONFLICT }
  | { readonly kind: typeof EXPORT_OUTCOMES.UNSUPPORTED_RESOURCE }
  | { readonly kind: typeof EXPORT_OUTCOMES.FAILED; readonly job: ExportJob };
export type ExportGetOutcome =
  | { readonly kind: 'found'; readonly job: ExportJob }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'forbidden' };
export interface ExportRows {
  readonly accounts: readonly Record<string, unknown>[];
  readonly transactions: readonly Record<string, unknown>[];
}
export interface ExportStore {
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;
  createId(): string;
  reserve(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    id: string,
    command: CreateExportJobCommand,
    path: string,
  ): Promise<ExportJob>;
  complete(
    client: TransactionClient,
    workspaceId: string,
    id: string,
    url: string,
    expiresAt: string,
  ): Promise<ExportJob>;
  fail(
    client: TransactionClient,
    workspaceId: string,
    id: string,
    error: Record<string, unknown>,
  ): Promise<ExportJob>;
  readRows(
    client: TransactionClient,
    workspaceId: string,
    command: CreateExportJobCommand,
  ): Promise<ExportRows>;
  insert(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    id: string,
    command: CreateExportJobCommand,
    path: string,
    url: string | null,
    expiresAt: string | null,
    error: Record<string, unknown> | null,
  ): Promise<ExportJob>;
  find(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<ExportJob | undefined>;
}
export interface ExportStorage {
  upload(path: string, content: Buffer, contentType: string): Promise<void>;
  sign(
    path: string,
    expiresAt: Date,
  ): Promise<{ url: string; expiresAt: Date }>;
  remove(path: string): Promise<void>;
}
export interface ExportsPort {
  createExportJob(
    subject: string,
    workspaceId: string,
    command: CreateExportJobCommand,
    key: string,
  ): Promise<ExportCreateOutcome>;
  getExportJob(
    subject: string,
    workspaceId: string,
    id: string,
  ): Promise<ExportGetOutcome>;
}
