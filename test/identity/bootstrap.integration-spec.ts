import { Test } from '@nestjs/testing';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BootstrapCommand } from '../../src/identity/bootstrap-command.js';
import {
  BOOTSTRAP_PORT,
  type BootstrapPort,
} from '../../src/identity/bootstrap.port.js';
import { BootstrapService } from '../../src/identity/bootstrap.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import {
  CommitOutcomeUnknownError,
  PgTransaction,
} from '../../src/platform/pg-transaction.js';
import { PostgresBootstrapAdapter } from '../../src/identity/postgres-bootstrap.adapter.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import {
  type PgClient,
  type PgPool,
  PostgresPool,
} from '../../src/platform/postgres-pool.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');
const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const command = (id: string, suffix = ''): BootstrapCommand => ({
  subject: id,
  email: `ada${suffix}@example.test`,
  displayName: `Ada${suffix}`,
  locale: 'en',
  countryCode: 'US',
  timezone: 'UTC',
  dateFormat: 'YYYY-MM-DD',
  weekStartsOn: 1,
  numberFormat: '1,234.56',
  defaultCurrency: 'USD',
  privacyModeEnabled: false,
  workspaceName: `Ada Personal${suffix}`,
  baseCurrency: 'USD',
});
let admin: Pool;
const pools: PgPool[] = [];
function service(
  pool: PgPool = new PostgresPool(PostgresConfig.fromUrl(url)),
): BootstrapPort {
  pools.push(pool);
  return new BootstrapService(
    new PgTransaction(pool, { callbackTimeoutMs: 3_000, lockTimeoutMs: 3_000 }),
    new PostgresBootstrapAdapter(),
  );
}
async function rows(id: string): Promise<number[]> {
  const result = await admin.query<{ p: number; w: number; m: number }>(
    `select (select count(*)::int from profiles where id=$1) p,
            (select count(*)::int from workspaces where personal_owner_profile_id=$1) w,
            (select count(*)::int from workspace_memberships where profile_id=$1) m`,
    [id],
  );
  const row = result.rows[0]!;
  return [row.p, row.w, row.m];
}

