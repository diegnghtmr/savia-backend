import { randomUUID } from 'node:crypto';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  IMPORT_OUTCOMES,
  type ImportCreateOutcome,
  type ImportGetOutcome,
  type ImportsPort,
  type ImportStore,
  type ImportCommand,
  type ParsedImportRow,
} from './import.port.js';
import {
  MAX_IMPORT_ROWS,
  parseImport,
  normalizeImportDescription,
} from './import-parsers.js';
export interface ImportTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}
export class ImportService implements ImportsPort {
  public constructor(
    private readonly tx: ImportTransaction,
    private readonly store: ImportStore,
    private readonly idem: IdempotencyStore,
  ) {}
  public async createImportJob(
    subject: string,
    workspaceId: string,
    command: ImportCommand,
    key: string,
  ): Promise<ImportCreateOutcome> {
    const route = 'POST /v1/import-jobs';
    const fingerprint = computeRequestFingerprint({
      fileName: command.fileName,
      formatHint: command.formatHint,
      bytes: command.bytes.toString('base64'),
    });
    let format = command.formatHint;
    if (!format)
      format = command.fileName.toLowerCase().endsWith('.xlsx')
        ? 'xlsx'
        : 'csv';
    let rows: readonly ParsedImportRow[];
    try {
      rows = await parseImport(format, command.bytes);
    } catch (error) {
      return {
        kind: IMPORT_OUTCOMES.FAILED,
        detail:
          error instanceof Error
            ? error.message
            : 'The import file could not be parsed.',
      };
    }
    if (rows.length > MAX_IMPORT_ROWS)
      return {
        kind: IMPORT_OUTCOMES.FAILED,
        detail: `The import exceeds the maximum of ${MAX_IMPORT_ROWS} rows.`,
      };
    const seen = new Set<string>();
    let valid = 0;
    let duplicate = 0;
    let errors = 0;
    const classified = rows.map((row) => {
      if (row.classification === 'error') {
        errors += 1;
        return row;
      }
      const key = `${row.parsedDate}|${row.parsedAmountMinor}|${normalizeImportDescription(row.parsedDescription!)}`;
      if (seen.has(key)) {
        duplicate += 1;
        return { ...row, classification: 'duplicate' as const };
      }
      seen.add(key);
      valid += 1;
      return row;
    });
    return this.tx.run(subject, async (client) => {
      const role = await this.store.readActiveRole(client, workspaceId);
      if (!role || !['owner', 'administrator', 'editor'].includes(role))
        return { kind: IMPORT_OUTCOMES.FORBIDDEN };
      const existing = await this.idem.read(
        client,
        subject,
        route,
        key,
        workspaceId,
      );
      if (existing)
        return existing.requestFingerprint === fingerprint
          ? {
              kind: IMPORT_OUTCOMES.REPLAYED,
              status: existing.responseStatus,
              body: existing.responseBody,
            }
          : { kind: IMPORT_OUTCOMES.CONFLICT };
      const job = await this.store.createJob(
        client,
        workspaceId,
        subject,
        randomUUID(),
        command.fileName,
        format,
        classified,
        { total: rows.length, valid, duplicate, errors },
        null,
      );
      const written = await this.idem.write(
        client,
        subject,
        route,
        key,
        fingerprint,
        202,
        null,
        job,
        workspaceId,
      );
      if (!written) throw new Error('Import idempotency record was lost.');
      return { kind: IMPORT_OUTCOMES.CREATED, job };
    });
  }
  public getImportJob(
    subject: string,
    workspaceId: string,
    id: string,
  ): Promise<ImportGetOutcome> {
    return this.tx.runRead(subject, async (client) => {
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        !role ||
        !['owner', 'administrator', 'editor', 'viewer'].includes(role)
      )
        return { kind: 'forbidden' };
      const job = await this.store.find(client, workspaceId, id);
      return job ? { kind: 'found', job } : { kind: 'not-found' };
    });
  }
}
