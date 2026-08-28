// Migrations under test: 202608240007_transfers.sql, 202608240005_ledger_postings.sql
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

describe('Workspace transfers schema, composite posting binding, RLS, and grants (202608240007_transfers.sql)', () => {
  let admin: Pool;

  const ownerA = subject(901);
  const adminC = subject(902);
  const editorD = subject(903);
  const viewerE = subject(904);
  const outsiderZ = subject(905);
  const ownerB = subject(906);

  const ws1Id = '00000000-0000-0000-0000-000000000951';
  const ws2Id = '00000000-0000-0000-0000-000000000952';

  const memOwnerAId = '00000000-0000-0000-0000-000000000961';
  const memAdminCId = '00000000-0000-0000-0000-000000000962';
  const memEditorDId = '00000000-0000-0000-0000-000000000963';
  const memViewerEId = '00000000-0000-0000-0000-000000000964';
  const memWs2OwnerBId = '00000000-0000-0000-0000-000000000965';

  const account1Id = '00000000-0000-0000-0000-000000000971';
  const account2Id = '00000000-0000-0000-0000-000000000972';
  const ws2Account1Id = '00000000-0000-0000-0000-000000000973';
  const ws2Account2Id = '00000000-0000-0000-0000-000000000974';

  const transaction1Id = '00000000-0000-0000-0000-000000000981';

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

  type TransferSeed = {
    id?: string;
    workspaceId: string;
    sourceAccountId: string;
    destinationAccountId: string;
    sourceAmountMinor?: string;
    sourceCurrency?: string;
    destinationAmountMinor?: string;
    destinationCurrency?: string;
    feeAmountMinor?: string | null;
    feeCurrency?: string | null;
    exchangeRate?: string | null;
    referenceRate?: string | null;
    occurredAt?: string;
    status?: string;
    transactionId?: string | null;
    createdBy: string;
  };

  async function seedTransfer(transfer: TransferSeed): Promise<string> {
    const res = await admin.query<{ id: string }>(
      `insert into public.transfers
         (id, workspace_id, source_account_id, destination_account_id,
          source_amount_minor, source_currency,
          destination_amount_minor, destination_currency,
          fee_amount_minor, fee_currency,
          exchange_rate, reference_rate,
          occurred_at, status, transaction_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       returning id`,
      [
        transfer.id ?? randomUUID(),
        transfer.workspaceId,
        transfer.sourceAccountId,
        transfer.destinationAccountId,
        transfer.sourceAmountMinor ?? '1000',
        transfer.sourceCurrency ?? 'USD',
        transfer.destinationAmountMinor ?? '1000',
        transfer.destinationCurrency ?? 'USD',
        transfer.feeAmountMinor ?? null,
        transfer.feeCurrency ?? null,
        transfer.exchangeRate ?? null,
        transfer.referenceRate ?? null,
        transfer.occurredAt ?? '2026-08-24T12:00:00Z',
        transfer.status ?? 'confirmed',
        transfer.transactionId ?? null,
        transfer.createdBy,
      ],
    );
    return res.rows[0].id;
  }

  async function deleteTransfers(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await admin.query(
      'delete from public.transfers where id = any($1::uuid[])',
      [ids],
    );
  }

  async function deletePostings(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await admin.query(
      'delete from public.ledger_postings where id = any($1::uuid[])',
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
        'transfer-owner-a@example.test',
        adminC,
        'transfer-admin-c@example.test',
        editorD,
        'transfer-editor-d@example.test',
        viewerE,
        'transfer-viewer-e@example.test',
        outsiderZ,
        'transfer-outsider-z@example.test',
        ownerB,
        'transfer-owner-b@example.test',
      ],
    );

    for (const [id, email, name] of [
      [ownerA, 'transfer-owner-a@example.test', 'Transfer Owner A'],
      [adminC, 'transfer-admin-c@example.test', 'Transfer Admin C'],
      [editorD, 'transfer-editor-d@example.test', 'Transfer Editor D'],
      [viewerE, 'transfer-viewer-e@example.test', 'Transfer Viewer E'],
      [outsiderZ, 'transfer-outsider-z@example.test', 'Transfer Outsider Z'],
      [ownerB, 'transfer-owner-b@example.test', 'Transfer Owner B'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Transfers Shared Workspace 1', 'shared', 'USD', null, $2),
              ($3, 'Transfers Shared Workspace 2', 'shared', 'USD', null, $4)`,
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

    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, created_by)
       values ($1, $2, 'Transfers Test Account 1', 'checking', 'USD', $3),
              ($4, $5, 'Transfers Test Account 2', 'savings', 'USD', $6),
              ($7, $8, 'Transfers WS2 Account 1', 'checking', 'USD', $9),
              ($10, $11, 'Transfers WS2 Account 2', 'savings', 'USD', $12)`,
      [
        account1Id,
        ws1Id,
        ownerA,
        account2Id,
        ws1Id,
        ownerA,
        ws2Account1Id,
        ws2Id,
        ownerB,
        ws2Account2Id,
        ws2Id,
        ownerB,
      ],
    );

    await admin.query(
      `insert into public.transactions
         (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
       values ($1, $2, $3, 'income', 'confirmed', '5000', 'USD', '2026-08-24T12:00:00Z', $4)`,
      [transaction1Id, ws1Id, account1Id, ownerA],
    );
  });

  afterAll(async () => {
    if (admin) {
      await admin
        .query(
          'delete from public.ledger_postings where workspace_id = any($1::uuid[])',
          [[ws1Id, ws2Id]],
        )
        .catch(() => {});
      await admin
        .query(
          'delete from public.transfers where workspace_id = any($1::uuid[])',
          [[ws1Id, ws2Id]],
        )
        .catch(() => {});
      await admin
        .query(
          'delete from public.transactions where workspace_id = any($1::uuid[])',
          [[ws1Id, ws2Id]],
        )
        .catch(() => {});
      await admin
        .query(
          'delete from public.accounts where workspace_id = any($1::uuid[])',
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
    it('1. The fitness:financial tag is present and apostrophe-free on public.transfers', async () => {
      const res = await admin.query<{ description: string | null }>(
        `select obj_description('public.transfers'::regclass) as description`,
      );

      const description = res.rows[0].description;
      expect(description).not.toBeNull();
      expect(description).toContain('fitness:financial');
      expect(description).not.toContain("'");
    });

    it('2. public.transfers has relrowsecurity AND relforcerowsecurity both true', async () => {
      const rlsRes = await admin.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select relrowsecurity, relforcerowsecurity
           from pg_class
          where oid = 'public.transfers'::regclass`,
      );
      expect(rlsRes.rows[0].relrowsecurity).toBe(true);
      expect(rlsRes.rows[0].relforcerowsecurity).toBe(true);
    });

    it('3. savia_application holds SELECT on every column, INSERT on exactly granted columns, UPDATE on exactly (occurred_at, status, updated_at, version), and NO delete privilege', async () => {
      const result = await admin.query<{
        column_name: string;
        readable: boolean;
        insertable: boolean;
        updatable: boolean;
      }>(
        `select column_name,
                has_column_privilege('savia_application', 'public.transfers', column_name, 'select') as readable,
                has_column_privilege('savia_application', 'public.transfers', column_name, 'insert') as insertable,
                has_column_privilege('savia_application', 'public.transfers', column_name, 'update') as updatable
           from information_schema.columns
          where table_schema = 'public' and table_name = 'transfers'
          order by column_name`,
      );

      const readable = result.rows
        .filter((r) => r.readable)
        .map((r) => r.column_name);
      expect(readable).toEqual([
        'created_at',
        'created_by',
        'destination_account_id',
        'destination_amount_minor',
        'destination_currency',
        'exchange_rate',
        'fee_amount_minor',
        'fee_currency',
        'id',
        'occurred_at',
        'reference_rate',
        'source_account_id',
        'source_amount_minor',
        'source_currency',
        'status',
        'transaction_id',
        'updated_at',
        'version',
        'workspace_id',
      ]);

      const insertable = result.rows
        .filter((r) => r.insertable)
        .map((r) => r.column_name);
      expect(insertable).toEqual([
        'created_by',
        'destination_account_id',
        'destination_amount_minor',
        'destination_currency',
        'exchange_rate',
        'fee_amount_minor',
        'fee_currency',
        'occurred_at',
        'reference_rate',
        'source_account_id',
        'source_amount_minor',
        'source_currency',
        'status',
        'transaction_id',
        'workspace_id',
      ]);

      const updatable = result.rows
        .filter((r) => r.updatable)
        .map((r) => r.column_name);
      expect(updatable).toEqual([
        'occurred_at',
        'status',
        'updated_at',
        'version',
      ]);

      const delResult = await admin.query<{ has_delete: boolean }>(
        `select has_table_privilege('savia_application', 'public.transfers', 'delete') as has_delete`,
      );
      expect(delResult.rows[0].has_delete).toBe(false);
    });

    it('4. The complete column inventory is pinned', async () => {
      const inventoryRes = await admin.query<{ column_name: string }>(
        `select column_name
           from information_schema.columns
          where table_schema = 'public' and table_name = 'transfers'
          order by column_name`,
      );
      expect(inventoryRes.rows.map((r) => r.column_name)).toEqual([
        'created_at',
        'created_by',
        'destination_account_id',
        'destination_amount_minor',
        'destination_currency',
        'exchange_rate',
        'fee_amount_minor',
        'fee_currency',
        'id',
        'occurred_at',
        'reference_rate',
        'source_account_id',
        'source_amount_minor',
        'source_currency',
        'status',
        'transaction_id',
        'updated_at',
        'version',
        'workspace_id',
      ]);
    });

    it('5. Policies on public.transfers are pinned: reads, inserts, updates for savia_application, NO delete policy', async () => {
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
          where p.polrelid = 'public.transfers'::regclass
          group by p.polname, p.polcmd
          order by p.polname`,
      );

      expect(
        policiesRes.rows.map((r) => [r.polname, r.polcmd, r.grantee]),
      ).toEqual([
        ['application_inserts_workspace_transfer', 'a', 'savia_application'],
        ['application_reads_workspace_transfer', 'r', 'savia_application'],
        ['application_updates_workspace_transfer', 'w', 'savia_application'],
      ]);
      expect(policiesRes.rows.some((r) => r.polcmd === 'd')).toBe(false);
    });

    it('6. transfers table carries unique (workspace_id, id) constraint and keyset index', async () => {
      const uqRes = await admin.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conrelid = 'public.transfers'::regclass
            and contype = 'u'
            and conname = 'transfers_workspace_id_id_key'`,
      );
      expect(uqRes.rows).toHaveLength(1);

      const keysetRes = await admin.query<{ colnames: string[] }>(
        `select array_agg(a.attname::text order by k.ord) as colnames
           from pg_index i
           join pg_class idx on idx.oid = i.indexrelid
           join lateral unnest(i.indkey::smallint[]) with ordinality as k(attnum, ord) on true
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
          where idx.relname = 'transfers_workspace_occurred_keyset_idx'
            and i.indisunique = false`,
      );
      expect(keysetRes.rows).toHaveLength(1);
      expect(keysetRes.rows[0].colnames).toEqual([
        'workspace_id',
        'occurred_at',
        'id',
      ]);
    });
  });

  describe('Constraints on public.transfers', () => {
    it('7. from_account_id = to_account_id (source_account_id = destination_account_id) is refused with 23514 naming transfers_distinct_accounts_check', async () => {
      const selfTransferErr = await capturePgError(() =>
        seedTransfer({
          workspaceId: ws1Id,
          sourceAccountId: account1Id,
          destinationAccountId: account1Id,
          createdBy: ownerA,
        }),
      );
      expect(selfTransferErr.code).toBe('23514');
      expect(selfTransferErr.message ?? '').toContain('check constraint');
      expect(selfTransferErr.message ?? '').toContain(
        'transfers_distinct_accounts_check',
      );
    });

    it('8. Non-positive amounts (source_amount_minor <= 0 or destination_amount_minor <= 0) are refused with 23514', async () => {
      const zeroSourceErr = await capturePgError(() =>
        seedTransfer({
          workspaceId: ws1Id,
          sourceAccountId: account1Id,
          destinationAccountId: account2Id,
          sourceAmountMinor: '0',
          destinationAmountMinor: '1000',
          createdBy: ownerA,
        }),
      );
      expect(zeroSourceErr.code).toBe('23514');

      const negativeDestErr = await capturePgError(() =>
        seedTransfer({
          workspaceId: ws1Id,
          sourceAccountId: account1Id,
          destinationAccountId: account2Id,
          sourceAmountMinor: '1000',
          destinationAmountMinor: '-500',
          createdBy: ownerA,
        }),
      );
      expect(negativeDestErr.code).toBe('23514');
    });

    it('9. Fee parity check: fee_amount_minor set without fee_currency or vice-versa is refused with 23514', async () => {
      const feeAmountOnlyErr = await capturePgError(() =>
        seedTransfer({
          workspaceId: ws1Id,
          sourceAccountId: account1Id,
          destinationAccountId: account2Id,
          feeAmountMinor: '100',
          feeCurrency: null,
          createdBy: ownerA,
        }),
      );
      expect(feeAmountOnlyErr.code).toBe('23514');

      const feeCurrencyOnlyErr = await capturePgError(() =>
        seedTransfer({
          workspaceId: ws1Id,
          sourceAccountId: account1Id,
          destinationAccountId: account2Id,
          feeAmountMinor: null,
          feeCurrency: 'USD',
          createdBy: ownerA,
        }),
      );
      expect(feeCurrencyOnlyErr.code).toBe('23514');
    });

    it('10. Composite foreign key to accounts: referencing an account from another workspace is refused with 23503', async () => {
      const crossSourceErr = await capturePgError(() =>
        seedTransfer({
          workspaceId: ws1Id,
          sourceAccountId: ws2Account1Id,
          destinationAccountId: account2Id,
          createdBy: ownerA,
        }),
      );
      expect(crossSourceErr.code).toBe('23503');
      expect(crossSourceErr.message ?? '').toContain(
        'transfers_source_account_workspace_fkey',
      );

      const crossDestErr = await capturePgError(() =>
        seedTransfer({
          workspaceId: ws1Id,
          sourceAccountId: account1Id,
          destinationAccountId: ws2Account2Id,
          createdBy: ownerA,
        }),
      );
      expect(crossDestErr.code).toBe('23503');
      expect(crossDestErr.message ?? '').toContain(
        'transfers_destination_account_workspace_fkey',
      );
    });

    it('11. Positive control: valid transfer row inserts and commits', async () => {
      const transferId = randomUUID();
      try {
        const id = await seedTransfer({
          id: transferId,
          workspaceId: ws1Id,
          sourceAccountId: account1Id,
          destinationAccountId: account2Id,
          sourceAmountMinor: '2500',
          sourceCurrency: 'USD',
          destinationAmountMinor: '2500',
          destinationCurrency: 'USD',
          feeAmountMinor: '50',
          feeCurrency: 'USD',
          createdBy: ownerA,
        });
        expect(id).toBe(transferId);

        const check = await admin.query(
          'select 1 from public.transfers where id = $1',
          [transferId],
        );
        expect(check.rows).toHaveLength(1);
      } finally {
        await deleteTransfers([transferId]);
      }
    });
  });

  describe('RLS Behaviour on public.transfers', () => {
    let visibleTransferId: string;

    beforeAll(async () => {
      visibleTransferId = await seedTransfer({
        workspaceId: ws1Id,
        sourceAccountId: account1Id,
        destinationAccountId: account2Id,
        sourceAmountMinor: '3000',
        destinationAmountMinor: '3000',
        createdBy: ownerA,
      });
    });

    afterAll(async () => {
      if (visibleTransferId) {
        await deleteTransfers([visibleTransferId]);
      }
    });

    it('12. Positive control: an owner/administrator/editor can INSERT through the policy; a viewer can SELECT but CANNOT insert (refused with 42501 by policy)', async () => {
      let ownerTransferId: string | undefined;
      try {
        const ownerRes = await asSubject(ownerA, (client) =>
          client.query<{ id: string }>(
            `insert into public.transfers
               (workspace_id, source_account_id, destination_account_id,
                source_amount_minor, source_currency,
                destination_amount_minor, destination_currency,
                occurred_at, status, created_by)
             values ($1, $2, $3, '1000', 'USD', '1000', 'USD', $4, 'confirmed', $5)
             returning id`,
            [ws1Id, account1Id, account2Id, '2026-08-24T12:00:00Z', ownerA],
          ),
        );
        ownerTransferId = ownerRes.rows[0]?.id;
        expect(ownerTransferId).toBeDefined();

        const editorRes = await asSubject(editorD, (client) =>
          client.query<{ id: string }>(
            `insert into public.transfers
               (workspace_id, source_account_id, destination_account_id,
                source_amount_minor, source_currency,
                destination_amount_minor, destination_currency,
                occurred_at, status, created_by)
             values ($1, $2, $3, '1200', 'USD', '1200', 'USD', $4, 'confirmed', $5)
             returning id`,
            [ws1Id, account1Id, account2Id, '2026-08-24T12:00:00Z', editorD],
          ),
        );
        const editorTransferId = editorRes.rows[0]?.id;
        expect(editorTransferId).toBeDefined();
        if (editorTransferId) await deleteTransfers([editorTransferId]);

        // Viewer can select
        const viewerSelectRes = await asSubject(viewerE, (client) =>
          client.query('select id from public.transfers where id = $1', [
            visibleTransferId,
          ]),
        );
        expect(viewerSelectRes.rows).toHaveLength(1);

        // Viewer CANNOT insert
        const viewerInsertErr = await capturePgError(() =>
          asSubject(viewerE, (client) =>
            client.query(
              `insert into public.transfers
                 (workspace_id, source_account_id, destination_account_id,
                  source_amount_minor, source_currency,
                  destination_amount_minor, destination_currency,
                  occurred_at, status, created_by)
               values ($1, $2, $3, '1000', 'USD', '1000', 'USD', $4, 'draft', $5)`,
              [ws1Id, account1Id, account2Id, '2026-08-24T12:00:00Z', viewerE],
            ),
          ),
        );
        expect(viewerInsertErr.code).toBe('42501');
        expect(viewerInsertErr.message ?? '').toContain(
          'row-level security policy',
        );
      } finally {
        if (ownerTransferId) await deleteTransfers([ownerTransferId]);
      }
    });

    it('13. Inserting with created_by bound to a DIFFERENT profile is refused with 42501', async () => {
      const forgedErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.transfers
               (workspace_id, source_account_id, destination_account_id,
                source_amount_minor, source_currency,
                destination_amount_minor, destination_currency,
                occurred_at, status, created_by)
             values ($1, $2, $3, '1000', 'USD', '1000', 'USD', $4, 'draft', $5)`,
            [ws1Id, account1Id, account2Id, '2026-08-24T12:00:00Z', ownerB],
          ),
        ),
      );
      expect(forgedErr.code).toBe('42501');
      expect(forgedErr.message ?? '').toContain('row-level security policy');
    });

    it('14. Outsider cannot read transfers of another workspace', async () => {
      const outsiderRes = await asSubject(outsiderZ, (client) =>
        client.query(
          'select id from public.transfers where workspace_id = $1',
          [ws1Id],
        ),
      );
      expect(outsiderRes.rows).toHaveLength(0);
    });
  });

  describe('Composite foreign key binding ledger_postings to transfers (RULING 48)', () => {
    it('15. The composite binding: inserting a ledger_postings row whose transfer_id exists but belongs to a DIFFERENT workspace is REFUSED with 23503 naming ledger_postings_transfer_workspace_fkey', async () => {
      // Seed a valid transfer in workspace 2
      const ws2TransferId = await seedTransfer({
        workspaceId: ws2Id,
        sourceAccountId: ws2Account1Id,
        destinationAccountId: ws2Account2Id,
        createdBy: ownerB,
      });

      try {
        // Now try to insert a posting in workspace 1 referencing ws2's transfer_id.
        // A single-column foreign key on transfer_id would accept this because ws2TransferId exists.
        // The composite foreign key on (workspace_id, transfer_id) MUST REFUSE with 23503!
        const crossWsPostingErr = await capturePgError(() =>
          admin.query(
            `insert into public.ledger_postings
               (workspace_id, transaction_id, transfer_id, account_id, leg_kind,
                amount_minor, currency, status, occurred_at)
             values ($1, null, $2, $3, 'account', '500', 'USD', 'confirmed', '2026-08-24T12:00:00Z')`,
            [ws1Id, ws2TransferId, account1Id],
          ),
        );
        expect(crossWsPostingErr.code).toBe('23503');
        expect(crossWsPostingErr.message ?? '').toContain(
          'violates foreign key constraint',
        );
        expect(crossWsPostingErr.message ?? '').toContain(
          'ledger_postings_transfer_workspace_fkey',
        );

        // Verify the foreign key structure in the catalog
        const fkDefRes = await admin.query<{
          def: string;
          confdeltype: string;
        }>(
          `select pg_get_constraintdef(oid) as def, confdeltype
             from pg_constraint
            where conrelid = 'public.ledger_postings'::regclass
              and conname = 'ledger_postings_transfer_workspace_fkey'`,
        );
        expect(fkDefRes.rows).toHaveLength(1);
        expect(fkDefRes.rows[0].def).toMatch(
          /foreign key \(workspace_id, transfer_id\) references transfers\(workspace_id, id\) on delete restrict/i,
        );
        expect(fkDefRes.rows[0].confdeltype).toBe('r');
      } finally {
        await deleteTransfers([ws2TransferId]);
      }
    });

    it('16. A ledger_postings row with transfer_id NULL and a transaction_id set still inserts fine, proving the new FK did not break existing parentage (MATCH SIMPLE null tolerance)', async () => {
      const inserted = await admin.query<{ id: string }>(
        `insert into public.ledger_postings
           (workspace_id, transaction_id, transfer_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
         values ($1, $2, null, $3, 'account', '200', 'USD', 'confirmed', '2026-08-24T12:00:00Z'),
                ($1, $2, null, null, 'external', '-200', 'USD', 'confirmed', '2026-08-24T12:00:00Z')
         returning id`,
        [ws1Id, transaction1Id, account1Id],
      );
      const ids = inserted.rows.map((r) => r.id);
      expect(ids).toHaveLength(2);
      try {
        const stored = await admin.query<{ n: number; total: string }>(
          `select count(*)::int as n, sum(amount_minor)::text as total
             from public.ledger_postings where transaction_id = $1`,
          [transaction1Id],
        );
        expect(stored.rows[0].n).toBe(2);
        expect(stored.rows[0].total).toBe('0');
      } finally {
        await deletePostings(ids);
      }
    });

    it('17. Positive control: transfer-parented balanced pair with valid SAME-WORKSPACE transfer_id inserts, commits, and persists', async () => {
      const transferId = await seedTransfer({
        workspaceId: ws1Id,
        sourceAccountId: account1Id,
        destinationAccountId: account2Id,
        sourceAmountMinor: '450',
        destinationAmountMinor: '450',
        createdBy: ownerA,
      });

      try {
        const inserted = await admin.query<{ id: string }>(
          `insert into public.ledger_postings
             (workspace_id, transaction_id, transfer_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
           values ($1, null, $2, $3, 'account', '-450', 'USD', 'confirmed', '2026-08-24T12:00:00Z'),
                  ($1, null, $2, $4, 'account', '450', 'USD', 'confirmed', '2026-08-24T12:00:00Z')
           returning id`,
          [ws1Id, transferId, account1Id, account2Id],
        );
        const ids = inserted.rows.map((r) => r.id);
        expect(ids).toHaveLength(2);
        try {
          const stored = await admin.query<{ total: string }>(
            `select sum(amount_minor)::text as total
               from public.ledger_postings where transfer_id = $1`,
            [transferId],
          );
          expect(stored.rows[0].total).toBe('0');
        } finally {
          await deletePostings(ids);
        }
      } finally {
        await deleteTransfers([transferId]);
      }
    });

    it('18. The exactly-one-of parent check still holds after migration: both parents set is refused with 23514; neither set is refused with 23514 (ledger_postings_parent_exactly_one_check)', async () => {
      const transferId = await seedTransfer({
        workspaceId: ws1Id,
        sourceAccountId: account1Id,
        destinationAccountId: account2Id,
        createdBy: ownerA,
      });

      try {
        // Both parents set
        const bothErr = await capturePgError(() =>
          admin.query(
            `insert into public.ledger_postings
               (workspace_id, transaction_id, transfer_id, account_id, leg_kind,
                amount_minor, currency, status, occurred_at)
             values ($1, $2, $3, $4, 'account', '100', 'USD', 'confirmed', '2026-08-24T12:00:00Z')`,
            [ws1Id, transaction1Id, transferId, account1Id],
          ),
        );
        expect(bothErr.code).toBe('23514');
        expect(bothErr.message ?? '').toContain(
          'ledger_postings_parent_exactly_one_check',
        );

        // Neither parent set
        const neitherErr = await capturePgError(() =>
          admin.query(
            `insert into public.ledger_postings
               (workspace_id, transaction_id, transfer_id, account_id, leg_kind,
                amount_minor, currency, status, occurred_at)
             values ($1, null, null, null, 'external', '100', 'USD', 'confirmed', '2026-08-24T12:00:00Z')`,
            [ws1Id],
          ),
        );
        expect(neitherErr.code).toBe('23514');
        expect(neitherErr.message ?? '').toContain(
          'ledger_postings_parent_exactly_one_check',
        );
      } finally {
        await deleteTransfers([transferId]);
      }
    });

    it('19. Deleting a transfer referenced by a posting is REFUSED with 23503 (on delete restrict)', async () => {
      const transferId = await seedTransfer({
        workspaceId: ws1Id,
        sourceAccountId: account1Id,
        destinationAccountId: account2Id,
        createdBy: ownerA,
      });

      const inserted = await admin.query<{ id: string }>(
        `insert into public.ledger_postings
           (workspace_id, transaction_id, transfer_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
         values ($1, null, $2, $3, 'account', '-100', 'USD', 'confirmed', '2026-08-24T12:00:00Z'),
                ($1, null, $2, $4, 'account', '100', 'USD', 'confirmed', '2026-08-24T12:00:00Z')
         returning id`,
        [ws1Id, transferId, account1Id, account2Id],
      );
      const postingIds = inserted.rows.map((r) => r.id);

      try {
        const deleteErr = await capturePgError(() =>
          admin.query('delete from public.transfers where id = $1', [
            transferId,
          ]),
        );
        expect(deleteErr.code).toBe('23503');
        expect(deleteErr.message ?? '').toContain(
          'ledger_postings_transfer_workspace_fkey',
        );
      } finally {
        await deletePostings(postingIds);
        await deleteTransfers([transferId]);
      }
    });
  });
});
