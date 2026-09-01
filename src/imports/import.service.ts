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
import type { JobWriter } from '../platform/job-writer.port.js';
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
class ImportValidationError extends Error {}

const DEBIT_INDICATORS = new Set(['debit', 'd', 'dr', 'débito', 'cargo']);
const CREDIT_INDICATORS = new Set(['credit', 'c', 'cr', 'crédito', 'abono']);
function separateColumnAmount(value: unknown, amount: number): number {
  const indicator = String(value ?? '')
    .trim()
    .toLocaleLowerCase();
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
  const result = `${year}-${month}-${day}`;
  const date = new Date(`${result}T00:00:00Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== result
  )
    throw new ImportValidationError('Date is invalid.');
  return result;
}
export class ImportService implements ImportsPort {
  public constructor(
    private readonly tx: ImportTransaction,
    private readonly store: ImportStore,
    private readonly idem: IdempotencyStore,
    private readonly jobs: JobWriter,
    private readonly ledger: LedgerWriter,
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
    return this.tx
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
        if (importJob.status !== 'awaiting_mapping')
          return {
            kind: IMPORT_MUTATION_OUTCOMES.INVALID,
            detail: 'Import job is not awaiting_mapping.',
          };
        const targets = new Set(Object.values(command.columnMapping));
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
          Object.entries(command.columnMapping).find(
            ([, value]) => value === target,
          )?.[0];
        if (
          Object.keys(command.columnMapping).some(
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
        const rows = await this.store.findRows(client, workspaceId, id);
        const prepared: Array<{
          date: string;
          amountMinor: string;
          description: string;
        }> = [];
        for (const row of rows) {
          if (row.classification !== 'valid') continue;
          const date = parseImportDate(
            String(row.rawValues[index('date')] ?? '').trim(),
            dateFormat,
          );
          let amount = Number(row.rawValues[index('amount')]);
          if (!Number.isSafeInteger(amount))
            throw new ImportValidationError(
              'Computed amount cannot be stored.',
            );
          const sign = command.debitSign ?? DEBIT_SIGNS.NEGATIVE;
          if (sign === DEBIT_SIGNS.POSITIVE) amount = -amount;
          if (sign === DEBIT_SIGNS.SEPARATE_COLUMN)
            amount = separateColumnAmount(
              row.rawValues[index('debitCreditIndicator')],
              amount,
            );
          if (!Number.isSafeInteger(amount))
            throw new ImportValidationError(
              'Computed amount cannot be stored.',
            );
          const description = String(
            row.rawValues[index('description')] ?? '',
          ).trim();
          prepared.push({ date, amountMinor: String(amount), description });
        }
        const duplicateIndexes =
          command.skipDuplicateCandidates !== false
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
