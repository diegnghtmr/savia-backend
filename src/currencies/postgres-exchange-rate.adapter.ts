import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  CreateManualExchangeRateCommand,
  ExchangeRate,
  ExchangeRateListQuery,
} from './exchange-rate.port.js';
import {
  ExchangeRateAlreadyRecordedError,
  type ExchangeRateStore,
} from './exchange-rate.service.js';

interface ExchangeRateRow extends Record<string, unknown> {
  readonly id: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly rate: string;
  readonly effectiveAt: Date;
  readonly source: string;
  readonly manual: boolean;
}

function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

export class PostgresExchangeRateAdapter implements ExchangeRateStore {
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

  public async createManualExchangeRate(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateManualExchangeRateCommand,
  ): Promise<ExchangeRate> {
    // D1: Server assigns source = 'manual' and manual = true for manual exchange rates.
    // D2: notes is persisted to the database column, but deliberately omitted from the returned read projection (ExchangeRate schema).
    const sql = `
insert into public.exchange_rates (
  workspace_id,
  base_currency,
  quote_currency,
  rate,
  effective_at,
  source,
  manual,
  notes,
  created_by
)
values (
  $1::uuid,
  $2,
  $3,
  $4::numeric,
  $5::timestamptz,
  'manual',
  true,
  $6,
  $7::uuid
)
returning
  id::text,
  base_currency as "baseCurrency",
  quote_currency as "quoteCurrency",
  rate::text as rate,
  effective_at as "effectiveAt",
  source,
  manual`;

    const values = [
      workspaceId,
      command.baseCurrency,
      command.quoteCurrency,
      command.rate,
      command.effectiveAt,
      command.notes ?? null,
      subject,
    ];

    try {
      const result = await client.query<ExchangeRateRow>(sql, values);
      const row = result.rows[0];
      if (!row) {
        throw new Error('Created exchange rate row could not be read.');
      }

      // D2: notes is deliberately omitted from the read projection returned to caller.
      return {
        id: row.id,
        baseCurrency: row.baseCurrency,
        quoteCurrency: row.quoteCurrency,
        rate: String(row.rate),
        effectiveAt: toIso(row.effectiveAt),
        source: row.source,
        manual: row.manual,
      };
    } catch (error: unknown) {
      // D3: Catch SQLSTATE 23505 unique constraint violation specifically, and only
      // for THIS constraint. Mapping any 23505 to "rate already recorded" would
      // silently mislabel a future unique constraint on this table as a duplicate
      // rate, so the constraint name is part of the condition rather than assumed.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: string }).code === '23505' &&
        (error as { constraint?: string }).constraint ===
          'exchange_rates_workspace_pair_effective_at_key'
      ) {
        throw new ExchangeRateAlreadyRecordedError();
      }
      throw error;
    }
  }

  public async listExchangeRates(
    client: TransactionClient,
    query: ExchangeRateListQuery,
  ): Promise<readonly ExchangeRate[]> {
    // D1: NO artificial row limit, and no invented pagination.
    // Reasoning: a silent internal cap would be worse than none, because the
    // caller would believe they had every rate when they did not; and returning
    // an error for a large result would mean inventing a business status the
    // contract does not declare. The contract's own from/to/currency filters
    // are the intended narrowing mechanism.
    // D2: Deterministic ordering: effective_at desc, id desc.
    // The composite index exchange_rates_workspace_pair_latest_idx on
    // (workspace_id, base_currency, quote_currency, effective_at desc) already exists
    // to support it. Ordering must be total, so ties on effective_at never produce
    // a nondeterministic sequence.
    // D3: Filters are ALL optional and combinable. Absent filters must not restrict
    // the result. from/to bound effective_at INCLUSIVELY at both ends. Build the
    // WHERE clause with parameterised SQL only — never string interpolation.
    // D6: rate must be returned exactly as the database stores it. rate numeric declares
    // no scale, so PostgreSQL preserves the submitted scale: a rate inserted as '0.9200'
    // reads back as '0.9200', NOT '0.92'.
    const conditions: string[] = ['workspace_id = $1::uuid'];
    const values: unknown[] = [query.workspaceId];

    if (query.baseCurrency !== undefined) {
      values.push(query.baseCurrency);
      conditions.push(`base_currency = $${values.length}`);
    }

    if (query.quoteCurrency !== undefined) {
      values.push(query.quoteCurrency);
      conditions.push(`quote_currency = $${values.length}`);
    }

    if (query.from !== undefined) {
      values.push(query.from);
      conditions.push(`effective_at >= $${values.length}::timestamptz`);
    }

    if (query.to !== undefined) {
      values.push(query.to);
      conditions.push(
        `effective_at < ($${values.length}::timestamptz + interval '1 day')`,
      );
    }

    const sql = `
select id::text,
       base_currency as "baseCurrency",
       quote_currency as "quoteCurrency",
       rate::text as rate,
       effective_at as "effectiveAt",
       source,
       manual
from public.exchange_rates
where ${conditions.join(' and ')}
order by effective_at desc, id desc`;

    const result = await client.query<ExchangeRateRow>(sql, values);

    return result.rows.map((row) => ({
      id: row.id,
      baseCurrency: row.baseCurrency,
      quoteCurrency: row.quoteCurrency,
      rate: String(row.rate),
      effectiveAt: toIso(row.effectiveAt),
      source: row.source,
      manual: row.manual,
    }));
  }
}
