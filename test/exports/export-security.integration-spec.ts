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
  const wa = '00000000-0000-4000-8000-000000005451';
  const wb = '00000000-0000-4000-8000-000000005452';
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

  it('allows the owning workspace and rejects malformed tenant paths', async () => {
    const own = await tx.runRead(a, async (client) =>
      (await client.query(`select name from storage.objects where bucket_id='exports' and name=$1`, [`${wa}/ledger.csv`])).rows,
    );
    expect(own).toHaveLength(1);
    for (const name of [`/${wa}/ledger.csv`, `${wa}`, `x/${wa}/ledger.csv`, `${wa.replace('0', 'О')}/ledger.csv`]) {
      const rows = await tx.runRead(a, async (client) =>
        (await client.query(`select name from storage.objects where bucket_id='exports' and name=$1`, [name])).rows,
      );
      expect(rows).toEqual([]);
    }
    const uppercase = await tx.runRead(a, async (client) =>
      (await client.query(`select name from storage.objects where bucket_id='exports' and name=$1`, [`${wa.toUpperCase()}/ledger.csv`])).rows,
    );
    expect(uppercase).toHaveLength(1);
  });

  it('has no application mutation policy or grant on storage.objects', async () => {
    const policies = await admin.query<{ cmd: string }>(
      `select cmd from pg_policies where schemaname='storage' and tablename='objects' and roles @> array['savia_application']::name[]`,
    );
    expect(policies.rows.map((row) => row.cmd)).not.toContain('INSERT');
    expect(policies.rows.map((row) => row.cmd)).not.toContain('UPDATE');
    expect(policies.rows.map((row) => row.cmd)).not.toContain('DELETE');
    const grants = await admin.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants where grantee='savia_application' and table_schema='storage' and table_name='objects'`,
    );
    expect(grants.rows.map((row) => row.privilege_type)).not.toEqual(expect.arrayContaining(['INSERT', 'UPDATE', 'DELETE']));
  });

  it('enforces reservation and result fields by terminal status', async () => {
    await expect(admin.query(
      `insert into public.export_jobs (workspace_id,format,resource,status,object_path,download_url,expires_at,created_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [wa, 'csv', 'accounts', 'queued', `${wa}/queued.csv`, 'https://bad.test', new Date(), a],
    )).rejects.toThrow();
    await expect(admin.query(
      `insert into public.export_jobs (workspace_id,format,resource,status,object_path,created_by,completed_at) values ($1,'csv','accounts','completed',$2,$3,now())`,
      [wa, `${wa}/complete.csv`, a],
    )).rejects.toThrow();
  });
});