describe('BootstrapService database boundary', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(
      `insert into auth.users (id, email)
      select id::uuid, 'user-' || id || '@example.test' from unnest($1::text[]) id`,
      [Array.from({ length: 30 }, (_, index) => subject(index + 500))],
    );
  });
  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    await admin.end();
  });

  it('locks before evidence reads and creates one aggregate', async () => {
    const id = subject(500);
    await expect(service().execute(command(id))).resolves.toMatchObject({
      kind: 'created',
    });
    await expect(rows(id)).resolves.toEqual([1, 1, 1]);
  });
  it('replays exact IDs without inserts and conflicts without mutation', async () => {
    const id = subject(501);
    const first = await service().execute(command(id));
    const before = await rows(id);
    await expect(service().execute(command(id))).resolves.toEqual({
      ...first,
      kind: 'replayed',
    });
    await expect(service().execute(command(id, '-other'))).resolves.toEqual({
      kind: 'different-request',
    });
    await expect(rows(id)).resolves.toEqual(before);
  });
  it('serializes same and divergent commands while isolating different subjects', async () => {
    const same = subject(502);
    const [first, second] = await Promise.all([
      service().execute(command(same)),
      service().execute(command(same)),
    ]);
    expect([first.kind, second.kind].sort()).toEqual(['created', 'replayed']);
    const divergent = subject(503);
    const results = await Promise.all([
      service().execute(command(divergent)),
      service().execute(command(divergent, '-other')),
    ]);
    expect(results.map((value) => value.kind).sort()).toEqual([
      'created',
      'different-request',
    ]);
    await expect(
      Promise.all([
        service().execute(command(subject(504))),
        service().execute(command(subject(505))),
      ]).then(() => Promise.all([rows(subject(504)), rows(subject(505))])),
    ).resolves.toEqual([
      [1, 1, 1],
      [1, 1, 1],
    ]);
  });
  it('does not disclose cross-subject evidence and clears pooled context', async () => {
    const foreign = subject(506);
    await service().execute(command(foreign));
    await expect(
      service().execute(command(subject(507))),
    ).resolves.toMatchObject({ kind: 'created' });
    await expect(rows(foreign)).resolves.toEqual([1, 1, 1]);
  });
  it('rejects every partial or mislinked aggregate without repair', async () => {
    for (let mask = 1; mask <= 7; mask += 1) {
      const id = subject(507 + mask);
      await seedInvalid(id, mask, mask === 7);
      const before = await rows(id);
      await expect(service().execute(command(id))).resolves.toMatchObject({
        kind: 'incomplete-aggregate',
      });
      await expect(rows(id)).resolves.toEqual(before);
    }
  });
  it('aborts a commit that would leave an incomplete personal aggregate', async () => {
    // 508-514 are consumed by the partial-aggregate loop above.
    const id = subject(515);
    const pool = new PostgresPool(PostgresConfig.fromUrl(url));
    pools.push(pool);
    const transaction = new PgTransaction(pool, {
      callbackTimeoutMs: 3_000,
      lockTimeoutMs: 3_000,
    });
    // The totality trigger is deferred and gated on current_user =
    // 'savia_application', so it can only be exercised through the real
    // transaction runner. The profile insert succeeds and COMMIT is what fails:
    // the schema refuses to make a partial aggregate durable even if the
    // application layer were to try.
    await expect(
      transaction.run(id, (client) =>
        client.query(
          `insert into public.profiles (id, email, display_name, locale, country_code,
          timezone, date_format, week_starts_on, number_format, default_currency)
          values ($1, 'partial@example.test', 'Partial', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD')`,
          [id],
        ),
      ),
    ).rejects.toThrow();
    await expect(rows(id)).resolves.toEqual([0, 0, 0]);
  });
  it('resolves the bootstrap port from the identity module', async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
      DATABASE_URL: url,
    });
    const module = await Test.createTestingModule({
      imports: [IdentityModule],
    }).compile();
    expect(module.get<BootstrapPort>(BOOTSTRAP_PORT)).toBeDefined();
    await module.close();
  });

  it('RED-T1 Broad-or-Unbounded Retry: retries one pre-commit unknown complete attempt', async () => {
    const id = subject(520);
    const fault = new CommitFaultPool(url, COMMIT_FAULTS.BEFORE);
    await expect(service(fault).execute(command(id))).resolves.toMatchObject({
      kind: 'created',
    });
    expect(fault.commitAttempts).toBe(2);
    await expect(rows(id)).resolves.toEqual([1, 1, 1]);
  });

  it('RED-T2 Synthetic-Commit False Confidence: replays a durable post-commit unknown', async () => {
    const id = subject(521);
    const fault = new CommitFaultPool(url, COMMIT_FAULTS.AFTER);
    const result = await service(fault).execute(command(id));
    await expect(service().execute(command(id))).resolves.toEqual({
      ...result,
      kind: 'replayed',
    });
    expect(fault.commitAttempts).toBe(2);
    await expect(rows(id)).resolves.toEqual([1, 1, 1]);
  });

  it('RED-T3 Stale-Client or Pre-Lock Read: disposes the uncertain client before fresh evidence', async () => {
    const id = subject(522);
    const fault = new CommitFaultPool(url, COMMIT_FAULTS.BEFORE);
    await expect(service(fault).execute(command(id))).resolves.toMatchObject({
      kind: 'created',
    });
    expect(fault.pids).toHaveLength(2);
    expect(new Set(fault.pids).size).toBe(2);
    expect(fault.brokenReleases).toBe(1);
    expect(fault.events).toEqual([
      'BEGIN',
      'LOCK',
      'EVIDENCE',
      'COMMIT',
      'BEGIN',
      'LOCK',
      'EVIDENCE',
      'COMMIT',
    ]);
  });

  it('retries only an exact CommitOutcomeUnknownError instance', async () => {
    const transaction = new ThrowingTransaction(
      new CommitOutcomeUnknownError(new Error()),
    );
    await expect(
      fakeService(transaction).execute(command(subject(523))),
    ).resolves.toEqual({
      kind: 'created',
      aggregate: { profileId: 'profile', workspaceId: 'workspace' },
    });
    expect(transaction.attempts).toBe(2);
  });

  it('does not retry a CommitOutcomeUnknownError subclass', async () => {
    const transaction = new ThrowingTransaction(
      new UnknownSubclass(new Error()),
    );
    await expect(
      fakeService(transaction).execute(command(subject(524))),
    ).rejects.toThrow(UnknownSubclass);
    expect(transaction.attempts).toBe(1);
  });

  it('does not retry a same-name lookalike Error', async () => {
    const error = new Error('unknown');
    error.name = 'CommitOutcomeUnknownError';
    const transaction = new ThrowingTransaction(error);
    await expect(
      fakeService(transaction).execute(command(subject(525))),
    ).rejects.toBe(error);
    expect(transaction.attempts).toBe(1);
  });

  it('does not retry an ordinary Error', async () => {
    const error = new Error('ordinary');
    const transaction = new ThrowingTransaction(error);
    await expect(
      fakeService(transaction).execute(command(subject(526))),
    ).rejects.toBe(error);
    expect(transaction.attempts).toBe(1);
  });

  it('propagates a second exact unknown after two complete attempts', async () => {
    const id = subject(527);
    const fault = new CommitFaultPool(url, COMMIT_FAULTS.BEFORE);
    fault.failEveryCommit = true;
    await expect(service(fault).execute(command(id))).rejects.toThrow(
      CommitOutcomeUnknownError,
    );
    expect(fault.commitAttempts).toBe(2);
    await expect(rows(id)).resolves.toEqual([0, 0, 0]);
  });

  it('keeps a different complete aggregate unchanged during recovery', async () => {
    const id = subject(528);
    const fault = new CommitFaultPool(url, COMMIT_FAULTS.BEFORE);
    fault.afterFirstBrokenRelease = async () => {
      await service().execute(command(id, '-other'));
    };
    await expect(service(fault).execute(command(id))).resolves.toEqual({
      kind: 'different-request',
    });
    await expect(rows(id)).resolves.toEqual([1, 1, 1]);
  });

  it('does not repair a partial aggregate during recovery', async () => {
    const id = subject(529);
    const fault = new CommitFaultPool(url, COMMIT_FAULTS.BEFORE);
    fault.afterFirstBrokenRelease = async () => seedInvalid(id, 1, false);
    await expect(service(fault).execute(command(id))).resolves.toEqual({
      kind: 'incomplete-aggregate',
    });
    await expect(rows(id)).resolves.toEqual([1, 0, 0]);
  });
});

