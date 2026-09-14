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

  it('loads defaults with single source of truth deadlines and always-on VT validation passing', () => {
    const config = WorkerConfig.fromEnvironment({});
    expect(config.transitionTimeoutMs).toBe(15_000);
    expect(config.computeTimeoutMs).toBe(180_000);
    expect(config.persistTimeoutMs).toBe(60_000);
    expect(config.safetyMarginMs).toBe(30_000);
    expect(config.visibilityTimeoutSeconds).toBe(300);
    // 15 + 180 + 60 + 30 = 285s < 300s
    expect(
      config.transitionTimeoutMs +
        config.computeTimeoutMs +
        config.persistTimeoutMs +
        config.safetyMarginMs,
    ).toBeLessThan(config.visibilityTimeoutSeconds * 1_000);
  });

  it('rejects SAVIA_WORKER_TRANSITION_TIMEOUT_MS=60000 with the default visibility timeout (300s)', () => {
    expect(() =>
      WorkerConfig.fromEnvironment({
        SAVIA_WORKER_TRANSITION_TIMEOUT_MS: '60000',
      }),
    ).toThrow(WorkerConfigurationError);
  });

  it('accepts SAVIA_WORKER_TRANSITION_TIMEOUT_MS=60000 when visibility timeout is raised to accommodate it', () => {
    const config = WorkerConfig.fromEnvironment({
      SAVIA_WORKER_TRANSITION_TIMEOUT_MS: '60000',
      SAVIA_WORKER_VT_SECONDS: '350',
    });
    expect(config.transitionTimeoutMs).toBe(60_000);
    expect(config.visibilityTimeoutSeconds).toBe(350);
  });

  it('rejects SAVIA_WORKER_COMPUTE_TIMEOUT_MS=300000 with the default visibility timeout (300s)', () => {
    expect(() =>
      WorkerConfig.fromEnvironment({
        SAVIA_WORKER_COMPUTE_TIMEOUT_MS: '300000',
      }),
    ).toThrow(WorkerConfigurationError);
  });

  it('accepts SAVIA_WORKER_COMPUTE_TIMEOUT_MS=300000 when visibility timeout is raised to accommodate it', () => {
    const config = WorkerConfig.fromEnvironment({
      SAVIA_WORKER_COMPUTE_TIMEOUT_MS: '300000',
      SAVIA_WORKER_VT_SECONDS: '420',
    });
    expect(config.computeTimeoutMs).toBe(300_000);
    expect(config.visibilityTimeoutSeconds).toBe(420);
  });

  it('loads custom SAVIA_WORKER_PERSIST_TIMEOUT_MS and rejects out-of-bounds or non-integer values', () => {
    const validConfig = WorkerConfig.fromEnvironment({
      SAVIA_WORKER_PERSIST_TIMEOUT_MS: '70000',
      SAVIA_WORKER_VT_SECONDS: '350',
    });
    expect(validConfig.persistTimeoutMs).toBe(70_000);

    expect(() =>
      WorkerConfig.fromEnvironment({
        SAVIA_WORKER_COMPUTE_TIMEOUT_MS: '0',
      }),
    ).toThrow(WorkerConfigurationError);

    expect(() =>
      WorkerConfig.fromEnvironment({
        SAVIA_WORKER_COMPUTE_TIMEOUT_MS: '-5',
      }),
    ).toThrow(WorkerConfigurationError);

    expect(() =>
      WorkerConfig.fromEnvironment({
        SAVIA_WORKER_COMPUTE_TIMEOUT_MS: 'invalid',
      }),
    ).toThrow(WorkerConfigurationError);

    expect(() =>
      WorkerConfig.fromEnvironment({
        SAVIA_WORKER_PERSIST_TIMEOUT_MS: '0',
      }),
    ).toThrow(WorkerConfigurationError);

    expect(() =>
      WorkerConfig.fromEnvironment({
        SAVIA_WORKER_PERSIST_TIMEOUT_MS: '-5',
      }),
    ).toThrow(WorkerConfigurationError);

    expect(() =>
      WorkerConfig.fromEnvironment({
        SAVIA_WORKER_PERSIST_TIMEOUT_MS: 'invalid',
      }),
    ).toThrow(WorkerConfigurationError);
  });

  it('ensures the removed optional phaseDeadlinesSeconds path no longer exists', () => {
    const envConfig = WorkerConfig.fromEnvironment({
      SAVIA_WORKER_PHASE_DEADLINES: '50,100,50',
    } as unknown as Record<string, string>);
    expect(
      (envConfig as unknown as Record<string, unknown>).phaseDeadlinesSeconds,
    ).toBeUndefined();
    expect(WorkerConfig.fromEnvironment.length).toBeLessThanOrEqual(1);
  });
});
