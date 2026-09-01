// Migrations under test: 202608310005_import_jobs.sql
import multipart from '@fastify/multipart';
import ExcelJS from 'exceljs';
import { Pool } from 'pg';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');
process.env.JWT_ISSUER = 'https://issuer.example.test';
process.env.JWT_AUDIENCE = 'savia-api';
process.env.JWT_JWKS_URI = 'https://issuer.example.test/jwks';
process.env.JWT_ALGORITHMS = 'RS256';
const subject = '00000000-0000-0000-0000-000000005501';
const otherSubject = '00000000-0000-0000-0000-000000005502';
const workspace = '00000000-0000-4000-8000-000000005501';
const otherWorkspace = '00000000-0000-4000-8000-000000005502';
const jobId = '00000000-0000-4000-8000-000000005503';
const boundary = 'savia-import-boundary';
const csv =
  'date,amount,description\n2026-01-01,100,Coffee\n2026-01-02,200,Salary\n';

function multipartBody(
  fileName: string,
  content: Buffer,
  hint?: string,
): Buffer {
  const parts = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    content,
    Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="formatHint"\r\n\r\n${hint ?? ''}\r\n--${boundary}--\r\n`,
    ),
  ];
  return Buffer.concat(parts);
}
function upload(
  app: NestFastifyApplication,
  content: Buffer,
  fileName: string,
  key: string,
  hint?: string,
) {
  return app.inject({
    method: 'POST',
    url: '/v1/import-jobs',
    headers: {
      authorization: 'Bearer accepted-token',
      'x-workspace-id': workspace,
      'idempotency-key': key,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: multipartBody(fileName, content, hint),
  });
}

describe('import analysis over the real HTTP and PostgreSQL boundaries', () => {
  let admin: Pool;
  let app: NestFastifyApplication;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(
      `insert into auth.users (id,email) values ($1,$2),($3,$4)`,
      [subject, 'import-a@example.test', otherSubject, 'import-b@example.test'],
    );
    await admin.query(
      `insert into public.profiles (id,email,display_name,locale,country_code,timezone,date_format,week_starts_on,number_format,default_currency) values ($1,$2,'A','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD'),($3,$4,'B','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD')`,
      [subject, 'import-a@example.test', otherSubject, 'import-b@example.test'],
    );
    await admin.query(
      `insert into public.workspaces (id,name,kind,base_currency) values ($1,'Import A','shared','USD'),($2,'Import B','shared','USD')`,
      [workspace, otherWorkspace],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id,profile_id,role,status) values ($1,$3,'owner','active'),($2,$4,'owner','active')`,
      [workspace, otherWorkspace, subject, otherSubject],
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: (token: string) =>
          token === 'accepted-token'
            ? Promise.resolve({ subject })
            : Promise.reject(new Error('rejected')),
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(app);
    await app.init();
    await app
      .getHttpAdapter()
      .getInstance()
      .register(multipart, {
        limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 1, parts: 2 },
        throwFileSizeLimit: false,
      });
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app?.close();
    await admin.query(`delete from public.workspaces where id in ($1,$2)`, [
      workspace,
      otherWorkspace,
    ]);
    await admin.query(`delete from auth.users where id in ($1,$2)`, [
      subject,
      otherSubject,
    ]);
    await admin.end();
  });

  it('analyzes CSV through HTTP and asserts the RULING 99 identity', async () => {
    const response = await upload(
      app,
      Buffer.from(csv),
      'statement.csv',
      '00000000-0000-4000-8000-000000005511',
      'csv',
    );
    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.payload);
    expect(body).toMatchObject({
      status: 'awaiting_mapping',
      detectedFormat: 'csv',
      totalRows: 2,
      validRows: 2,
      duplicateRows: 0,
      errorRows: 0,
    });
    expect(body.totalRows).toBe(
      body.validRows + body.duplicateRows + body.errorRows,
    );
  });
  it('analyzes a real XLSX workbook built with exceljs', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('statement');
    sheet.addRow(['date', 'amount', 'description']);
    sheet.addRow(['2026-01-01', 100, 'Coffee']);
    const response = await upload(
      app,
      Buffer.from(await workbook.xlsx.writeBuffer()),
      'statement.xlsx',
      '00000000-0000-4000-8000-000000005512',
      'xlsx',
    );
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.payload)).toMatchObject({
      detectedFormat: 'xlsx',
      totalRows: 1,
      validRows: 1,
    });
  });
  it.each(['qif', 'ofx', 'qfx'] as const)(
    'rejects unsupported %s with actionable detail',
    async (format) => {
      const response = await upload(
        app,
        Buffer.from('unsupported'),
        `statement.${format}`,
        `00000000-0000-4000-8000-00000000552${format.length}`,
        format,
      );
      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.payload).detail).toContain(
        'not yet supported',
      );
    },
  );
  it('rejects a file over the multipart boundary before buffering it fully', async () => {
    const response = await upload(
      app,
      Buffer.alloc(5 * 1024 * 1024 + 1),
      'large.csv',
      '00000000-0000-4000-8000-000000005513',
      'csv',
    );
    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.payload).detail).toContain('maximum size');
    const count = await admin.query(
      'select count(*)::int as count from public.import_jobs where workspace_id=$1',
      [workspace],
    );
    expect(count.rows[0].count).toBe(2);
  });
  it('rejects an upload over the row bound', async () => {
    const content = Buffer.from(
      `date,amount,description\n${Array.from({ length: 10_001 }, (_, i) => `2026-01-01,${i},row-${i}`).join('\n')}\n`,
    );
    const response = await upload(
      app,
      content,
      'too-many.csv',
      '00000000-0000-4000-8000-000000005514',
      'csv',
    );
    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.payload).detail).toContain('10000');
  });
  it('counts malformed rows without failing the job', async () => {
    const response = await upload(
      app,
      Buffer.from(
        'date,amount,description\nnot-a-date,nope,\n2026-01-02,5,Valid\n',
      ),
      'malformed.csv',
      '00000000-0000-4000-8000-000000005515',
      'csv',
    );
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.payload)).toMatchObject({
      totalRows: 2,
      validRows: 1,
      duplicateRows: 0,
      errorRows: 1,
    });
  });
  it('counts normalized within-file duplicates', async () => {
    const response = await upload(
      app,
      Buffer.from(
        'date,amount,description\n2026-01-03,9,Coffee Shop\n2026-01-03,9,  coffee   shop  \n',
      ),
      'duplicates.csv',
      '00000000-0000-4000-8000-000000005516',
      'csv',
    );
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.payload)).toMatchObject({
      totalRows: 2,
      validRows: 1,
      duplicateRows: 1,
      errorRows: 0,
    });
  });
  it('returns 404 for a real foreign-workspace import row', async () => {
    await admin.query(
      `insert into public.import_jobs (id,workspace_id,file_name,status,created_by) values ($1,$2,'foreign.csv','awaiting_mapping',$3)`,
      [jobId, otherWorkspace, otherSubject],
    );
    const response = await app.inject({
      method: 'GET',
      url: `/v1/import-jobs/${jobId}`,
      headers: {
        authorization: 'Bearer accepted-token',
        'x-workspace-id': workspace,
      },
    });
    expect(response.statusCode).toBe(404);
  });
  it('replays idempotently with exactly one job and one row set', async () => {
    const key = '00000000-0000-4000-8000-000000005517';
    const first = await upload(
      app,
      Buffer.from('date,amount,description\n2026-01-04,10,Replay\n'),
      'replay.csv',
      key,
      'csv',
    );
    const second = await upload(
      app,
      Buffer.from('date,amount,description\n2026-01-04,10,Replay\n'),
      'replay.csv',
      key,
      'csv',
    );
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    const jobs = await admin.query(
      `select count(*)::int as count from public.import_jobs where workspace_id=$1 and file_name='replay.csv'`,
      [workspace],
    );
    const rows = await admin.query(
      `select count(*)::int as count from public.import_job_rows where workspace_id=$1 and import_job_id=(select id from public.import_jobs where workspace_id=$1 and file_name='replay.csv')`,
      [workspace],
    );
    expect(jobs.rows[0].count).toBe(1);
    expect(rows.rows[0].count).toBe(1);
  });
  it('rejects a malformed RULING 76 error object at the database boundary', async () => {
    await expect(
      admin.query(
        `insert into public.import_jobs (workspace_id,file_name,status,error,created_by) values ($1,'bad.csv','failed','{"status": "nope"}'::jsonb,$2)`,
        [workspace, subject],
      ),
    ).rejects.toThrow();
  });
});
