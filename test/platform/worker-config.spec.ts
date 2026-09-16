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

  it('loads defaults with deadline model parameters and validation passing', () => {
    const config = WorkerConfig.fromEnvironment({});
    expect(config.transitionTimeoutMs).toBe(15_000);
    expect(config.computeTimeoutMs).toBe(180_000);
    expect(config.persistTimeoutMs).toBe(60_000);
    expect(config.leaseSafetyMs).toBe(20_000);
    expect(config.terminalReserveMs).toBe(10_000);
    expect(config.minOperationMs).toBe(1_000);
    expect(config.queueTimeoutMs).toBe(8_000);
    expect(config.storageUploadTimeoutMs).toBe(30_000);
    expect(config.pdfRenderTimeoutMs).toBe(30_000);
    expect(config.visibilityTimeoutSeconds).toBe(300);

    // Each cap < visibilityMs
    const visibilityMs = config.visibilityTimeoutSeconds * 1_000;
    expect(config.transitionTimeoutMs).toBeLessThan(visibilityMs);
    expect(config.computeTimeoutMs).toBeLessThan(visibilityMs);
    expect(config.persistTimeoutMs).toBeLessThan(visibilityMs);
    expect(config.queueTimeoutMs).toBeLessThan(visibilityMs);

    // leaseSafetyMs + terminalReserveMs + 3 * minOperationMs < visibilityMs
    expect(
      config.leaseSafetyMs +
        config.terminalReserveMs +
        3 * config.minOperationMs,
    ).toBeLessThan(visibilityMs);
  });

  it('rejects queueTimeoutMs greater than or equal to terminalReserveMs', () => {
    // queueTimeoutMs == terminalReserveMs
    expect(
      () =>
        new WorkerConfig(
          1,
          300,
          1000,
          30,
          undefined,
          5000,
          5,
          15_000,
          180_000,
          60_000,
          20_000,
          10_000,
          1_000,
          10_000,
        ),
    ).toThrow(WorkerConfigurationError);

    // queueTimeoutMs > terminalReserveMs
    expect(
      () =>
        new WorkerConfig(
          1,
          300,
          1000,
          30,
          undefined,
          5000,
          5,
          15_000,
          180_000,
          60_000,
          20_000,
          10_000,
          1_000,
          11_000,
        ),
    ).toThrow(WorkerConfigurationError);
  });

  it('rejects a phase cap >= visibility timeout', () => {
    // transitionTimeoutMs >= VT
    expect(
      () =>
        new WorkerConfig(
          1,
          300,
          1000,
          30,
          undefined,
          5000,
          5,
          300_000, // cap == VT
          180_000,
          60_000,
        ),
    ).toThrow(WorkerConfigurationError);

    // computeTimeoutMs >= VT
    expect(
      () =>
        new WorkerConfig(
          1,
          300,
          1000,
          30,
          undefined,
          5000,
          5,
          15_000,
          300_000, // cap == VT
          60_000,
        ),
    ).toThrow(WorkerConfigurationError);

    // persistTimeoutMs >= VT
    expect(
      () =>
        new WorkerConfig(
          1,
          300,
          1000,
          30,
          undefined,
          5000,
          5,
          15_000,
          180_000,
          300_000, // cap == VT
        ),
    ).toThrow(WorkerConfigurationError);

    // queueTimeoutMs >= VT
    expect(
      () =>
        new WorkerConfig(
          1,
          300,
          1000,
          30,
          undefined,
          5000,
          5,
          15_000,
          180_000,
          60_000,
          20_000,
          10_000,
          1_000,
          300_000, // queueTimeout == VT
        ),
    ).toThrow(WorkerConfigurationError);
  });

  it('rejects leaseSafetyMs + terminalReserveMs + 3 * minOperationMs >= visibility timeout', () => {
    // 280_000 + 18_000 + 3 * 1_000 = 301_000 >= 300_000
    expect(
      () =>
        new WorkerConfig(
          1,
          300,
          1000,
          30,
          undefined,
          5000,
          5,
          15_000,
          180_000,
          60_000,
          280_000,
          18_000,
          1_000,
          10_000,
        ),
    ).toThrow(WorkerConfigurationError);

    // Exactly equal to VT is also rejected (must be strictly less)
    // 280_000 + 17_000 + 3 * 1_000 = 300_000 == 300_000
    expect(
      () =>
        new WorkerConfig(
          1,
          300,
          1000,
          30,
          undefined,
          5000,
          5,
          15_000,
          180_000,
          60_000,
          280_000,
          17_000,
          1_000,
          10_000,
        ),
    ).toThrow(WorkerConfigurationError);
  });

  it('loads custom deadline parameters from environment', () => {
    const config = WorkerConfig.fromEnvironment({
      SAVIA_WORKER_LEASE_SAFETY_MS: '25000',
      SAVIA_WORKER_TERMINAL_RESERVE_MS: '15000',
      SAVIA_WORKER_MIN_OPERATION_MS: '2000',
      SAVIA_WORKER_QUEUE_TIMEOUT_MS: '12000',
    });
    expect(config.leaseSafetyMs).toBe(25_000);
    expect(config.terminalReserveMs).toBe(15_000);
    expect(config.minOperationMs).toBe(2_000);
    expect(config.queueTimeoutMs).toBe(12_000);
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

  it('rejects individually valid render and storage caps whose sum is unsafe', () => {
    expect(
      () =>
        new WorkerConfig(
          1,
          300,
          1000,
          30,
          undefined,
          5000,
          5,
          15_000,
          180_000,
          60_000,
          20_000,
          10_000,
          1_000,
          8_000,
          140_000,
          140_000,
        ),
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
