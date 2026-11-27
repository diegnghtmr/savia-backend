import { Logger } from '@nestjs/common';
import { Pool, type QueryResult } from 'pg';

import { PostgresConfig } from './postgres-config.js';

export interface PgClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  release(error?: Error): void;
}

export interface PgPool {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

export class PostgresPool implements PgPool {
  private readonly logger = new Logger(PostgresPool.name);
  private pool: Pool | undefined;
  private endPromise: Promise<void> | undefined;
  private resolvedConfig: PostgresConfig | undefined;

  // Accepting a thunk is what lets the module graph be constructed without a
  // reachable database: nothing reads DATABASE_URL until the first checkout.
  // The resolved value is memoised so configuration cannot drift mid-process.
  public constructor(
    private readonly config: PostgresConfig | (() => PostgresConfig),
  ) {}
  public get checkoutTimeoutMs(): number {
    return this.getConfig().checkoutTimeoutMs;
  }
  private getConfig(): PostgresConfig {
    return (this.resolvedConfig ??=
      typeof this.config === 'function' ? this.config() : this.config);
  }
  private getPool(): Pool {
    const config = this.getConfig();
    return (this.pool ??= new Pool({
      connectionString: config.connectionString,
      max: config.poolMax,
      connectionTimeoutMillis: config.checkoutTimeoutMs,
    }).on('error', () => {
      // pg already evicted the client. A late FATAL can land here after a
      // deadline releases the checkout; never log its attached client/error.
      this.logger.warn('PostgreSQL released connection failed; discarded.');
    }));
  }
  public async connect(): Promise<PgClient> {
    if (this.endPromise) throw new Error('PostgreSQL pool has ended.');
    const client = await this.getPool().connect();
    const returnToPool = client.release.bind(client);
    let released = false;
    let releaseError: Error | undefined;

    const release = (error?: Error) => {
      if (released) return;
      released = true;
      releaseError = error;
      client.removeListener('error', discard);
      returnToPool(error);
    };
    const discard = (error: Error) => {
      if (released) return;
      release(error);
      this.logger.warn('PostgreSQL checked-out connection failed; discarded.');
    };

    // pg removes its idle error listener at checkout. A FATAL can arrive
    // while the transaction callback is waiting and there is no SQL promise.
    client.on('error', discard);
    return {
      query: async <Row extends Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ) => {
        if (released) {
          throw (
            releaseError ?? new Error('PostgreSQL client already released.')
          );
        }
        try {
          return await client.query<Row>(text, values && [...values]);
        } catch (error) {
          if (
            error instanceof Error &&
            'severity' in error &&
            error.severity === 'FATAL'
          ) {
            discard(error);
          }
          throw error;
        }
      },
      release,
    };
  }
  public end(): Promise<void> {
    this.endPromise ??= this.pool?.end() ?? Promise.resolve();
    return this.endPromise;
  }
}
