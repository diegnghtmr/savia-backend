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
  });

  it('loads custom valid values from environment', () => {
    const config = WorkerConfig.fromEnvironment({
      SAVIA_WORKER_BATCH_SIZE: '5',
      SAVIA_WORKER_VT_SECONDS: '600',
      SAVIA_WORKER_POLL_INTERVAL_MS: '2000',
      SAVIA_WORKER_DRAIN_TIMEOUT_SECONDS: '45',
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
});
