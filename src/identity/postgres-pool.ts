import { Pool, type PoolClient, type QueryResult } from 'pg';

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
    this.pool ??= new Pool({
      connectionString: config.connectionString,
      max: config.poolMax,
      connectionTimeoutMillis: config.checkoutTimeoutMs,
    });
    return this.pool;
  }
  public async connect(): Promise<PgClient> {
    if (this.endPromise) throw new Error('PostgreSQL pool has ended.');
    return this.getPool().connect() as Promise<PoolClient>;
  }
  public end(): Promise<void> {
    this.endPromise ??= this.pool?.end() ?? Promise.resolve();
    return this.endPromise;
  }
}