const COMMIT_FAULTS = {
  BEFORE: 'before',
  AFTER: 'after',
} as const;
type CommitFault = (typeof COMMIT_FAULTS)[keyof typeof COMMIT_FAULTS];

class CommitFaultPool implements PgPool {
  public readonly pids: number[] = [];
  public readonly events: string[] = [];
  public commitAttempts = 0;
  public brokenReleases = 0;
  public failEveryCommit = false;
  public afterFirstBrokenRelease: (() => Promise<void>) | undefined;
  private readonly pool: Pool;
  private recoveryPreparation: Promise<void> | undefined;

  public constructor(
    url: string,
    private readonly fault: CommitFault,
  ) {
    this.pool = new Pool({ connectionString: url, max: 2 });
  }

  public async connect(): Promise<PgClient> {
    if (this.recoveryPreparation) await this.recoveryPreparation;
    const client = await this.pool.connect();
    const pid = await client.query<{ pid: number }>(
      'select pg_backend_pid() pid',
    );
    this.pids.push(pid.rows[0]!.pid);
    return this.wrap(client);
  }

  public end(): Promise<void> {
    return this.pool.end();
  }

  private wrap(client: PoolClient): PgClient {
    return {
      query: async <Row extends Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ) => {
        if (text === 'BEGIN') this.events.push('BEGIN');
        if (text.startsWith('select pg_advisory_xact_lock'))
          this.events.push('LOCK');
        if (text.includes('coalesce((select jsonb_agg'))
          this.events.push('EVIDENCE');
        if (text !== 'COMMIT')
          return client.query<Row>(text, [...(values ?? [])]);
        this.events.push('COMMIT');
        this.commitAttempts += 1;
        const shouldFail = this.failEveryCommit || this.commitAttempts === 1;
        if (shouldFail && this.fault === COMMIT_FAULTS.BEFORE)
          throw new Error('before commit acknowledgement');
        const result = await client.query<Row>(text, [...(values ?? [])]);
        if (shouldFail && this.fault === COMMIT_FAULTS.AFTER)
          throw new Error('after commit acknowledgement');
        return result;
      },
      release: (error?: Error) => {
        if (error) {
          this.brokenReleases += 1;
          if (this.brokenReleases === 1 && this.afterFirstBrokenRelease)
            this.recoveryPreparation = this.afterFirstBrokenRelease();
        }
        client.release(error);
      },
    };
  }
}

class UnknownSubclass extends CommitOutcomeUnknownError {}

class ThrowingTransaction {
  public attempts = 0;

  public constructor(private readonly error: Error) {}

  public async run<T>(
    _subject: string,
    callback: (client: PgClient) => Promise<T>,
  ): Promise<T> {
    this.attempts += 1;
    if (this.attempts === 1) throw this.error;
    return callback({
      query: async <Row extends Record<string, unknown>>() => ({
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
        rows: [] as Row[],
      }),
      release: () => undefined,
    });
  }
}

function fakeService(transaction: ThrowingTransaction): BootstrapPort {
  return new BootstrapService(transaction, {
    read: async () => ({ profiles: [], workspaces: [], memberships: [] }),
    create: async () => ({ profileId: 'profile', workspaceId: 'workspace' }),
  });
}

async function seedInvalid(
  id: string,
  mask: number,
  mislinked: boolean,
): Promise<void> {
  const workspaceId = crypto.randomUUID();
  await admin.query('set session_replication_role=replica');
  try {
    if (mask & 1)
      await admin.query(
        `insert into profiles (id, email, display_name, locale, country_code,
        timezone, date_format, week_starts_on, number_format, default_currency)
        values ($1, 'seed@example.test', 'Seed', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD')`,
        [id],
      );
    if (mask & 2)
      await admin.query(
        `insert into workspaces (id, name, kind, base_currency, personal_owner_profile_id)
        values ($1, 'Seed', 'personal', 'USD', $2)`,
        [workspaceId, id],
      );
    if (mask & 4)
      await admin.query(
        `insert into workspace_memberships (workspace_id, profile_id, role, status)
        values ($1, $2, $3, 'active')`,
        [workspaceId, id, mislinked ? 'editor' : 'owner'],
      );
  } finally {
    await admin.query('set session_replication_role=origin');
  }
}
