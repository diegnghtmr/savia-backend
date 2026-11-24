import type { PgTransaction } from '../platform/pg-transaction.js';
import type {
  FrankfurterPair,
  FrankfurterPublication,
  FrankfurterRateStore,
} from './frankfurter-rate-job.js';

const DB_TIMEOUT_MS = 5_000;

export class PostgresFrankfurterRateAdapter implements FrankfurterRateStore {
  public constructor(private readonly transaction: PgTransaction) {}

  public listPairs(): Promise<readonly FrankfurterPair[]> {
    return this.transaction.runAsQueueConsumer(async (client) => {
      const { rows } = await client.query<FrankfurterPair>(
        'select * from public.list_frankfurter_pairs()',
      );
      return rows;
    }, DB_TIMEOUT_MS);
  }

  public async append(rates: readonly FrankfurterPublication[]): Promise<void> {
    await this.transaction.runAsQueueConsumer(
      (client) =>
        client.query('select public.append_frankfurter_rates($1::jsonb)', [
          JSON.stringify(rates),
        ]),
      DB_TIMEOUT_MS,
    );
  }
}
