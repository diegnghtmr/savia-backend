import { describe, expect, it } from 'vitest';
import {
  WorkerConfig,
  WorkerConfigurationError,
} from '../../src/platform/worker-config.js';

describe('WorkerConfig', () => {
  it('loads defaults when env is empty', () => {
    const config = WorkerConfig.fromEnvironment({});
    expect(config.batchSize).toBe(1);
    expect(config.visibilityTimeoutSeconds).toBe(300);
    expect(config.pollIntervalMs).toBe(1_000);
    expect(config.drainTimeoutSeconds).toBe(30);
    expect(config.maxAttempts).toBe(5);
  });

  it('loads custom valid values from environment', () => {
    const config = WorkerConfig.fromEnvironment({
      SAVIA_WORKER_BATCH_SIZE: '5',
      SAVIA_WORKER_VT_SECONDS: '600',
      SAVIA_WORKER_POLL_INTERVAL_MS: '2000',
      SAVIA_WORKER_DRAIN_TIMEOUT_SECONDS: '45',
      DATABASE_POOL_MAX: '6',
    });
    expect(config.batchSize).toBe(5);
    expect(config.visibilityTimeoutSeconds).toBe(600);
    expect(config.pollIntervalMs).toBe(2000);
    expect(config.drainTimeoutSeconds).toBe(45);
  });

  it('throws on non-integer or out of bounds values', () => {
    expect(() =>
      WorkerConfig.fromEnvironment({ SAVIA_WORKER_BATCH_SIZE: '0' }),
    ).toThrow(WorkerConfigurationError);

    expect(() =>
      WorkerConfig.fromEnvironment({ SAVIA_WORKER_BATCH_SIZE: '-1' }),
    ).toThrow(WorkerConfigurationError);

    expect(() =>
      WorkerConfig.fromEnvironment({ SAVIA_WORKER_BATCH_SIZE: 'abc' }),
    ).toThrow(WorkerConfigurationError);

    expect(() =>
      WorkerConfig.fromEnvironment({
        SAVIA_WORKER_DRAIN_TIMEOUT_SECONDS: '999',
      }),
    ).toThrow(WorkerConfigurationError);
  });

  it('rejects batchSize greater than 10', () => {
    expect(() =>
      WorkerConfig.fromEnvironment({ SAVIA_WORKER_BATCH_SIZE: '11' }),
    ).toThrow(WorkerConfigurationError);
  });

  it('rejects pool size smaller than batchSize + 1', () => {
    expect(() =>
      WorkerConfig.fromEnvironment({
        SAVIA_WORKER_BATCH_SIZE: '4',
        DATABASE_POOL_MAX: '4',
      }),
    ).toThrow(WorkerConfigurationError);
  });

  it('rejects batch size 5 when DATABASE_POOL_MAX is omitted (default pool is 4)', () => {
    expect(() =>
      WorkerConfig.fromEnvironment({
        SAVIA_WORKER_BATCH_SIZE: '5',
      }),
    ).toThrow(WorkerConfigurationError);
  });

  it('accepts batch size 3 against the default pool size', () => {
    const config = WorkerConfig.fromEnvironment({
      SAVIA_WORKER_BATCH_SIZE: '3',
    });
    expect(config.batchSize).toBe(3);
  });

  it('loads custom maxAttempts from SAVIA_WORKER_MAX_ATTEMPTS', () => {
    const config = WorkerConfig.fromEnvironment({
      SAVIA_WORKER_MAX_ATTEMPTS: '8',
    });
    expect(config.maxAttempts).toBe(8);
  });

  it('rejects invalid maxAttempts', () => {
    expect(() =>
      WorkerConfig.fromEnvironment({ SAVIA_WORKER_MAX_ATTEMPTS: '0' }),
    ).toThrow(WorkerConfigurationError);

    expect(() =>
      WorkerConfig.fromEnvironment({ SAVIA_WORKER_MAX_ATTEMPTS: '-2' }),
    ).toThrow(WorkerConfigurationError);

    expect(() =>
      WorkerConfig.fromEnvironment({ SAVIA_WORKER_MAX_ATTEMPTS: 'xyz' }),
    ).toThrow(WorkerConfigurationError);
  });

  it('rejects visibility timeout <= summed phase deadlines', () => {
    // visibilityTimeoutSeconds = 300, summed phase deadlines = 300 -> throws
    expect(
      () =>
        new WorkerConfig(
          1,
          300,
          1_000,
          30,
          undefined,
          5_000,
          5,
          [100, 150, 50],
        ),
    ).toThrow(WorkerConfigurationError);

    // visibilityTimeoutSeconds = 300, summed phase deadlines = 350 -> throws
    expect(
      () =>
        new WorkerConfig(
          1,
          300,
          1_000,
          30,
          undefined,
          5_000,
          5,
          [100, 200, 50],
        ),
    ).toThrow(WorkerConfigurationError);

    // From environment with SAVIA_WORKER_PHASE_DEADLINES:
    expect(() =>
      WorkerConfig.fromEnvironment({
        SAVIA_WORKER_VT_SECONDS: '120',
        SAVIA_WORKER_PHASE_DEADLINES: '50,50,30',
      }),
    ).toThrow(WorkerConfigurationError);
  });

  it('accepts visibility timeout > summed phase deadlines', () => {
    const config = new WorkerConfig(
      1,
      300,
      1_000,
      30,
      undefined,
      5_000,
      5,
      [50, 100, 50],
    );
    expect(config.visibilityTimeoutSeconds).toBe(300);

    const envConfig = WorkerConfig.fromEnvironment({
      SAVIA_WORKER_VT_SECONDS: '300',
      SAVIA_WORKER_PHASE_DEADLINES: '50,100,50',
    });
    expect(envConfig.visibilityTimeoutSeconds).toBe(300);
  });
});
