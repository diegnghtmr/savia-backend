import { randomUUID } from 'node:crypto';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import { negateAmountMinor } from '../platform/amount-minor.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  IMPORT_FORMATS,
  IMPORT_OUTCOMES,
  isFixedStatementFormat,
  type ImportFormat,
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
import { parseQifDate, previewQifDate } from './qif-parser.js';
import {
  QIF_PREVIEW_CURRENCY_DIGITS,
  statementAmount,
  statementCurrencyDigits,
  statementDate,
} from './statement-fields.js';
import type { JobWriter } from '../platform/job-writer.port.js';
import type { NotificationWriter } from '../platform/notification-writer.port.js';
import type { LedgerWriter } from '../platform/ledger-writer.port.js';
import {
  DEBIT_SIGNS,
  IMPORT_MUTATION_OUTCOMES,
  type CommitImportCommand,
  type ImportMutationOutcome,
} from './import.port.js';
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
export { IMPORT_COMMIT_BATCH_SIZE } from '../platform/import-batch-policy.js';
/**
 * Maximum single SQL statement latency for a 2,500-row batch insert was measured
 * at ~140 ms (5,000 ledger_postings unnest rows). A tight 2,000 ms per-statement
 * cap provides a >14x safety margin against CI runner disk stalls without leaving
 * the database unguarded against runaway queries.
 */
export const IMPORT_COMMIT_STATEMENT_TIMEOUT_MS = 2_000;

/**
 * Callback budget derivation for maximum 10,000-row import:
 * - 10,000 rows chunked at IMPORT_COMMIT_BATCH_SIZE (2,500 rows) = 4 batches.
 * - Measured per-batch SQL execution: ~110 ms (transactions) + ~140 ms (postings)
 *   + ~15 ms (findExistingBatch) = ~265 ms.
 * - In-memory parsing and row mapping: ~15 ms per batch.
 * - Under heavy CI runner load with shared disk I/O, we budget 1,000 ms per batch.
 * - Fixed overhead (advisory locks, job status transitions, terminal idempotency): 1,000 ms.
 *
 * Arithmetic:
 *   4 batches * 1,000 ms/batch + 1,000 ms overhead = 5,000 ms.
 *
 * This provides >4.4x safety headroom above the measured 1,120 ms callback duration.
 */
export const IMPORT_COMMIT_CALLBACK_TIMEOUT_MS = 5_000;
class ImportValidationError extends Error {}

function isOfx(format: ImportFormat | null): boolean {
  return format === 'ofx' || format === 'qfx';
}

const FIXED_STATEMENT_MAPPING = {
  date: 'date',
  amount: 'amount',
  description: 'description',
};

function statementRowIdentity(
  date: string,
  amount: unknown,
  description: string,
  reference: unknown,
  fitid: unknown,
): string {
  return fitid
    ? JSON.stringify(['fitid', fitid])
    : JSON.stringify([
        'row',
        date,
        amount,
        normalizeImportDescription(description),
        reference,
      ]);
}

function importRowIdentity(format: ImportFormat, row: ParsedImportRow): string {
  if (!isFixedStatementFormat(format))
    return `${row.parsedDate}|${row.parsedAmountMinor}|${normalizeImportDescription(row.parsedDescription!)}`;
  const field = (name: string) =>
    row.rawValues[row.sourceColumns.indexOf(name)];
  return statementRowIdentity(
    row.parsedDate!,
    format === 'qif' ? field('amount') : row.parsedAmountMinor,
    row.parsedDescription!,
    field('reference'),
    field('fitid'),
  );
}

const DEBIT_INDICATORS = new Set(['debit', 'd', 'dr', 'db', 'debito', 'cargo']);
const CREDIT_INDICATORS = new Set(['credit', 'c', 'cr', 'credito', 'abono']);
function separateColumnAmount(value: unknown, amount: number): number {
  const indicator = String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (DEBIT_INDICATORS.has(indicator)) return -Math.abs(amount);
  if (CREDIT_INDICATORS.has(indicator)) return Math.abs(amount);
  throw new ImportValidationError(
    'debitCreditIndicator must be a recognized debit or credit token.',
  );
}

