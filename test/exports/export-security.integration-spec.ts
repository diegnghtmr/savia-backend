// Migrations under test: 202608310003_export_jobs.sql, 202608310004_export_storage.sql
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
describe('storage export object tenant isolation', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let tx: PgTransaction;
  const a = id(5401);
  const b = id(5402);
  const wa = id(5451);
  const wb = id(5452);
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    tx = new PgTransaction(pool, { callbackTimeoutMs: 3000 });
    await admin.query(
      `insert into auth.users (id,email) values ($1,$2),($3,$4)`,
      [a, 'export-a@example.test', b, 'export-b@example.test'],
    );
    await admin.query(
      `insert into public.profiles (id,email,display_name,locale,country_code,timezone,date_format,week_starts_on,number_format,default_currency) values ($1,$2,'A','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD'),($3,$4,'B','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD')`,
      [a, 'export-a@example.test', b, 'export-b@example.test'],
    );
    await admin.query(
      `insert into public.workspaces (id,name,kind,base_currency) values ($1,'A','shared','USD'),($2,'B','shared','USD')`,
      [wa, wb],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id,profile_id,role,status) values ($1,$3,'owner','active'),($2,$4,'owner','active')`,
      [wa, wb, a, b],
    );
    await admin.query(
      `insert into storage.objects (bucket_id,name,metadata) values ('exports',$1,'{}')`,
      [`${wa}/ledger.csv`],
    );
  });
  afterAll(async () => {
    await admin.query(`delete from public.workspaces where id in ($1,$2)`, [
      wa,
      wb,
    ]);
    await admin.query(`delete from auth.users where id in ($1,$2)`, [a, b]);
    await admin.end();
    await pool.end();
  });
  it('hides workspace A object from workspace B member under real storage.objects RLS', async () => {
    const names = await tx.runRead(
      b,
      async (client) =>
        (
          await client.query<{ name: string }>(
            `select name from storage.objects where bucket_id='exports' and name=$1`,
            [`${wa}/ledger.csv`],
          )
        ).rows,
    );
    expect(names).toEqual([]);
  });
});
