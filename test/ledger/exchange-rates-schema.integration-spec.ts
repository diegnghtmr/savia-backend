// Migrations under test: 202608280001_exchange_rates.sql
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

type CapturedPgError = { code?: string; message?: string };

async function capturePgError(
  run: () => Promise<unknown>,
): Promise<CapturedPgError> {
  try {
    await run();
  } catch (error: unknown) {
    return error as CapturedPgError;
  }
  throw new Error('Expected the statement to fail, but it succeeded.');
}

describe('Workspace exchange rates schema, append-only history, RLS, and grants (202608280001_exchange_rates.sql)', () => {
  let admin: Pool;

  const ownerA = subject(1001);
  const adminC = subject(1002);
  const editorD = subject(1003);
  const viewerE = subject(1004);
  const outsiderZ = subject(1005);
  const ownerB = subject(1006);

  const ws1Id = '00000000-0000-0000-0000-000000001051';
  const ws2Id = '00000000-0000-0000-0000-000000001052';

  const memOwnerAId = '00000000-0000-0000-0000-000000001061';
  const memAdminCId = '00000000-0000-0000-0000-000000001062';
  const memEditorDId = '00000000-0000-0000-0000-000000001063';
  const memViewerEId = '00000000-0000-0000-0000-000000001064';
  const memWs2OwnerBId = '00000000-0000-0000-0000-000000001065';

  async function asSubject<T>(
    subjectId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_application');
      await client.query("select set_config('app.subject_id', $1, true)", [
        subjectId,
      ]);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  type ExchangeRateSeed = {
    id?: string;
    workspaceId: string;
    baseCurrency?: string;
    quoteCurrency?: string;
    rate?: string | number;
    effectiveAt?: string;
    source?: string;
    manual?: boolean;
    createdBy: string;
  };

  async function seedExchangeRate(rate: ExchangeRateSeed): Promise<string> {
    const res = await admin.query<{ id: string }>(
      `insert into public.exchange_rates
         (id, workspace_id, base_currency, quote_currency, rate, effective_at, source, manual, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        rate.id ?? randomUUID(),
        rate.workspaceId,
        rate.baseCurrency ?? 'USD',
        rate.quoteCurrency ?? 'EUR',
        rate.rate ?? '0.9200',
        rate.effectiveAt ?? '2026-08-28T12:00:00Z',
        rate.source ?? 'ecb',
        rate.manual ?? false,
        rate.createdBy,
      ],
    );
    return res.rows[0].id;
  }

  async function deleteExchangeRates(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await admin.query(
      'delete from public.exchange_rates where id = any($1::uuid[])',
      [ids],
    );
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });

    await admin.query(
      `insert into auth.users (id, email) values
       ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12)`,
      [
        ownerA,
        'rate-owner-a@example.test',
        adminC,
        'rate-admin-c@example.test',
        editorD,
        'rate-editor-d@example.test',
        viewerE,
        'rate-viewer-e@example.test',
        outsiderZ,
        'rate-outsider-z@example.test',
        ownerB,
        'rate-owner-b@example.test',
      ],
    );

    for (const [id, email, name] of [
      [ownerA, 'rate-owner-a@example.test', 'Rate Owner A'],
      [adminC, 'rate-admin-c@example.test', 'Rate Admin C'],
      [editorD, 'rate-editor-d@example.test', 'Rate Editor D'],
      [viewerE, 'rate-viewer-e@example.test', 'Rate Viewer E'],
      [outsiderZ, 'rate-outsider-z@example.test', 'Rate Outsider Z'],
      [ownerB, 'rate-owner-b@example.test', 'Rate Owner B'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Exchange Rates Shared Workspace 1', 'shared', 'USD', null, $2),
              ($3, 'Exchange Rates Shared Workspace 2', 'shared', 'USD', null, $4)`,
      [ws1Id, ownerA, ws2Id, ownerB],
    );

    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active'),
              ($4, $5, $6, 'administrator', 'active'),
              ($7, $8, $9, 'editor', 'active'),
              ($10, $11, $12, 'viewer', 'active'),
              ($13, $14, $15, 'owner', 'active')`,
      [
        memOwnerAId,
        ws1Id,
        ownerA,
        memAdminCId,
        ws1Id,
        adminC,
        memEditorDId,
        ws1Id,
        editorD,
        memViewerEId,
        ws1Id,
        viewerE,
        memWs2OwnerBId,
        ws2Id,
        ownerB,
      ],
    );
  });

  afterAll(async () => {
    if (admin) {
      await admin
        .query(
          'delete from public.exchange_rates where workspace_id = any($1::uuid[])',
          [[ws1Id, ws2Id]],
        )
        .catch(() => {});
      await admin
        .query('delete from public.workspaces where id = any($1::uuid[])', [
          [ws1Id, ws2Id],
        ])
        .catch(() => {});
      await admin
        .query('delete from public.profiles where id = any($1::uuid[])', [
          [ownerA, adminC, editorD, viewerE, outsiderZ, ownerB],
        ])
        .catch(() => {});
      await admin
        .query('delete from auth.users where id = any($1::uuid[])', [
          [ownerA, adminC, editorD, viewerE, outsiderZ, ownerB],
        ])
        .catch(() => {});
      await admin.end();
    }
  });

  describe('Structure, catalog metadata, and ACL', () => {
    it('The fitness:financial tag is present and apostrophe-free on public.exchange_rates', async () => {
      const res = await admin.query<{ description: string | null }>(
        `select obj_description('public.exchange_rates'::regclass) as description`,
      );

      const description = res.rows[0].description;
      expect(description).not.toBeNull();
      expect(description).toContain('fitness:financial');
      expect(description).not.toContain("'");
    });

    it('public.exchange_rates has relrowsecurity AND relforcerowsecurity both true', async () => {
      const rlsRes = await admin.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select relrowsecurity, relforcerowsecurity
           from pg_class
          where oid = 'public.exchange_rates'::regclass`,
      );
      expect(rlsRes.rows[0].relrowsecurity).toBe(true);
      expect(rlsRes.rows[0].relforcerowsecurity).toBe(true);
    });

    it('savia_application holds SELECT on every column, INSERT on exactly granted columns, and NO update or delete privilege', async () => {
      const result = await admin.query<{
        column_name: string;
        readable: boolean;
        insertable: boolean;
        updatable: boolean;
      }>(
        `select column_name,
                has_column_privilege('savia_application', 'public.exchange_rates', column_name, 'select') as readable,
                has_column_privilege('savia_application', 'public.exchange_rates', column_name, 'insert') as insertable,
                has_column_privilege('savia_application', 'public.exchange_rates', column_name, 'update') as updatable
           from information_schema.columns
          where table_schema = 'public' and table_name = 'exchange_rates'
          order by column_name`,
      );

      const readable = result.rows
        .filter((r) => r.readable)
        .map((r) => r.column_name);
      expect(readable).toEqual([
        'base_currency',
        'created_at',
        'created_by',
        'effective_at',
        'id',
        'manual',
        'notes',
        'quote_currency',
        'rate',
        'source',
        'workspace_id',
      ]);

      const insertable = result.rows
        .filter((r) => r.insertable)
        .map((r) => r.column_name);
      expect(insertable).toEqual([
        'base_currency',
        'created_by',
        'effective_at',
        'manual',
        'notes',
        'quote_currency',
        'rate',
        'source',
        'workspace_id',
      ]);

      const updatable = result.rows
        .filter((r) => r.updatable)
        .map((r) => r.column_name);
      expect(updatable).toEqual([]);

      const delResult = await admin.query<{ has_delete: boolean }>(
        `select has_table_privilege('savia_application', 'public.exchange_rates', 'delete') as has_delete`,
      );
      expect(delResult.rows[0].has_delete).toBe(false);

      const updateTableResult = await admin.query<{ has_update: boolean }>(
        `select has_table_privilege('savia_application', 'public.exchange_rates', 'update') as has_update`,
      );
      expect(updateTableResult.rows[0].has_update).toBe(false);
    });

    it('The complete column inventory is pinned', async () => {
      const inventoryRes = await admin.query<{ column_name: string }>(
        `select column_name
           from information_schema.columns
          where table_schema = 'public' and table_name = 'exchange_rates'
          order by column_name`,
      );
      expect(inventoryRes.rows.map((r) => r.column_name)).toEqual([
        'base_currency',
        'created_at',
        'created_by',
        'effective_at',
        'id',
        'manual',
        'notes',
        'quote_currency',
        'rate',
        'source',
        'workspace_id',
      ]);
    });

    it('Policies on public.exchange_rates are pinned: reads and inserts for savia_application, NO update or delete policy', async () => {
      const policiesRes = await admin.query<{
        polname: string;
        polcmd: string;
        grantee: string | null;
      }>(
        `select p.polname,
                p.polcmd::text as polcmd,
                min(pg_get_userbyid(role_oid)) as grantee
           from pg_policy p
           cross join lateral unnest(p.polroles::oid[]) as role_oids(role_oid)
          where p.polrelid = 'public.exchange_rates'::regclass
          group by p.polname, p.polcmd
          order by p.polname`,
      );

      expect(
        policiesRes.rows.map((r) => [r.polname, r.polcmd, r.grantee]),
      ).toEqual([
        [
          'application_inserts_workspace_exchange_rate',
          'a',
          'savia_application',
        ],
        ['application_reads_workspace_exchange_rate', 'r', 'savia_application'],
      ]);
      expect(policiesRes.rows.some((r) => r.polcmd === 'w')).toBe(false);
      expect(policiesRes.rows.some((r) => r.polcmd === 'd')).toBe(false);
    });

    it('exchange_rates table carries unique (workspace_id, base_currency, quote_currency, effective_at) constraint and lookup index', async () => {
      const uqRes = await admin.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conrelid = 'public.exchange_rates'::regclass
            and contype = 'u'
            and conname = 'exchange_rates_workspace_pair_effective_at_key'`,
      );
      expect(uqRes.rows).toHaveLength(1);

      const keysetRes = await admin.query<{ colnames: string[] }>(
        `select array_agg(a.attname::text order by k.ord) as colnames
           from pg_index i
           join pg_class idx on idx.oid = i.indexrelid
           join lateral unnest(i.indkey::smallint[]) with ordinality as k(attnum, ord) on true
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
          where idx.relname = 'exchange_rates_workspace_pair_latest_idx'
            and i.indisunique = false`,
      );
      expect(keysetRes.rows).toHaveLength(1);
      expect(keysetRes.rows[0].colnames).toEqual([
        'workspace_id',
        'base_currency',
        'quote_currency',
        'effective_at',
      ]);
    });
  });

  describe('Contract and Constraint Verification', () => {
    it('1. A valid rate row inserts successfully', async () => {
      let rateId: string | undefined;
      try {
        const insertRes = await asSubject(ownerA, (client) =>
          client.query<{ id: string }>(
            `insert into public.exchange_rates
               (workspace_id, base_currency, quote_currency, rate, effective_at, source, manual, created_by)
             values ($1, 'USD', 'EUR', '0.9200', '2026-08-28T12:00:00Z', 'ecb', false, $2)
             returning id`,
            [ws1Id, ownerA],
          ),
        );
        rateId = insertRes.rows[0]?.id;
        expect(rateId).toBeDefined();

        const checkRes = await asSubject(ownerA, (client) =>
          client.query<{
            id: string;
            base_currency: string;
            quote_currency: string;
            rate: string;
          }>(
            `select id, base_currency, quote_currency, rate::text
               from public.exchange_rates
              where id = $1`,
            [rateId],
          ),
        );
        expect(checkRes.rows).toHaveLength(1);
        expect(checkRes.rows[0].base_currency).toBe('USD');
        expect(checkRes.rows[0].quote_currency).toBe('EUR');
        // `rate numeric` declares no scale, so PostgreSQL PRESERVES the scale of the
        // literal that was inserted: '0.9200' is stored and returned as '0.9200',
        // not normalised to '0.92'. That is deliberate for a rate ledger -- the row
        // keeps the rate exactly as it was agreed and submitted -- but it means the
        // serialized form depends on what the caller wrote, so it is pinned here
        // rather than left to be rediscovered as a surprise.
        expect(checkRes.rows[0].rate).toBe('0.9200');
      } finally {
        if (rateId) await deleteExchangeRates([rateId]);
      }
    });

    it('2. The base=quote CHECK rejects a row where both currencies are equal', async () => {
      const sameCurrencyErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.exchange_rates
               (workspace_id, base_currency, quote_currency, rate, effective_at, source, manual, created_by)
             values ($1, 'USD', 'USD', '1.0000', '2026-08-28T12:00:00Z', 'manual', true, $2)`,
            [ws1Id, ownerA],
          ),
        ),
      );
      expect(sameCurrencyErr.code).toBe('23514');
      expect(sameCurrencyErr.message ?? '').toContain(
        'exchange_rates_distinct_currencies_check',
      );
    });

    it('3. The rate>0 CHECK rejects zero and rejects a negative rate', async () => {
      const zeroRateErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.exchange_rates
               (workspace_id, base_currency, quote_currency, rate, effective_at, source, manual, created_by)
             values ($1, 'USD', 'EUR', '0', '2026-08-28T12:00:00Z', 'manual', true, $2)`,
            [ws1Id, ownerA],
          ),
        ),
      );
      expect(zeroRateErr.code).toBe('23514');
      // Pin the NAMED constraint: without this the test would also pass if the row
      // tripped some unrelated check, proving nothing about the rate > 0 rule.
      expect(zeroRateErr.message ?? '').toContain(
        'exchange_rates_rate_positive_check',
      );

      const negativeRateErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.exchange_rates
               (workspace_id, base_currency, quote_currency, rate, effective_at, source, manual, created_by)
             values ($1, 'USD', 'EUR', '-1.2500', '2026-08-28T12:00:00Z', 'manual', true, $2)`,
            [ws1Id, ownerA],
          ),
        ),
      );
      expect(negativeRateErr.code).toBe('23514');
      expect(negativeRateErr.message ?? '').toContain(
        'exchange_rates_rate_positive_check',
      );
    });

    it('4. Malformed currency codes are refused: char(3) rejects an over-length code and the regex CHECK rejects a wrong alphabet or case', async () => {
      const tooShortErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.exchange_rates
               (workspace_id, base_currency, quote_currency, rate, effective_at, source, manual, created_by)
             values ($1, 'us', 'EUR', '0.9200', '2026-08-28T12:00:00Z', 'manual', true, $2)`,
            [ws1Id, ownerA],
          ),
        ),
      );
      expect(tooShortErr.code).toBe('23514');

      const tooLongErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.exchange_rates
               (workspace_id, base_currency, quote_currency, rate, effective_at, source, manual, created_by)
             values ($1, 'USDD', 'EUR', '0.9200', '2026-08-28T12:00:00Z', 'manual', true, $2)`,
            [ws1Id, ownerA],
          ),
        ),
      );
      // A 4-character code never reaches the regex CHECK: char(3) refuses to store an
      // over-length value first, so PostgreSQL raises 22001 string_data_right_truncation.
      // Asserting 23514 here would simply fail. Length is guarded by the TYPE; the CHECK
      // guards the alphabet and case, which the 'U5D' case below proves.
      expect(tooLongErr.code).toBe('22001');

      const lowercaseQuoteErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.exchange_rates
               (workspace_id, base_currency, quote_currency, rate, effective_at, source, manual, created_by)
             values ($1, 'USD', 'usd', '0.9200', '2026-08-28T12:00:00Z', 'manual', true, $2)`,
            [ws1Id, ownerA],
          ),
        ),
      );
      expect(lowercaseQuoteErr.code).toBe('23514');

      // A well-formed-length code that is still not three uppercase letters: this is
      // what actually exercises the regex CHECK rather than the column type.
      const nonAlphabeticErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.exchange_rates
               (workspace_id, base_currency, quote_currency, rate, effective_at, source, manual, created_by)
             values ($1, 'U5D', 'EUR', '0.9200', '2026-08-28T12:00:00Z', 'manual', true, $2)`,
            [ws1Id, ownerA],
          ),
        ),
      );
      expect(nonAlphabeticErr.code).toBe('23514');
    });

    it('4b. notes accepts exactly 500 characters and refuses 501', async () => {
      // The contract caps notes at 500. Prove BOTH edges: a test that only rejected
      // an over-long value would still pass if the column refused every note.
      const atLimit = 'n'.repeat(500);
      const overLimit = 'n'.repeat(501);

      const overErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.exchange_rates
               (workspace_id, base_currency, quote_currency, rate, effective_at, source, manual, notes, created_by)
             values ($1, 'USD', 'EUR', '0.9200', '2026-08-28T09:00:00Z', 'manual', true, $2, $3)`,
            [ws1Id, overLimit, ownerA],
          ),
        ),
      );
      expect(overErr.code).toBe('23514');
      expect(overErr.message ?? '').toContain(
        'exchange_rates_notes_length_check',
      );

      const acceptedRes = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.exchange_rates
             (workspace_id, base_currency, quote_currency, rate, effective_at, source, manual, notes, created_by)
           values ($1, 'USD', 'EUR', '0.9300', '2026-08-28T09:00:00Z', 'manual', true, $2, $3)
           returning id`,
          [ws1Id, atLimit, ownerA],
        ),
      );
      const acceptedId = acceptedRes.rows[0].id;
      expect(acceptedId).toBeDefined();
      await deleteExchangeRates([acceptedId]);
    });

    it('5. The UNIQUE constraint rejects a second row with the same (workspace, base, quote, effective_at), while a row differing ONLY in effective_at is ACCEPTED', async () => {
      const fixedTimestamp = '2026-08-28T10:00:00Z';
      const secondTimestamp = '2026-08-28T11:00:00Z';
      let firstId: string | undefined;
      let secondId: string | undefined;

      try {
        firstId = await seedExchangeRate({
          workspaceId: ws1Id,
          baseCurrency: 'USD',
          quoteCurrency: 'GBP',
          rate: '0.7800',
          effectiveAt: fixedTimestamp,
          createdBy: ownerA,
        });

        // Exact duplicate (workspace, base, quote, effective_at) must be rejected with 23505
        const duplicateErr = await capturePgError(() =>
          seedExchangeRate({
            workspaceId: ws1Id,
            baseCurrency: 'USD',
            quoteCurrency: 'GBP',
            rate: '0.7900',
            effectiveAt: fixedTimestamp,
            createdBy: ownerA,
          }),
        );
        expect(duplicateErr.code).toBe('23505');
        expect(duplicateErr.message ?? '').toContain(
          'exchange_rates_workspace_pair_effective_at_key',
        );

        // Row differing only in effective_at must succeed (append-only time series history)
        secondId = await seedExchangeRate({
          workspaceId: ws1Id,
          baseCurrency: 'USD',
          quoteCurrency: 'GBP',
          rate: '0.7900',
          effectiveAt: secondTimestamp,
          createdBy: ownerA,
        });
        expect(secondId).toBeDefined();

        const historyCountRes = await admin.query<{ count: string }>(
          `select count(*)::text as count
             from public.exchange_rates
            where workspace_id = $1
              and base_currency = 'USD'
              and quote_currency = 'GBP'`,
          [ws1Id],
        );
        expect(historyCountRes.rows[0].count).toBe('2');
      } finally {
        const toDelete = [firstId, secondId].filter((id): id is string =>
          Boolean(id),
        );
        await deleteExchangeRates(toDelete);
      }
    });

    it('6. APPEND-ONLY ENFORCEMENT: a member role that can INSERT cannot UPDATE and cannot DELETE an existing rate row', async () => {
      const rateId = await seedExchangeRate({
        workspaceId: ws1Id,
        baseCurrency: 'USD',
        quoteCurrency: 'JPY',
        rate: '155.50',
        createdBy: ownerA,
      });

      try {
        // As Owner (member who has insert privileges): UPDATE is refused with 42501
        const ownerUpdateErr = await capturePgError(() =>
          asSubject(ownerA, (client) =>
            client.query(
              `update public.exchange_rates
                  set rate = '156.00'
                where id = $1`,
              [rateId],
            ),
          ),
        );
        expect(ownerUpdateErr.code).toBe('42501');
        expect(ownerUpdateErr.message ?? '').toContain(
          'permission denied for table exchange_rates',
        );

        // As Owner: DELETE is refused with 42501
        const ownerDeleteErr = await capturePgError(() =>
          asSubject(ownerA, (client) =>
            client.query(`delete from public.exchange_rates where id = $1`, [
              rateId,
            ]),
          ),
        );
        expect(ownerDeleteErr.code).toBe('42501');
        expect(ownerDeleteErr.message ?? '').toContain(
          'permission denied for table exchange_rates',
        );

        // As Editor (member who has insert privileges): UPDATE is refused with 42501
        const editorUpdateErr = await capturePgError(() =>
          asSubject(editorD, (client) =>
            client.query(
              `update public.exchange_rates
                  set rate = '156.00'
                where id = $1`,
              [rateId],
            ),
          ),
        );
        expect(editorUpdateErr.code).toBe('42501');

        // As Editor: DELETE is refused with 42501
        const editorDeleteErr = await capturePgError(() =>
          asSubject(editorD, (client) =>
            client.query(`delete from public.exchange_rates where id = $1`, [
              rateId,
            ]),
          ),
        );
        expect(editorDeleteErr.code).toBe('42501');
      } finally {
        await deleteExchangeRates([rateId]);
      }
    });

    it('7. RLS: a member of workspace A cannot read or insert rates belonging to workspace B', async () => {
      const ws1RateId = await seedExchangeRate({
        workspaceId: ws1Id,
        baseCurrency: 'USD',
        quoteCurrency: 'CAD',
        rate: '1.3500',
        createdBy: ownerA,
      });

      const ws2RateId = await seedExchangeRate({
        workspaceId: ws2Id,
        baseCurrency: 'USD',
        quoteCurrency: 'CAD',
        rate: '1.3600',
        createdBy: ownerB,
      });

      try {
        // Owner A cannot read rates from Workspace 2
        const crossReadRes = await asSubject(ownerA, (client) =>
          client.query(
            `select id from public.exchange_rates where workspace_id = $1`,
            [ws2Id],
          ),
        );
        expect(crossReadRes.rows).toHaveLength(0);

        // Specific id lookup across workspace boundary returns empty
        const crossIdRes = await asSubject(ownerA, (client) =>
          client.query(`select id from public.exchange_rates where id = $1`, [
            ws2RateId,
          ]),
        );
        expect(crossIdRes.rows).toHaveLength(0);

        // Owner A cannot insert rate into Workspace 2 (RLS with check violation -> 42501)
        const crossInsertErr = await capturePgError(() =>
          asSubject(ownerA, (client) =>
            client.query(
              `insert into public.exchange_rates
                 (workspace_id, base_currency, quote_currency, rate, effective_at, source, manual, created_by)
               values ($1, 'USD', 'CHF', '0.8800', '2026-08-28T12:00:00Z', 'manual', true, $2)`,
              [ws2Id, ownerA],
            ),
          ),
        );
        expect(crossInsertErr.code).toBe('42501');
        expect(crossInsertErr.message ?? '').toContain(
          'row-level security policy',
        );

        // Outsider cannot read rates from Workspace 1
        const outsiderReadRes = await asSubject(outsiderZ, (client) =>
          client.query(
            `select id from public.exchange_rates where workspace_id = $1`,
            [ws1Id],
          ),
        );
        expect(outsiderReadRes.rows).toHaveLength(0);

        // Viewer can read in workspace 1
        const viewerReadRes = await asSubject(viewerE, (client) =>
          client.query(`select id from public.exchange_rates where id = $1`, [
            ws1RateId,
          ]),
        );
        expect(viewerReadRes.rows).toHaveLength(1);

        // Viewer CANNOT insert into workspace 1 (RLS insert policy requires owner/administrator/editor -> 42501)
        const viewerInsertErr = await capturePgError(() =>
          asSubject(viewerE, (client) =>
            client.query(
              `insert into public.exchange_rates
                 (workspace_id, base_currency, quote_currency, rate, effective_at, source, manual, created_by)
               values ($1, 'USD', 'CHF', '0.8800', '2026-08-28T12:00:00Z', 'manual', true, $2)`,
              [ws1Id, viewerE],
            ),
          ),
        );
        expect(viewerInsertErr.code).toBe('42501');
        expect(viewerInsertErr.message ?? '').toContain(
          'row-level security policy',
        );

        // Forged created_by (ownerA inserting with created_by = ownerB) is rejected with 42501
        const forgedCreatedByErr = await capturePgError(() =>
          asSubject(ownerA, (client) =>
            client.query(
              `insert into public.exchange_rates
                 (workspace_id, base_currency, quote_currency, rate, effective_at, source, manual, created_by)
               values ($1, 'USD', 'CHF', '0.8800', '2026-08-28T12:00:00Z', 'manual', true, $2)`,
              [ws1Id, ownerB],
            ),
          ),
        );
        expect(forgedCreatedByErr.code).toBe('42501');
        expect(forgedCreatedByErr.message ?? '').toContain(
          'row-level security policy',
        );
      } finally {
        await deleteExchangeRates([ws1RateId, ws2RateId]);
      }
    });

    it('8. The FK: inserting a rate for a non-existent workspace fails, and deleting a workspace cascades away its rates', async () => {
      const nonExistentWsId = randomUUID();

      // Inserting with invalid workspace_id violates FK with 23503
      const invalidWsErr = await capturePgError(() =>
        seedExchangeRate({
          workspaceId: nonExistentWsId,
          baseCurrency: 'USD',
          quoteCurrency: 'EUR',
          rate: '0.9200',
          createdBy: ownerA,
        }),
      );
      expect(invalidWsErr.code).toBe('23503');
      expect(invalidWsErr.message ?? '').toContain('foreign key constraint');

      // Create a temporary workspace to test on delete cascade
      const tempWsId = randomUUID();
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
         values ($1, 'Temp Cascade Workspace', 'shared', 'USD', null, $2)`,
        [tempWsId, ownerA],
      );

      try {
        const rateId = await seedExchangeRate({
          workspaceId: tempWsId,
          baseCurrency: 'USD',
          quoteCurrency: 'EUR',
          rate: '0.9200',
          createdBy: ownerA,
        });

        const verifyInserted = await admin.query<{ count: string }>(
          `select count(*)::text as count from public.exchange_rates where id = $1`,
          [rateId],
        );
        expect(verifyInserted.rows[0].count).toBe('1');

        // Delete the workspace -> must cascade delete the exchange rate
        await admin.query('delete from public.workspaces where id = $1', [
          tempWsId,
        ]);

        const verifyCascaded = await admin.query<{ count: string }>(
          `select count(*)::text as count from public.exchange_rates where id = $1`,
          [rateId],
        );
        expect(verifyCascaded.rows[0].count).toBe('0');
      } finally {
        await admin
          .query('delete from public.workspaces where id = $1', [tempWsId])
          .catch(() => {});
      }
    });
  });
});