function parseImportDate(value: string, format: string): string {
  const match =
    format === 'YYYY-MM-DD'
      ? /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
      : /^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(value);
  if (!match)
    throw new ImportValidationError('Date does not match dateFormat.');
  const year = format === 'YYYY-MM-DD' ? match[1] : match[3];
  const month =
    format === 'YYYY-MM-DD'
      ? match[2]
      : format === 'MM/DD/YYYY'
        ? match[1]
        : match[2];
  const day =
    format === 'YYYY-MM-DD'
      ? match[3]
      : format === 'MM/DD/YYYY'
        ? match[2]
        : match[1];
  const date = statementDate(year, month, day);
  if (!date) throw new ImportValidationError('Date is invalid.');
  return date;
}
export class ImportService implements ImportsPort {
  public constructor(
    private readonly tx: ImportTransaction,
    private readonly store: ImportStore,
    private readonly idem: IdempotencyStore,
    private readonly jobs: JobWriter,
    private readonly ledger: LedgerWriter,
    private readonly commitTx: ImportTransaction = tx,
    private readonly notifications?: NotificationWriter,
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
    const extension = /\.([^.]+)$/u.exec(command.fileName.toLowerCase())?.[1];
    const format =
      command.formatHint ??
      IMPORT_FORMATS.find((known) => known === extension) ??
      'csv';
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
      const key = importRowIdentity(format, row);
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
        classified[0]?.sourceColumns ?? [],
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
  public async commitImport(
    subject: string,
    workspaceId: string,
    id: string,
    command: CommitImportCommand,
    key: string,
  ): Promise<ImportMutationOutcome> {
    const route = 'POST /v1/import-jobs/{importJobId}/commit';
    const fingerprint = computeRequestFingerprint({ id, ...command });
    return this.commitTx
      .run(subject, async (client) => {
        await this.store.lockWorkspace(client, workspaceId);
        const account = await this.store.lockAccount(
          client,
          workspaceId,
          command.accountId,
        );
        if (!account) return { kind: IMPORT_MUTATION_OUTCOMES.NOT_FOUND };
        if (account.status === 'closed')
          return { kind: IMPORT_MUTATION_OUTCOMES.ACCOUNT_CLOSED };
        const role = await this.store.readActiveRole(client, workspaceId);
        if (!role || !['owner', 'administrator', 'editor'].includes(role))
          return { kind: IMPORT_MUTATION_OUTCOMES.FORBIDDEN };
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
                kind: IMPORT_MUTATION_OUTCOMES.REPLAYED,
                status: existing.responseStatus,
                body: existing.responseBody,
              }
            : { kind: IMPORT_MUTATION_OUTCOMES.CONFLICT };
        const importJob = await this.store.find(client, workspaceId, id);
        if (!importJob) return { kind: IMPORT_MUTATION_OUTCOMES.NOT_FOUND };
        if (importJob.status === 'completed')
          return {
            kind: IMPORT_MUTATION_OUTCOMES.CONFLICT,
            detail: 'Import job has already been completed.',
          };
        const fixed = isFixedStatementFormat(importJob.detectedFormat);
        if (
          importJob.status !== 'awaiting_mapping' &&
          !(fixed && importJob.status === 'awaiting_confirmation')
        )
          return {
            kind: IMPORT_MUTATION_OUTCOMES.INVALID,
            detail: 'Import job is not awaiting_mapping.',
          };
        const suppliedMapping = Object.entries(command.columnMapping);
        // OpenAPI requires the object, but fixed formats need no user mapping.
        // Accept an explicit identity mapping too, for existing clients.
        if (
          fixed &&
          suppliedMapping.length > 0 &&
          (suppliedMapping.length !==
            Object.keys(FIXED_STATEMENT_MAPPING).length ||
            suppliedMapping.some(
              ([name, target]) =>
                !Object.hasOwn(FIXED_STATEMENT_MAPPING, name) ||
                name !== target,
            ))
        )
          return {
            kind: IMPORT_MUTATION_OUTCOMES.INVALID,
            detail:
              'Statement columnMapping must use the fixed date, amount, and description fields.',
          };
        const columnMapping = fixed
          ? FIXED_STATEMENT_MAPPING
          : command.columnMapping;
        const targets = new Set(Object.values(columnMapping));
        for (const required of ['date', 'amount', 'description'])
          if (!targets.has(required))
            return {
              kind: IMPORT_MUTATION_OUTCOMES.INVALID,
              detail: `columnMapping must include ${required}.`,
            };
        const recognized = new Set([
          'date',
          'amount',
          'description',
          'debitCreditIndicator',
        ]);
        if ([...targets].some((target) => !recognized.has(target)))
          return {
            kind: IMPORT_MUTATION_OUTCOMES.INVALID,
            detail: 'columnMapping contains an unrecognized target.',
          };
        if (
          command.debitSign === DEBIT_SIGNS.SEPARATE_COLUMN &&
          !targets.has('debitCreditIndicator')
        )
          return {
            kind: IMPORT_MUTATION_OUTCOMES.INVALID,
            detail: 'debitCreditIndicator is required for separate_column.',
          };
        const source = (target: string): string | undefined =>
          Object.entries(columnMapping).find(
            ([, value]) => value === target,
          )?.[0];
        if (
          Object.keys(columnMapping).some(
            (name) => !importJob.sourceColumns.includes(name),
          )
        )
          return {
            kind: IMPORT_MUTATION_OUTCOMES.INVALID,
            detail:
              'columnMapping contains a source column not present in the import.',
          };
        const index = (target: string): number => {
          const name = source(target);
          return name === undefined
            ? -1
            : importJob.sourceColumns.indexOf(name);
        };
        const dateFormat = command.dateFormat ?? 'YYYY-MM-DD';
        if (!['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'].includes(dateFormat))
          return {
            kind: IMPORT_MUTATION_OUTCOMES.INVALID,
            detail: 'dateFormat is not supported.',
          };
        const qifDigits =
          importJob.detectedFormat === 'qif'
            ? statementCurrencyDigits(account.currency)
            : undefined;
        if (importJob.detectedFormat === 'qif') {
          if (qifDigits === undefined)
            return {
              kind: IMPORT_MUTATION_OUTCOMES.INVALID,
              detail: 'The selected account currency is unsupported for QIF.',
            };
        }
        const currencyIndex = isOfx(importJob.detectedFormat)
          ? importJob.sourceColumns.indexOf('currency')
          : null;
        const dateColumn = index('date');
        const amountColumn = index('amount');
        const descriptionColumn = index('description');
        const sign = command.debitSign ?? DEBIT_SIGNS.NEGATIVE;
        const isQifDate =
          importJob.detectedFormat === 'qif' &&
          importJob.sourceColumns[dateColumn] === 'date';
        const skipDuplicates = command.skipDuplicateCandidates !== false;
        const rows = await this.store.findRows(client, workspaceId, id);
        const seen = new Set<string>();
        const referenceColumn = importJob.sourceColumns.indexOf('reference');
        const fitidColumn = importJob.sourceColumns.indexOf('fitid');
        const prepared: Array<{
          date: string;
          amountMinor: string;
          description: string;
        }> = [];
        for (const row of rows) {
          const skipped =
            row.classification === 'error' ||
            (!fixed && skipDuplicates && row.classification === 'duplicate');
          if (
            currencyIndex !== null &&
            row.rawValues[currencyIndex] !== account.currency
          )
            throw new ImportValidationError(
              'Statement currency must match the selected account currency.',
            );
          if (skipped) continue;
          const rawDate = String(row.rawValues[dateColumn] ?? '').trim();
          const date =
            isQifDate && command.dateFormat !== 'YYYY-MM-DD'
              ? parseImportDate(
                  command.dateFormat == null
                    ? previewQifDate(rawDate) || rawDate
                    : parseQifDate(rawDate, dateFormat === 'DD/MM/YYYY'),
                  'YYYY-MM-DD',
                )
              : parseImportDate(rawDate, dateFormat);
          const rawAmount = row.rawValues[amountColumn];
          let amountMinor: string;
          if (fixed) {
            // Pre-upgrade jobs stored the minor-unit integer as a JSON number.
            const legacyAmount =
              typeof rawAmount === 'number' && Number.isSafeInteger(rawAmount);
            if (
              legacyAmount &&
              qifDigits !== undefined &&
              qifDigits !== QIF_PREVIEW_CURRENCY_DIGITS
            )
              throw new ImportValidationError(
                'QIF requires a two-decimal account currency.',
              );
            const amount = legacyAmount
              ? String(rawAmount)
              : typeof rawAmount === 'string'
                ? statementAmount(rawAmount, qifDigits ?? 0)
                : null;
            if (amount === null)
              throw new ImportValidationError(
                'Statement amount exceeds the selected account currency precision or ledger range.',
              );
            amountMinor =
              sign === DEBIT_SIGNS.POSITIVE
                ? negateAmountMinor(amount)
                : amount;
          } else {
            let amount = Number(rawAmount);
            if (!Number.isSafeInteger(amount))
              throw new ImportValidationError(
                'Computed amount cannot be stored.',
              );
            if (sign === DEBIT_SIGNS.POSITIVE) amount = -amount;
            if (sign === DEBIT_SIGNS.SEPARATE_COLUMN)
              amount = separateColumnAmount(
                row.rawValues[index('debitCreditIndicator')],
                amount,
              );
            amountMinor = String(amount);
          }
          const description = String(
            row.rawValues[descriptionColumn] ?? '',
          ).trim();
          if (fixed && skipDuplicates) {
            const identity = statementRowIdentity(
              date,
              amountMinor,
              description,
              row.rawValues[referenceColumn],
              row.rawValues[fitidColumn],
            );
            if (seen.has(identity)) continue;
            seen.add(identity);
          }
          prepared.push({ date, amountMinor, description });
        }
        // FITID is only used within a statement. Cross-import matching still
        // compares date, amount and description within the selected account.
        const duplicateIndexes = skipDuplicates
          ? await this.store.findExistingBatch(
              client,
              workspaceId,
              command.accountId,
              prepared,
            )
          : new Set<number>();
        await this.ledger.createImportedTransactions(
          client,
          workspaceId,
          subject,
          prepared.flatMap((row, index) =>
            duplicateIndexes.has(index)
              ? []
              : [
                  {
                    accountId: command.accountId,
                    amountMinor: row.amountMinor,
                    currency: account.currency,
                    occurredAt: `${row.date}T00:00:00.000Z`,
                    description: row.description,
                    importJobId: id,
                  },
                ],
          ),
        );
        const completed = await this.store.complete(
          client,
          workspaceId,
          id,
          command.accountId,
          'completed',
        );
        if (!completed)
          return {
            kind: IMPORT_MUTATION_OUTCOMES.CONFLICT,
            detail: 'Import job could not be completed.',
          };
        const job = await this.jobs.createTerminalJob(
          client,
          workspaceId,
          subject,
          'import_commit',
          'completed',
          id,
          null,
        );
        if (
          !(await this.idem.write(
            client,
            subject,
            route,
            key,
            fingerprint,
            202,
            null,
            job,
            workspaceId,
          ))
        )
          throw new Error('Import idempotency record was lost.');
        await this.notifications?.publish(client, {
          workspaceId,
          recipientId: subject,
          resourceId: id,
          type: 'import_completed',
          title: 'Import completed',
        });
        return { kind: IMPORT_MUTATION_OUTCOMES.OK, job };
      })
      .catch((error: unknown) => {
        if (error instanceof ImportValidationError)
          return {
            kind: IMPORT_MUTATION_OUTCOMES.INVALID,
            detail: error.message,
          };
        throw error;
      });
  }
  public async rollbackImport(
    subject: string,
    workspaceId: string,
    id: string,
    key: string,
  ): Promise<ImportMutationOutcome> {
    const route = 'POST /v1/import-jobs/{importJobId}/rollback';
    const fingerprint = computeRequestFingerprint({ id });
    return this.tx
      .run(subject, async (client) => {
        await this.store.lockWorkspace(client, workspaceId);
        const role = await this.store.readActiveRole(client, workspaceId);
        if (!role || !['owner', 'administrator', 'editor'].includes(role))
          return { kind: IMPORT_MUTATION_OUTCOMES.FORBIDDEN };
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
                kind: IMPORT_MUTATION_OUTCOMES.REPLAYED,
                status: existing.responseStatus,
                body: existing.responseBody,
              }
            : { kind: IMPORT_MUTATION_OUTCOMES.CONFLICT };
        let importJob = await this.store.find(client, workspaceId, id);
        if (!importJob) return { kind: IMPORT_MUTATION_OUTCOMES.NOT_FOUND };
        if (importJob.status === 'rolled_back')
          return {
            kind: IMPORT_MUTATION_OUTCOMES.CONFLICT,
            detail: 'Import job has already been rolled back.',
          };
        if (importJob.status !== 'completed' || !importJob.accountId)
          return {
            kind: IMPORT_MUTATION_OUTCOMES.INVALID,
            detail: 'Import job is not completed.',
          };
        const account = await this.store.lockAccount(
          client,
          workspaceId,
          importJob.accountId,
        );
        if (!account) return { kind: IMPORT_MUTATION_OUTCOMES.NOT_FOUND };
        if (account.status === 'closed')
          return { kind: IMPORT_MUTATION_OUTCOMES.ACCOUNT_CLOSED };
        importJob = await this.store.find(client, workspaceId, id);
        if (
          !importJob ||
          importJob.status !== 'completed' ||
          !importJob.accountId
        )
          return {
            kind: IMPORT_MUTATION_OUTCOMES.CONFLICT,
            detail: 'Import job state changed while waiting for its locks.',
          };
        const importedTransactions = await this.store.findImportedTransactions(
          client,
          workspaceId,
          id,
        );
        if (
          importedTransactions.some(
            (transaction) => transaction.status === 'reconciled',
          )
        )
          throw new ImportValidationError(
            'A reconciled transaction cannot be rolled back.',
          );
        for (const transaction of importedTransactions) {
          if (transaction.status === 'voided') continue;
          if (
            !(await this.ledger.voidTransaction(
              client,
              workspaceId,
              transaction.id,
              transaction.accountId,
              transaction.status,
              transaction.version,
            ))
          )
            throw new ImportValidationError(
              'Imported transaction could not be voided.',
            );
        }
        const rolledBack = await this.store.complete(
          client,
          workspaceId,
          id,
          importJob.accountId,
          'rolled_back',
        );
        if (!rolledBack)
          return {
            kind: IMPORT_MUTATION_OUTCOMES.CONFLICT,
            detail: 'Import job was already transitioned.',
          };
        const job = await this.jobs.createTerminalJob(
          client,
          workspaceId,
          subject,
          'import_rollback',
          'completed',
          id,
          null,
        );
        if (
          !(await this.idem.write(
            client,
            subject,
            route,
            key,
            fingerprint,
            202,
            null,
            job,
            workspaceId,
          ))
        )
          throw new Error('Import idempotency record was lost.');
        return { kind: IMPORT_MUTATION_OUTCOMES.OK, job };
      })
      .catch((error: unknown) => {
        if (error instanceof ImportValidationError)
          return {
            kind: IMPORT_MUTATION_OUTCOMES.INVALID,
            detail: error.message,
          };
        throw error;
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
