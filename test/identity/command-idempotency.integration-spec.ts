import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { IDEMPOTENCY_OUTCOME_KINDS } from '../../src/identity/idempotency.port.js';
import { IdempotencyService } from '../../src/identity/idempotency.service.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresIdempotencyAdapter } from '../../src/identity/postgres-idempotency.adapter.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

/**
 * Verifies Idempotency-Key storage and replay semantics against a real PostgreSQL database,
 * exercising migrations: 202607150010_command_idempotency.sql and 202608240001_command_idempotency_workspace_scope.sql
 */
describe('Command Idempotency database boundary and concurrency', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  const adapter = new PostgresIdempotencyAdapter();
  let service: IdempotencyService;

  const subjectA = subject(901);
  const subjectB = subject(902);
  const subjectConcurrency = subject(903);
  const workspaceAId = '00000000-0000-0000-0000-000000000911';
  const workspaceBId = '00000000-0000-0000-0000-000000000912';

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    service = new IdempotencyService(transaction, adapter);

    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6)`,
      [
        subjectA,
        'idemp-a@example.test',
        subjectB,
        'idemp-b@example.test',
        subjectConcurrency,
        'idemp-concurrency@example.test',
      ],
    );

    for (const [id, email, name] of [
      [subjectA, 'idemp-a@example.test', 'Subject A'],
      [subjectB, 'idemp-b@example.test', 'Subject B'],
      [subjectConcurrency, 'idemp-concurrency@example.test', 'Subject C'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Workspace A', 'shared', 'USD', null, $3),
              ($2, 'Workspace B', 'shared', 'USD', null, $3)`,
      [workspaceAId, workspaceBId, subjectA],
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it('reserve, then replay returns the stored status/etag/body without re-executing', async () => {
    const key = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb01';
    const route = 'POST /v1/workspaces';
    const payload = { name: 'Acme Corp', baseCurrency: 'USD' };

    let executions = 0;
    const executeCommand = () =>
      service.execute(
        { subject: subjectA, route, idempotencyKey: key, payload },
        async () => {
          executions++;
          return {
            status: 201,
            etag: '"etag-v1"',
            body: { id: 'ws-1', name: 'Acme Corp' },
          };
        },
      );

    const firstOutcome = await executeCommand();
    expect(firstOutcome).toEqual({
      kind: IDEMPOTENCY_OUTCOME_KINDS.EXECUTED,
      response: {
        status: 201,
        etag: '"etag-v1"',
        body: { id: 'ws-1', name: 'Acme Corp' },
      },
    });
    expect(executions).toBe(1);

    const secondOutcome = await executeCommand();
    expect(secondOutcome).toEqual({
      kind: IDEMPOTENCY_OUTCOME_KINDS.REPLAYED,
      response: {
        status: 201,
        etag: '"etag-v1"',
        body: { id: 'ws-1', name: 'Acme Corp' },
      },
    });
    expect(executions).toBe(1);
  });

  it('differing fingerprint under the same key -> conflict', async () => {
    const key = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb02';
    const route = 'POST /v1/workspaces';

    let executions = 0;
    const initialOutcome = await service.execute(
      {
        subject: subjectA,
        route,
        idempotencyKey: key,
        payload: { name: 'First Name' },
      },
      async () => {
        executions++;
        return { status: 201, etag: null, body: { ok: true } };
      },
    );
    expect(initialOutcome.kind).toBe(IDEMPOTENCY_OUTCOME_KINDS.EXECUTED);
    expect(executions).toBe(1);

    const conflictOutcome = await service.execute(
      {
        subject: subjectA,
        route,
        idempotencyKey: key,
        payload: { name: 'Second Mutated Name' },
      },
      async () => {
        executions++;
        return { status: 201, etag: null, body: { ok: true } };
      },
    );

    expect(conflictOutcome.kind).toBe(IDEMPOTENCY_OUTCOME_KINDS.CONFLICT);
    expect(executions).toBe(1);
  });

  it('expiry reclaim: backdate created_at past 24h, then the same key is reusable', async () => {
    const key = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb03';
    const route = 'POST /v1/workspaces';

    let executions = 0;
    const firstOutcome = await service.execute(
      {
        subject: subjectA,
        route,
        idempotencyKey: key,
        payload: { name: 'Original' },
      },
      async () => {
        executions++;
        return {
          status: 201,
          etag: '"v1"',
          body: { version: 1 },
        };
      },
    );
    expect(firstOutcome.kind).toBe(IDEMPOTENCY_OUTCOME_KINDS.EXECUTED);
    expect(executions).toBe(1);

    // Backdate created_at past 24h window
    await admin.query(
      `update public.command_idempotency_records
          set created_at = now() - interval '25 hours'
        where subject_id = $1 and route = $2 and idempotency_key = $3`,
      [subjectA, route, key],
    );

    // Reclaim with new payload under same key
    const reclaimedOutcome = await service.execute(
      {
        subject: subjectA,
        route,
        idempotencyKey: key,
        payload: { name: 'Reclaimed After Expiry' },
      },
      async () => {
        executions++;
        return {
          status: 200,
          etag: '"v2"',
          body: { version: 2 },
        };
      },
    );

    expect(reclaimedOutcome).toEqual({
      kind: IDEMPOTENCY_OUTCOME_KINDS.EXECUTED,
      response: {
        status: 200,
        etag: '"v2"',
        body: { version: 2 },
      },
    });
    expect(executions).toBe(2);
  });

  it('route isolation: the same key on two different route templates does not collide', async () => {
    const key = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb04';
    const route1 = 'POST /v1/workspaces';
    const route2 = 'DELETE /v1/workspaces/{workspaceId}';

    let executionsRoute1 = 0;
    let executionsRoute2 = 0;

    const outcome1 = await service.execute(
      {
        subject: subjectA,
        route: route1,
        idempotencyKey: key,
        payload: { name: 'Workspace' },
      },
      async () => {
        executionsRoute1++;
        return { status: 201, etag: null, body: { created: true } };
      },
    );

    const outcome2 = await service.execute(
      {
        subject: subjectA,
        route: route2,
        idempotencyKey: key,
        payload: { workspaceId: '00000000-0000-0000-0000-000000000001' },
      },
      async () => {
        executionsRoute2++;
        return { status: 204, etag: null, body: null };
      },
    );

    expect(outcome1.kind).toBe(IDEMPOTENCY_OUTCOME_KINDS.EXECUTED);
    expect(outcome2.kind).toBe(IDEMPOTENCY_OUTCOME_KINDS.EXECUTED);
    expect(executionsRoute1).toBe(1);
    expect(executionsRoute2).toBe(1);
  });

  it("RLS: subject A cannot SELECT subject B's record; POSITIVE CONTROL in the same test: A can SELECT its own", async () => {
    const keyB = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb05';
    const route = 'POST /v1/workspaces';

    // Subject B executes a command
    await service.execute(
      {
        subject: subjectB,
        route,
        idempotencyKey: keyB,
        payload: { name: 'Subject B Resource' },
      },
      async () => ({ status: 201, etag: null, body: { owner: subjectB } }),
    );

    // Subject A selects subject B's record under RLS -> 0 rows
    const crossSubjectResult = await transaction.runRead(subjectA, (client) =>
      client.query<{ id: string }>(
        'select id from public.command_idempotency_records where subject_id = $1',
        [subjectB],
      ),
    );
    expect(crossSubjectResult.rows).toHaveLength(0);

    // POSITIVE CONTROL: Subject A selects its own records under RLS -> >= 1 rows
    const ownResult = await transaction.runRead(subjectA, (client) =>
      client.query<{ id: string }>(
        'select id from public.command_idempotency_records where subject_id = $1',
        [subjectA],
      ),
    );
    expect(ownResult.rows.length).toBeGreaterThanOrEqual(1);
  });

  // PgTransaction.run takes pg_advisory_xact_lock keyed on the SUBJECT. Two requests with the same key necessarily
  // share a subject, so this is exactly the case the lock serializes. The lock alone is NOT
  // sufficient — mutual exclusion without a durable record re-executes as soon as the lock
  // releases — so the unique constraint is the durable half and the lock is the concurrency
  // half, and each covers the other's blind spot.
  it('concurrency: two PgTransaction.run calls for the SAME subject and key produce exactly ONE execution and identical responses; POSITIVE CONTROL: two calls with DIFFERENT keys both execute', async () => {
    const concurrentKey = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb06';
    const route = 'POST /v1/workspaces';
    const payload = { name: 'Concurrent Workspace' };

    let sharedExecutions = 0;
    const runConcurrentCall = () =>
      service.execute(
        {
          subject: subjectConcurrency,
          route,
          idempotencyKey: concurrentKey,
          payload,
        },
        async () => {
          sharedExecutions++;
          return {
            status: 201,
            etag: '"v1"',
            body: { id: 'ws-concurrent', count: sharedExecutions },
          };
        },
      );

    const [result1, result2] = await Promise.all([
      runConcurrentCall(),
      runConcurrentCall(),
    ]);

    expect(sharedExecutions).toBe(1);
    expect(result1.kind).not.toBe(IDEMPOTENCY_OUTCOME_KINDS.CONFLICT);
    expect(result2.kind).not.toBe(IDEMPOTENCY_OUTCOME_KINDS.CONFLICT);
    if (
      result1.kind !== IDEMPOTENCY_OUTCOME_KINDS.CONFLICT &&
      result2.kind !== IDEMPOTENCY_OUTCOME_KINDS.CONFLICT
    ) {
      expect(result1.response).toEqual(result2.response);
      expect(result1.response).toEqual({
        status: 201,
        etag: '"v1"',
        body: { id: 'ws-concurrent', count: 1 },
      });
    }

    // POSITIVE CONTROL: two calls with DIFFERENT keys both execute
    let differentExecutions = 0;
    const diffKey1 = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb07';
    const diffKey2 = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb08';

    const [diffResult1, diffResult2] = await Promise.all([
      service.execute(
        {
          subject: subjectConcurrency,
          route,
          idempotencyKey: diffKey1,
          payload: { name: 'Diff 1' },
        },
        async () => {
          differentExecutions++;
          return { status: 201, etag: null, body: { id: 'diff-1' } };
        },
      ),
      service.execute(
        {
          subject: subjectConcurrency,
          route,
          idempotencyKey: diffKey2,
          payload: { name: 'Diff 2' },
        },
        async () => {
          differentExecutions++;
          return { status: 201, etag: null, body: { id: 'diff-2' } };
        },
      ),
    ]);

    expect(differentExecutions).toBe(2);
    expect(diffResult1.kind).toBe(IDEMPOTENCY_OUTCOME_KINDS.EXECUTED);
    expect(diffResult2.kind).toBe(IDEMPOTENCY_OUTCOME_KINDS.EXECUTED);
  });

  it('adapter write returns false against a live record without mutating it; POSITIVE CONTROL: write returns true and updates when expired', async () => {
    const key = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb09';
    const route = 'POST /v1/workspaces';
    const f1 =
      '1111111111111111111111111111111111111111111111111111111111111111';
    const f2 =
      '2222222222222222222222222222222222222222222222222222222222222222';

    // 1. Insert a live record for (subject, route, key) with fingerprint F1 (committed)
    const initialWriteResult = await transaction.run(subjectA, (client) =>
      adapter.write(client, subjectA, route, key, f1, 201, '"etag-1"', {
        v: 1,
      }),
    );
    expect(initialWriteResult).toBe(true);

    // 2. Call the adapter's write directly with the same (subject, route, key) but fingerprint F2
    const losingWriteResult = await transaction.run(subjectA, (client) =>
      adapter.write(client, subjectA, route, key, f2, 200, '"etag-2"', {
        v: 2,
      }),
    );

    // 3. Assert it returns false because the on conflict predicate excludes a live row
    expect(losingWriteResult).toBe(false);

    // 4. Assert the stored record still holds F1, proving the live record was not overwritten
    const currentRecord = await transaction.runRead(subjectA, (client) =>
      adapter.read(client, subjectA, route, key),
    );
    expect(currentRecord?.requestFingerprint).toBe(f1);
    expect(currentRecord?.responseStatus).toBe(201);

    // POSITIVE CONTROL: backdate created_at past 24 hours, call write again with F2
    await admin.query(
      `update public.command_idempotency_records
          set created_at = now() - interval '25 hours'
        where subject_id = $1 and route = $2 and idempotency_key = $3`,
      [subjectA, route, key],
    );

    const expiredWriteResult = await transaction.run(subjectA, (client) =>
      adapter.write(client, subjectA, route, key, f2, 200, '"etag-2"', {
        v: 2,
      }),
    );
    expect(expiredWriteResult).toBe(true);

    const updatedRecord = await transaction.runRead(subjectA, (client) =>
      adapter.read(client, subjectA, route, key),
    );
    expect(updatedRecord?.requestFingerprint).toBe(f2);
    expect(updatedRecord?.responseStatus).toBe(200);
  });

  it('T1: constraint level: inserting two rows with identical (subject_id, route, idempotency_key) and workspace_id = null raises 23505', async () => {
    const key = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb11';
    const route = 'POST /v1/workspaces';
    const f1 =
      '1111111111111111111111111111111111111111111111111111111111111111';

    await admin.query(
      `insert into public.command_idempotency_records
       (subject_id, route, idempotency_key, workspace_id, request_fingerprint, response_status, response_etag, response_body)
       values ($1, $2, $3, null, $4, 201, null, null)`,
      [subjectA, route, key, f1],
    );

    let capturedError: unknown;
    try {
      await admin.query(
        `insert into public.command_idempotency_records
         (subject_id, route, idempotency_key, workspace_id, request_fingerprint, response_status, response_etag, response_body)
         values ($1, $2, $3, null, $4, 201, null, null)`,
        [subjectA, route, key, f1],
      );
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toBeDefined();
    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as { code?: string }).code).toBe('23505');
  });

  it('T2: behavioural replay for workspace-less routes: returns executed then replayed, spy called once, exactly one row stored', async () => {
    const key = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb12';
    const route = 'POST /v1/workspaces';
    const payload = { name: 'Workspace Without Scope', baseCurrency: 'USD' };

    const operationSpy = vi.fn(async () => {
      return {
        status: 201,
        etag: '"ws-etag-1"',
        body: { id: 'ws-none', name: 'Workspace Without Scope' },
      };
    });

    const firstOutcome = await service.execute(
      {
        subject: subjectA,
        route,
        idempotencyKey: key,
        workspaceId: null,
        payload,
      },
      operationSpy,
    );

    expect(firstOutcome).toEqual({
      kind: IDEMPOTENCY_OUTCOME_KINDS.EXECUTED,
      response: {
        status: 201,
        etag: '"ws-etag-1"',
        body: { id: 'ws-none', name: 'Workspace Without Scope' },
      },
    });
    expect(operationSpy).toHaveBeenCalledTimes(1);

    const secondOutcome = await service.execute(
      {
        subject: subjectA,
        route,
        idempotencyKey: key,
        workspaceId: null,
        payload,
      },
      operationSpy,
    );

    expect(secondOutcome).toEqual({
      kind: IDEMPOTENCY_OUTCOME_KINDS.REPLAYED,
      response: {
        status: 201,
        etag: '"ws-etag-1"',
        body: { id: 'ws-none', name: 'Workspace Without Scope' },
      },
    });
    expect(operationSpy).toHaveBeenCalledTimes(1);

    const countResult = await admin.query<{ count: string }>(
      `select count(*)::text as count
         from public.command_idempotency_records
        where subject_id = $1 and route = $2 and idempotency_key = $3`,
      [subjectA, route, key],
    );
    expect(countResult.rows[0]?.count).toBe('1');
  });

  it('T3: same subject, same route, same idempotency key across workspace A and workspace B both execute and produce distinct resources', async () => {
    const key = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb13';
    const route = 'POST /v1/workspaces/{workspaceId}/accounts';
    const payloadA = { name: 'Account in WS A' };
    const payloadB = { name: 'Account in WS B' };

    let executionsA = 0;
    let executionsB = 0;

    const outcomeA = await service.execute(
      {
        subject: subjectA,
        route,
        idempotencyKey: key,
        workspaceId: workspaceAId,
        payload: payloadA,
      },
      async () => {
        executionsA++;
        return {
          status: 201,
          etag: '"acc-v1"',
          body: {
            id: 'acc-1',
            workspaceId: workspaceAId,
            name: 'Account in WS A',
          },
        };
      },
    );

    const outcomeB = await service.execute(
      {
        subject: subjectA,
        route,
        idempotencyKey: key,
        workspaceId: workspaceBId,
        payload: payloadB,
      },
      async () => {
        executionsB++;
        return {
          status: 201,
          etag: '"acc-v1"',
          body: {
            id: 'acc-2',
            workspaceId: workspaceBId,
            name: 'Account in WS B',
          },
        };
      },
    );

    expect(outcomeA).toEqual({
      kind: IDEMPOTENCY_OUTCOME_KINDS.EXECUTED,
      response: {
        status: 201,
        etag: '"acc-v1"',
        body: {
          id: 'acc-1',
          workspaceId: workspaceAId,
          name: 'Account in WS A',
        },
      },
    });
    expect(outcomeB).toEqual({
      kind: IDEMPOTENCY_OUTCOME_KINDS.EXECUTED,
      response: {
        status: 201,
        etag: '"acc-v1"',
        body: {
          id: 'acc-2',
          workspaceId: workspaceBId,
          name: 'Account in WS B',
        },
      },
    });
    expect(executionsA).toBe(1);
    expect(executionsB).toBe(1);
  });

  it('T4: on conflict arbiter inference: a 25-hour-old row with workspace_id = null is overwritten and write returns true', async () => {
    const key = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb14';
    const route = 'POST /v1/workspaces';
    const f1 =
      '1111111111111111111111111111111111111111111111111111111111111111';
    const f2 =
      '2222222222222222222222222222222222222222222222222222222222222222';

    const write1 = await transaction.run(subjectA, (client) =>
      adapter.write(
        client,
        subjectA,
        route,
        key,
        f1,
        201,
        '"v1"',
        { v: 1 },
        null,
      ),
    );
    expect(write1).toBe(true);

    await admin.query(
      `update public.command_idempotency_records
          set created_at = now() - interval '25 hours'
        where subject_id = $1 and route = $2 and idempotency_key = $3`,
      [subjectA, route, key],
    );

    const write2 = await transaction.run(subjectA, (client) =>
      adapter.write(
        client,
        subjectA,
        route,
        key,
        f2,
        200,
        '"v2"',
        { v: 2 },
        null,
      ),
    );
    expect(write2).toBe(true);

    const record = await transaction.runRead(subjectA, (client) =>
      adapter.read(client, subjectA, route, key, null),
    );
    expect(record?.requestFingerprint).toBe(f2);
    expect(record?.responseStatus).toBe(200);

    // The read-back above cannot tell "overwrote the aged row" from "inserted a
    // second row beside it": its created_at > now() - interval '24 hours'
    // predicate hides a 25h-old leftover either way. Only the raw count
    // discriminates the two worlds -- exactly one row must exist.
    const rowCountResult = await admin.query<{ count: string }>(
      `select count(*)::text as count from public.command_idempotency_records
        where subject_id = $1 and route = $2 and idempotency_key = $3 and workspace_id is null`,
      [subjectA, route, key],
    );
    expect(rowCountResult.rows[0]?.count).toBe('1');
  });

  // T3 proves cross-workspace slots do not COLLIDE using different payloads per
  // workspace; a workspace-blind READ regression then surfaces as a detected
  // CONFLICT. This test pins the harsher, fully silent path: with the SAME key
  // AND the SAME payload in both workspaces, a workspace-blind read finds
  // workspace A's live record, fingerprints match, and workspace B silently
  // receives workspace A's stored response without any error anywhere.
  it("T5: same subject, same route, same key AND same payload across workspace A and workspace B both execute and never return the other workspace's stored response", async () => {
    const key = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb15';
    const route = 'POST /v1/workspaces/{workspaceId}/accounts';
    const payload = { name: 'Same Payload Account' };

    let executionsA = 0;
    let executionsB = 0;

    const outcomeA = await service.execute(
      {
        subject: subjectA,
        route,
        idempotencyKey: key,
        workspaceId: workspaceAId,
        payload,
      },
      async () => {
        executionsA++;
        return {
          status: 201,
          etag: '"same-v1"',
          body: { id: 'acc-same-a', workspaceId: workspaceAId },
        };
      },
    );

    const outcomeB = await service.execute(
      {
        subject: subjectA,
        route,
        idempotencyKey: key,
        workspaceId: workspaceBId,
        payload,
      },
      async () => {
        executionsB++;
        return {
          status: 201,
          etag: '"same-v1"',
          body: { id: 'acc-same-b', workspaceId: workspaceBId },
        };
      },
    );

    expect(outcomeA).toEqual({
      kind: IDEMPOTENCY_OUTCOME_KINDS.EXECUTED,
      response: {
        status: 201,
        etag: '"same-v1"',
        body: { id: 'acc-same-a', workspaceId: workspaceAId },
      },
    });
    expect(outcomeB).toEqual({
      kind: IDEMPOTENCY_OUTCOME_KINDS.EXECUTED,
      response: {
        status: 201,
        etag: '"same-v1"',
        body: { id: 'acc-same-b', workspaceId: workspaceBId },
      },
    });
    expect(executionsA).toBe(1);
    expect(executionsB).toBe(1);
  });
});
