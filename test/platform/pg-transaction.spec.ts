import { describe, expect, it, vi } from 'vitest';
import { DeliveryDeadlineExceededError } from '../../src/platform/delivery-deadline.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import type { PgClient, PgPool } from '../../src/platform/postgres-pool.js';
import type { QueryResult } from 'pg';

class RecordingPool implements PgPool {
  public availableSlots = 5;
  public readonly client: RecordingClient;
  private readonly delayMs: number;

  public constructor(delayMs: number) {
    this.delayMs = delayMs;
    this.client = new RecordingClient(this);
  }

  public async connect(): Promise<PgClient> {
    this.availableSlots--;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.client;
  }

  public async end(): Promise<void> {}
}

class RecordingClient implements PgClient {
  public readonly queries: string[] = [];
  public released = false;
  public releaseError: Error | undefined;

  public constructor(private readonly pool: RecordingPool) {}

  public async query<Row extends Record<string, unknown>>(
    text: string,
  ): Promise<QueryResult<Row>> {
    this.queries.push(text);
    return {
      command: 'SELECT',
      rowCount: 0,
      rows: [] as Row[],
      oid: 0,
      fields: [],
    };
  }

  public release(error?: Error): void {
    if (!this.released) {
      this.released = true;
      this.releaseError = error;
      this.pool.availableSlots++;
    }
  }
}

describe('PgTransaction lifetime checkout resilience', () => {
  it('fails closed when pool checkout completes after the lifetime deadline (run)', async () => {
    const pool = new RecordingPool(60);
    const transaction = new PgTransaction(pool);
    const subject = '00000000-0000-0000-0000-000000000001';
    const callback = vi.fn(async () => 'ok');

    const runPromise = transaction.run(
      subject,
      callback,
      undefined,
      undefined,
      15,
    );

    await expect(runPromise).rejects.toBeInstanceOf(
      DeliveryDeadlineExceededError,
    );

    // Wait for the delayed checkout to finish
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(callback).not.toHaveBeenCalled();
    expect(pool.client.queries).toHaveLength(0);
    expect(pool.client.released).toBe(true);
    expect(pool.client.releaseError).toBeInstanceOf(
      DeliveryDeadlineExceededError,
    );
    expect(pool.availableSlots).toBe(5);
  });

  it('fails closed when pool checkout completes after the lifetime deadline (runAsQueueConsumer)', async () => {
    const pool = new RecordingPool(60);
    const transaction = new PgTransaction(pool);
    const callback = vi.fn(async () => 'ok');

    const runPromise = transaction.runAsQueueConsumer(callback, 15);

    await expect(runPromise).rejects.toBeInstanceOf(
      DeliveryDeadlineExceededError,
    );

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(callback).not.toHaveBeenCalled();
    expect(pool.client.queries).toHaveLength(0);
    expect(pool.client.released).toBe(true);
    expect(pool.client.releaseError).toBeInstanceOf(
      DeliveryDeadlineExceededError,
    );
    expect(pool.availableSlots).toBe(5);
  });

  it('fails closed when pool checkout completes after the lifetime deadline (runRead)', async () => {
    const pool = new RecordingPool(60);
    const transaction = new PgTransaction(pool);
    const subject = '00000000-0000-0000-0000-000000000001';
    const callback = vi.fn(async () => 'ok');

    const runPromise = transaction.runRead(subject, callback, 15);

    await expect(runPromise).rejects.toBeInstanceOf(
      DeliveryDeadlineExceededError,
    );

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(callback).not.toHaveBeenCalled();
    expect(pool.client.queries).toHaveLength(0);
    expect(pool.client.released).toBe(true);
    expect(pool.client.releaseError).toBeInstanceOf(
      DeliveryDeadlineExceededError,
    );
    expect(pool.availableSlots).toBe(5);
  });

  it('does not issue a query after rejection when the runRead callback finishes after the lifetime deadline', async () => {
    const pool = new RecordingPool(0);
    const transaction = new PgTransaction(pool);
    const subject = '00000000-0000-0000-0000-000000000001';
    const callback = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return 'ok';
    });

    const runPromise = transaction.runRead(subject, callback, 15);

    await expect(runPromise).rejects.toBeInstanceOf(
      DeliveryDeadlineExceededError,
    );

    const queriesAtRejection = pool.client.queries.slice();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(callback).toHaveBeenCalled();
    expect(pool.client.queries).toEqual(queriesAtRejection);
  });
});
