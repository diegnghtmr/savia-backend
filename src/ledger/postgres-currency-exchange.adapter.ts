import type { TransactionClient } from '../platform/pg-transaction.js';
import { enforceDeferredConstraints } from '../platform/deferred-constraints.js';
import { negateAmountMinor, toIso } from './postgres-transaction.adapter.js';
import type {
  CreateCurrencyExchangeCommand,
  Transfer,
} from './currency-exchange.port.js';
import type { CurrencyExchangeStore } from './currency-exchange.service.js';
import type { TransferAccountRecord } from './transfer.service.js';

interface TransferRow extends Record<string, unknown> {
  readonly id: string;
  readonly sourceAccountId: string;
  readonly destinationAccountId: string;
  readonly sourceAmountMinor: string;
  readonly sourceCurrency: string;
  readonly destinationAmountMinor: string;
  readonly destinationCurrency: string;
  readonly feeAmountMinor: string | null;
  readonly feeCurrency: string | null;
  readonly exchangeRate: string | null;
  readonly referenceRate: string | null;
  readonly occurredAt: Date;
  readonly status: Transfer['status'];
  readonly transactionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export class PostgresCurrencyExchangeAdapter implements CurrencyExchangeStore {
  public async readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined> {
    const result = await client.query<{ role: string | null }>(
      'select public.workspace_actor_active_role($1::uuid) as role',
      [workspaceId],
    );
    const role = result.rows[0]?.role;
    return typeof role === 'string' ? role : undefined;
  }

  public async lockAndReadAccounts(
    client: TransactionClient,
    workspaceId: string,
    sourceAccountId: string,
    destinationAccountId: string,
  ): Promise<{
    sourceAccount?: TransferAccountRecord;
    destinationAccount?: TransferAccountRecord;
  }> {
    // Sort the two account IDs lexicographically and acquire advisory locks in that total order.
    // Two concurrent transfers moving money in opposite directions between the same pair of accounts
    // would otherwise acquire locks in opposite order and deadlock if both transactions run concurrently.
    // Sorting ensures a global total ordering on lock acquisition across all transfers, preventing deadlocks.
    const sortedIds = [
      sourceAccountId.toLowerCase(),
      destinationAccountId.toLowerCase(),
    ].sort((a, b) => a.localeCompare(b));

    for (const accountId of sortedIds) {
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1, 0))',
        [accountId],
      );
    }

    const accountResult = await client.query<{
      id: string;
      status: string;
      currency: string;
    }>(
      'select a.id::text, a.status, a.currency from public.accounts a where a.workspace_id = $1::uuid and a.id in ($2::uuid, $3::uuid)',
      [workspaceId, sourceAccountId, destinationAccountId],
    );

    const sourceRow = accountResult.rows.find(
      (r) => r.id.toLowerCase() === sourceAccountId.toLowerCase(),
    );
    const destRow = accountResult.rows.find(
      (r) => r.id.toLowerCase() === destinationAccountId.toLowerCase(),
    );

    return {
      sourceAccount: sourceRow
        ? {
            id: sourceRow.id,
            status: sourceRow.status,
            currency: sourceRow.currency,
          }
        : undefined,
      destinationAccount: destRow
        ? {
            id: destRow.id,
            status: destRow.status,
            currency: destRow.currency,
          }
        : undefined,
    };
  }

  public async createCurrencyExchange(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateCurrencyExchangeCommand,
  ): Promise<Transfer> {
    // 1. Insert transfer header row into public.transfers (transfers never write to public.transactions)
    const transferSql = `
insert into public.transfers (
  workspace_id,
  source_account_id,
  destination_account_id,
  source_amount_minor,
  source_currency,
  destination_amount_minor,
  destination_currency,
  fee_amount_minor,
  fee_currency,
  exchange_rate,
  reference_rate,
  occurred_at,
  status,
  transaction_id,
  created_by
)
values (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4,
  $5,
  $6,
  $7,
  $8,
  $9,
  $10,
  $11,
  $12::timestamptz,
  $13,
  $14::uuid,
  $15::uuid
)
returning
  id::text,
  source_account_id::text as "sourceAccountId",
  destination_account_id::text as "destinationAccountId",
  source_amount_minor as "sourceAmountMinor",
  source_currency as "sourceCurrency",
  destination_amount_minor as "destinationAmountMinor",
  destination_currency as "destinationCurrency",
  fee_amount_minor as "feeAmountMinor",
  fee_currency as "feeCurrency",
  exchange_rate as "exchangeRate",
  reference_rate as "referenceRate",
  occurred_at as "occurredAt",
  status,
  transaction_id::text as "transactionId",
  created_at as "createdAt",
  updated_at as "updatedAt",
  version`;

    const transferValues = [
      workspaceId,
      command.sourceAccountId,
      command.destinationAccountId,
      command.sourceAmount.amountMinor,
      command.sourceAmount.currency,
      command.destinationAmount.amountMinor,
      command.destinationAmount.currency,
      command.fee?.amountMinor ?? null,
      command.fee?.currency ?? null,
      command.executedRate,
      command.referenceRate ?? null,
      command.occurredAt,
      'confirmed',
      null, // transaction_id linking fee transaction
      subject,
    ];

    const transferResult = await client.query<TransferRow>(
      transferSql,
      transferValues,
    );
    const row = transferResult.rows[0];
    if (!row) {
      throw new Error('Created currency exchange row could not be read.');
    }

    // 2. Insert FOUR postings (D1):
    // Source currency:
    //   -sourceAmount on source account (leg_kind 'account')
    //   +sourceAmount external leg (leg_kind 'external', account_id null)
    // Destination currency:
    //   -destinationAmount external leg (leg_kind 'external', account_id null)
    //   +destinationAmount on destination account (leg_kind 'account')
    // Each currency group sums to zero with at least two legs, satisfying enforce_balanced_ledger_postings.
    const postingsSql = `
insert into public.ledger_postings (
  workspace_id,
  transfer_id,
  transaction_id,
  account_id,
  leg_kind,
  amount_minor,
  currency,
  status,
  occurred_at
)
values
  ($1::uuid, $2::uuid, null, $3::uuid, 'account', $4, $5, 'confirmed', $6),
  ($1::uuid, $2::uuid, null, null, 'external', $7, $5, 'confirmed', $6),
  ($1::uuid, $2::uuid, null, null, 'external', $8, $9, 'confirmed', $6),
  ($1::uuid, $2::uuid, null, $10::uuid, 'account', $11, $9, 'confirmed', $6)`;

    const postingsValues = [
      workspaceId,
      row.id,
      command.sourceAccountId,
      negateAmountMinor(command.sourceAmount.amountMinor),
      command.sourceAmount.currency,
      row.occurredAt,
      command.sourceAmount.amountMinor,
      negateAmountMinor(command.destinationAmount.amountMinor),
      command.destinationAmount.currency,
      command.destinationAccountId,
      command.destinationAmount.amountMinor,
    ];

    await client.query(postingsSql, postingsValues);

    // 3. Enforce deferred constraints (balanced-postings check) before commit (D2)
    await enforceDeferredConstraints(client);

    return {
      id: row.id,
      sourceAccountId: row.sourceAccountId,
      destinationAccountId: row.destinationAccountId,
      sourceAmount: {
        amountMinor: String(row.sourceAmountMinor),
        currency: row.sourceCurrency,
      },
      destinationAmount: {
        amountMinor: String(row.destinationAmountMinor),
        currency: row.destinationCurrency,
      },
      occurredAt: toIso(row.occurredAt),
      status: row.status,
      ...(row.feeAmountMinor !== null && row.feeCurrency !== null
        ? {
            fee: {
              amountMinor: String(row.feeAmountMinor),
              currency: row.feeCurrency,
            },
            ...(row.transactionId ? { transactionId: row.transactionId } : {}),
          }
        : {}),
      ...(row.exchangeRate !== null && row.exchangeRate !== undefined
        ? { exchangeRate: row.exchangeRate }
        : {}),
      ...(row.referenceRate !== null && row.referenceRate !== undefined
        ? { referenceRate: row.referenceRate }
        : {}),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      version: row.version,
    };
  }
}
