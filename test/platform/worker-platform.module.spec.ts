import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { WorkerConfig } from '../../src/platform/worker-config.js';
import { WorkerPlatformModule } from '../../src/platform/worker-platform.module.js';

describe('WorkerPlatformModule provider resolution', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('builds worker PgTransaction using the configured transition, compute, and persist timeouts', async () => {
    process.env.DATABASE_URL =
      'postgresql://postgres:postgres@127.0.0.1:5432/test';
    process.env.SAVIA_WORKER_TRANSITION_TIMEOUT_MS = '20000';
    process.env.SAVIA_WORKER_COMPUTE_TIMEOUT_MS = '150000';
    process.env.SAVIA_WORKER_PERSIST_TIMEOUT_MS = '45000';
    process.env.SAVIA_WORKER_VT_SECONDS = '400';

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerPlatformModule],
    }).compile();

    const config = moduleRef.get(WorkerConfig);
    const transaction = moduleRef.get(PgTransaction);

    expect(config.transitionTimeoutMs).toBe(20_000);
    expect(config.computeTimeoutMs).toBe(150_000);
    expect(config.persistTimeoutMs).toBe(45_000);

    const timeouts = transaction.timeouts;
    expect(timeouts.transitionTimeoutMs).toBe(20_000);
    expect(timeouts.computeTimeoutMs).toBe(150_000);
    expect(timeouts.persistTimeoutMs).toBe(45_000);
    expect(timeouts.callbackTimeoutMs).toBe(45_000);
    expect(timeouts.statementTimeoutMs).toBe(45_000);
  });
});
