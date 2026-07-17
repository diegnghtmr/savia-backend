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

  public constructor(private readonly config: () => PostgresConfig) {}
  private getPool(): Pool {
    this.pool ??= new Pool({
      connectionString: this.config().connectionString,
      max: this.config().poolMax,
      connectionTimeoutMillis: this.config().checkoutTimeoutMs,
    });
    return this.pool;
  }
  public async connect(): Promise<PgClient> {
    return this.getPool().connect() as Promise<PoolClient>;
  }
  public async end(): Promise<void> {
    await this.pool?.end();
  }
}
