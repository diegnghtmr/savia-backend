import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  RECEIPT_PROCESSING_LOCATIONS,
  RECEIPT_PROCESSING_PREFERENCES,
  RECEIPT_STATUSES,
  type ExtractedReceiptFields,
  type Receipt,
  type ReceiptOcrBinding,
  type ReceiptStore,
  type ReceiptUploadCommand,
} from './receipt.port.js';
import { toReceiptFields } from './receipt-command.js';

interface ReceiptRow extends Record<string, unknown> {
  id: string;
  status: Receipt['status'];
  fileName: string;
  processingLocation: Receipt['processingLocation'];
  merchant: Receipt['merchant'];
  date: Receipt['date'];
  currency: Receipt['currency'];
  total: Receipt['total'];
  transactionId: string | null;
  createdAt: Date;
}

export class PostgresReceiptAdapter implements ReceiptStore {
  public createId(): string {
    return crypto.randomUUID();
  }

  public async create(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    id: string,
    command: ReceiptUploadCommand,
    storagePath: string,
    jobId?: string,
  ): Promise<Receipt> {
    const location =
      command.processingPreference ===
      RECEIPT_PROCESSING_PREFERENCES.DEVICE_RESULT
        ? RECEIPT_PROCESSING_LOCATIONS.DEVICE
        : command.processingPreference ===
            RECEIPT_PROCESSING_PREFERENCES.EXTERNAL_PROVIDER
          ? RECEIPT_PROCESSING_LOCATIONS.EXTERNAL_PROVIDER
          : RECEIPT_PROCESSING_LOCATIONS.SAVIA;
    const fields = toReceiptFields(command.deviceOcrResult);
    const result = await client.query<ReceiptRow>(
      `insert into public.receipts (id, workspace_id, status, file_name, processing_location, storage_path, merchant, date, currency, total, created_by, job_id)
       values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::uuid, $12::uuid)
       returning id::text, status, file_name as "fileName", processing_location as "processingLocation", merchant, date, currency, total, transaction_id::text as "transactionId", created_at as "createdAt"`,
      [
        id,
        workspaceId,
        command.processingPreference ===
        RECEIPT_PROCESSING_PREFERENCES.DEVICE_RESULT
          ? RECEIPT_STATUSES.AWAITING_REVIEW
          : RECEIPT_STATUSES.UPLOADED,
        command.fileName,
        location,
        storagePath,
        fields.merchant,
        fields.date,
        fields.currency,
        fields.total,
        subject,
        jobId ?? null,
      ],
    );
    return toReceipt(result.rows[0]);
  }

  public async find(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<Receipt | undefined> {
    const result = await client.query<ReceiptRow>(
      `select id::text, status, file_name as "fileName", processing_location as "processingLocation", merchant, date, currency, total, transaction_id::text as "transactionId", created_at as "createdAt"
         from public.receipts where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, id],
    );
    const row = result.rows[0];
    return row ? toReceipt(row) : undefined;
  }

  public async claim(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<boolean> {
    const result = await client.query(
      `update public.receipts set updated_at = now()
         where workspace_id = $1::uuid and id = $2::uuid and status in ('uploaded', 'awaiting_review', 'failed') and transaction_id is null`,
      [workspaceId, id],
    );
    return result.rowCount === 1;
  }

  public async confirm(
    client: TransactionClient,
    workspaceId: string,
    id: string,
    transactionId: string,
  ): Promise<boolean> {
    const result = await client.query(
      `update public.receipts set status = 'confirmed', transaction_id = $3::uuid, updated_at = now(), version = version + 1
         where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, id, transactionId],
    );
    return result.rowCount === 1;
  }

  public async findOcrBinding(
    client: TransactionClient,
    workspaceId: string,
    receiptId: string,
    jobId: string,
  ): Promise<ReceiptOcrBinding | null> {
    const result = await client.query<{
      id: string;
      workspaceId: string;
      storagePath: string;
      jobId: string;
      createdBy: string;
      status: string;
      transactionId: string | null;
    }>(
      `select r.id::text,
              r.workspace_id::text as "workspaceId",
              r.storage_path as "storagePath",
              r.job_id::text as "jobId",
              r.created_by::text as "createdBy",
              r.status,
              r.transaction_id::text as "transactionId"
         from public.receipts r
        where r.workspace_id = $1::uuid
          and r.id = $2::uuid
          and r.job_id = $3::uuid`,
      [workspaceId, receiptId, jobId],
    );
    const row = result.rows[0];
    return row ?? null;
  }

  public async updateOcrResultCas(
    client: TransactionClient,
    workspaceId: string,
    receiptId: string,
    jobId: string,
    fields: ExtractedReceiptFields,
  ): Promise<boolean> {
    const result = await client.query(
      `update public.receipts
          set status = 'awaiting_review',
              merchant = $4::jsonb,
              date = $5::jsonb,
              currency = $6::jsonb,
              total = $7::jsonb,
              updated_at = now(),
              version = version + 1
        where workspace_id = $1::uuid
          and id = $2::uuid
          and job_id = $3::uuid
          and transaction_id is null
          and status in ('uploaded', 'processing')`,
      [
        workspaceId,
        receiptId,
        jobId,
        fields.merchant ? JSON.stringify(fields.merchant) : null,
        fields.date ? JSON.stringify(fields.date) : null,
        fields.currency ? JSON.stringify(fields.currency) : null,
        fields.total ? JSON.stringify(fields.total) : null,
      ],
    );
    return result.rowCount === 1;
  }
}

function toReceipt(row: ReceiptRow): Receipt {
  return {
    id: row.id,
    status: row.status,
    fileName: row.fileName,
    processingLocation: row.processingLocation,
    merchant: row.merchant,
    date: row.date,
    currency: row.currency,
    total: row.total,
    transactionId: row.transactionId,
    createdAt: row.createdAt.toISOString(),
  };
}
