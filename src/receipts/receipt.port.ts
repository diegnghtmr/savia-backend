import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  CreateTransactionCommand,
  Transaction,
  TransactionCreateOutcome,
} from '../ledger/ledger.port.js';

export const RECEIPTS_PORT = Symbol('ReceiptsPort');

export const RECEIPT_PROCESSING_PREFERENCES = {
  DEVICE_RESULT: 'device_result',
  SAVIA: 'savia',
  EXTERNAL_PROVIDER: 'external_provider',
} as const;
export type ReceiptProcessingPreference =
  (typeof RECEIPT_PROCESSING_PREFERENCES)[keyof typeof RECEIPT_PROCESSING_PREFERENCES];

export const RECEIPT_STATUSES = {
  UPLOADED: 'uploaded',
  PROCESSING: 'processing',
  AWAITING_REVIEW: 'awaiting_review',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
} as const;
export type ReceiptStatus =
  (typeof RECEIPT_STATUSES)[keyof typeof RECEIPT_STATUSES];

export const RECEIPT_PROCESSING_LOCATIONS = {
  DEVICE: 'device',
  SAVIA: 'savia',
  EXTERNAL_PROVIDER: 'external_provider',
} as const;
export type ReceiptProcessingLocation =
  (typeof RECEIPT_PROCESSING_LOCATIONS)[keyof typeof RECEIPT_PROCESSING_LOCATIONS];

export interface ReceiptField {
  readonly value: unknown;
  readonly confidence: number;
}

export interface Receipt {
  readonly id: string;
  readonly status: ReceiptStatus;
  readonly fileName: string;
  readonly processingLocation: ReceiptProcessingLocation;
  readonly merchant: ReceiptField | null;
  readonly date: ReceiptField | null;
  readonly currency: ReceiptField | null;
  readonly total: ReceiptField | null;
  readonly transactionId: string | null;
  readonly createdAt: string;
}

export interface ReceiptUploadCommand {
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Buffer;
  readonly processingPreference: ReceiptProcessingPreference;
  readonly deviceOcrResult: Record<string, unknown> | null;
}

export interface ReceiptStore {
  createId(): string;
  create(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    id: string,
    command: ReceiptUploadCommand,
    storagePath: string,
    jobId?: string,
  ): Promise<Receipt>;
  find(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<Receipt | undefined>;
  claim(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<boolean>;
  confirm(
    client: TransactionClient,
    workspaceId: string,
    id: string,
    transactionId: string,
  ): Promise<boolean>;
  findOcrBinding(
    client: TransactionClient,
    workspaceId: string,
    receiptId: string,
    jobId: string,
  ): Promise<ReceiptOcrBinding | null>;
  updateOcrResultCas(
    client: TransactionClient,
    workspaceId: string,
    receiptId: string,
    jobId: string,
    fields: ExtractedReceiptFields,
  ): Promise<boolean>;
}

export const RECEIPT_OUTCOMES = {
  CREATED: 'created',
  FOUND: 'found',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  TRANSACTION_INVALID: 'transaction_invalid',
  TRANSACTION_REPLAYED: 'transaction_replayed',
} as const;

export type ReceiptCreateOutcome =
  | {
      readonly kind: typeof RECEIPT_OUTCOMES.CREATED;
      readonly receipt: Receipt;
    }
  | {
      readonly kind: typeof RECEIPT_OUTCOMES.TRANSACTION_REPLAYED;
      readonly status: number;
      readonly body: unknown;
    }
  | { readonly kind: typeof RECEIPT_OUTCOMES.FORBIDDEN }
  | { readonly kind: typeof RECEIPT_OUTCOMES.CONFLICT }
  | { readonly kind: typeof RECEIPT_OUTCOMES.NOT_FOUND };

export type ReceiptGetOutcome =
  | { readonly kind: typeof RECEIPT_OUTCOMES.FOUND; readonly receipt: Receipt }
  | { readonly kind: typeof RECEIPT_OUTCOMES.FORBIDDEN }
  | { readonly kind: typeof RECEIPT_OUTCOMES.NOT_FOUND };

export type ReceiptConfirmOutcome =
  | {
      readonly kind: typeof RECEIPT_OUTCOMES.CREATED;
      readonly transaction: Transaction;
    }
  | { readonly kind: typeof RECEIPT_OUTCOMES.FORBIDDEN }
  | { readonly kind: typeof RECEIPT_OUTCOMES.NOT_FOUND }
  | { readonly kind: typeof RECEIPT_OUTCOMES.CONFLICT }
  | { readonly kind: typeof RECEIPT_OUTCOMES.TRANSACTION_INVALID }
  | {
      readonly kind: typeof RECEIPT_OUTCOMES.TRANSACTION_REPLAYED;
      readonly status: number;
      readonly body: unknown;
    };

export interface ReceiptsPort {
  createReceipt(
    subject: string,
    workspaceId: string,
    command: ReceiptUploadCommand,
    idempotencyKey: string,
  ): Promise<ReceiptCreateOutcome>;
  getReceipt(
    subject: string,
    workspaceId: string,
    id: string,
  ): Promise<ReceiptGetOutcome>;
  confirmReceipt(
    subject: string,
    workspaceId: string,
    id: string,
    command: CreateTransactionCommand,
    idempotencyKey: string,
  ): Promise<ReceiptConfirmOutcome>;
}

export type ReceiptTransactionCreateOutcome = TransactionCreateOutcome;

export interface ReceiptOcrJobPayload {
  readonly receiptId: string;
  readonly storagePath: string;
}

export interface ReceiptOcrBinding {
  readonly id: string;
  readonly workspaceId: string;
  readonly storagePath: string;
  readonly jobId: string;
  readonly createdBy: string;
  readonly status: string;
  readonly transactionId: string | null;
}

export interface ExtractedReceiptFields {
  readonly merchant: ReceiptField | null;
  readonly date: ReceiptField | null;
  readonly currency: ReceiptField | null;
  readonly total: ReceiptField | null;
}
