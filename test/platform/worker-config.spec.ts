import { describe, expect, it, vi } from 'vitest';
import {
  WorkerConfig,
  WorkerConfigurationError,
  resolveComputeTimeoutMs,
} from '../../src/platform/worker-config.js';
import {
  JOB_OCR_BUDGETS,
  JOB_RENDER_BUDGETS,
} from '../../src/platform/job-handler.port.js';
import { ForecastJobHandler } from '../../src/forecasts/forecast-job.handler.js';
import { ReportJobHandler } from '../../src/reports/report-job.handler.js';

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

  it('validates exportSerializeTimeoutMs bounds, cap-sum with storage, and environment loading', () => {
    // 1. Rejects exportSerializeTimeoutMs < 1
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
          30_000,
          30_000,
          0,
        ),
    ).toThrow(WorkerConfigurationError);

    // 2. Rejects exportSerializeTimeoutMs >= visibility timeout
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
          30_000,
          30_000,
          300_000,
        ),
    ).toThrow(WorkerConfigurationError);

    // 3. Rejects exportSerializeTimeoutMs + storageUploadTimeoutMs when sum is unsafe
    // (140_000 + 140_000 + 20_000 + 10_000 + 3 * 1_000 = 313_000 >= 300_000)
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
          30_000,
          140_000,
        ),
    ).toThrow(WorkerConfigurationError);

    // 4. Accepts valid exportSerializeTimeoutMs and storageUploadTimeoutMs cap sum
    const safeConfig = new WorkerConfig(
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
      30_000,
      30_000,
      30_000,
    );
    expect(safeConfig.exportSerializeTimeoutMs).toBe(30_000);

    // 5. Loads custom SAVIA_WORKER_EXPORT_SERIALIZE_TIMEOUT_MS from environment
    const envConfig = WorkerConfig.fromEnvironment({
      SAVIA_WORKER_EXPORT_SERIALIZE_TIMEOUT_MS: '45000',
    });
    expect(envConfig.exportSerializeTimeoutMs).toBe(45_000);
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

  it('validates renderSettleTimeoutMs bounds, cap-sum with render and storage, and environment loading', () => {
    // 1. Defaults to 2_000ms
    const defaultConfig = new WorkerConfig(1, 300, 1000, 30);
    expect(defaultConfig.renderSettleTimeoutMs).toBe(2_000);

    // 2. Rejects renderSettleTimeoutMs < 1
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
          30_000,
          30_000,
          30_000,
          0,
        ),
    ).toThrow(WorkerConfigurationError);

    // 3. Rejects renderSettleTimeoutMs >= visibility timeout
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
          30_000,
          30_000,
          30_000,
          300_000,
        ),
    ).toThrow(WorkerConfigurationError);

    // 4. Rejects pdfRenderTimeoutMs + renderSettleTimeoutMs + storageUploadTimeoutMs when sum is unsafe
    // (135_000 + 10_000 + 135_000 + 20_000 + 10_000 + 3 * 1_000 = 313_000 >= 300_000)
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
          135_000,
          135_000,
          30_000,
          10_000,
        ),
    ).toThrow(WorkerConfigurationError);

    // 5. Accepts valid pdfRenderTimeoutMs + renderSettleTimeoutMs + storageUploadTimeoutMs cap sum
    const safeConfig = new WorkerConfig(
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
      30_000,
      30_000,
      30_000,
      5_000,
    );
    expect(safeConfig.renderSettleTimeoutMs).toBe(5_000);

    // 6. Loads custom SAVIA_WORKER_RENDER_SETTLE_TIMEOUT_MS from environment
    const envConfig = WorkerConfig.fromEnvironment({
      SAVIA_WORKER_RENDER_SETTLE_TIMEOUT_MS: '4000',
    });
    expect(envConfig.renderSettleTimeoutMs).toBe(4_000);
  });

  it('validates rendererLaunchTimeoutMs bounds and environment loading', () => {
    // 1. Defaults to 10_000ms
    const defaultConfig = WorkerConfig.fromEnvironment({});
    expect(defaultConfig.rendererLaunchTimeoutMs).toBe(10_000);

    // 2. Rejects rendererLaunchTimeoutMs < 1
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
          30_000,
          30_000,
          30_000,
          2_000,
          0,
        ),
    ).toThrow(WorkerConfigurationError);

    // 3. Rejects rendererLaunchTimeoutMs >= visibility timeout
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
          30_000,
          30_000,
          30_000,
          2_000,
          300_000,
        ),
    ).toThrow(WorkerConfigurationError);

    // 4. Loads custom SAVIA_WORKER_RENDERER_LAUNCH_TIMEOUT_MS from environment
    const envConfig = WorkerConfig.fromEnvironment({
      SAVIA_WORKER_RENDERER_LAUNCH_TIMEOUT_MS: '15000',
    });
    expect(envConfig.rendererLaunchTimeoutMs).toBe(15_000);
  });

  describe('Receipt OCR worker configuration and budget', () => {
    it('loads defaults for OCR configuration parameters', () => {
      const config = WorkerConfig.fromEnvironment({});
      expect(config.ocrComputeTimeoutMs).toBe(10_000);
      expect(config.storageDownloadTimeoutMs).toBe(20_000);
      expect(config.ocrTimeoutMs).toBe(30_000);
      expect(config.stageCleanupTimeoutMs).toBe(2_000);
      expect(config.ocrMemoryLimitBytes).toBe(1_073_741_824);
      // Concurrency default is min(2, batchSize); for batchSize 1 it is 1
      expect(config.ocrConcurrency).toBe(1);

      const batch5Config = WorkerConfig.fromEnvironment({
        SAVIA_WORKER_BATCH_SIZE: '5',
        DATABASE_POOL_MAX: '6',
      });
      // For batchSize 5, default min(2, 5) = 2
      expect(batch5Config.ocrConcurrency).toBe(2);
    });

    it('loads custom valid OCR configuration from environment', () => {
      const config = WorkerConfig.fromEnvironment({
        SAVIA_WORKER_BATCH_SIZE: '5',
        DATABASE_POOL_MAX: '6',
        SAVIA_WORKER_OCR_COMPUTE_TIMEOUT_MS: '12000',
        SAVIA_WORKER_STORAGE_DOWNLOAD_TIMEOUT_MS: '25000',
        SAVIA_WORKER_OCR_TIMEOUT_MS: '35000',
        SAVIA_WORKER_STAGE_CLEANUP_TIMEOUT_MS: '3000',
        SAVIA_WORKER_OCR_MEMORY_LIMIT_BYTES: '2147483648',
        SAVIA_WORKER_OCR_CONCURRENCY: '3',
      });
      expect(config.ocrComputeTimeoutMs).toBe(12_000);
      expect(config.storageDownloadTimeoutMs).toBe(25_000);
      expect(config.ocrTimeoutMs).toBe(35_000);
      expect(config.stageCleanupTimeoutMs).toBe(3_000);
      expect(config.ocrMemoryLimitBytes).toBe(2_147_483_648);
      expect(config.ocrConcurrency).toBe(3);
    });

    it('validates OCR timeout bounds and rejects invalid values', () => {
      // ocrComputeTimeoutMs bounds [1, 3_600_000]
      expect(() =>
        WorkerConfig.fromEnvironment({
          SAVIA_WORKER_OCR_COMPUTE_TIMEOUT_MS: '0',
        }),
      ).toThrow(WorkerConfigurationError);
      expect(() =>
        WorkerConfig.fromEnvironment({
          SAVIA_WORKER_OCR_COMPUTE_TIMEOUT_MS: '-1',
        }),
      ).toThrow(WorkerConfigurationError);
      expect(() =>
        WorkerConfig.fromEnvironment({
          SAVIA_WORKER_OCR_COMPUTE_TIMEOUT_MS: '3600001',
        }),
      ).toThrow(WorkerConfigurationError);

      // storageDownloadTimeoutMs bounds [1, 3_600_000]
      expect(() =>
        WorkerConfig.fromEnvironment({
          SAVIA_WORKER_STORAGE_DOWNLOAD_TIMEOUT_MS: '0',
        }),
      ).toThrow(WorkerConfigurationError);
      expect(() =>
        WorkerConfig.fromEnvironment({
          SAVIA_WORKER_STORAGE_DOWNLOAD_TIMEOUT_MS: '3600001',
        }),
      ).toThrow(WorkerConfigurationError);

      // ocrTimeoutMs bounds [1, 3_600_000]
      expect(() =>
        WorkerConfig.fromEnvironment({
          SAVIA_WORKER_OCR_TIMEOUT_MS: '0',
        }),
      ).toThrow(WorkerConfigurationError);
      expect(() =>
        WorkerConfig.fromEnvironment({
          SAVIA_WORKER_OCR_TIMEOUT_MS: '3600001',
        }),
      ).toThrow(WorkerConfigurationError);

      // stageCleanupTimeoutMs bounds [1, 60_000]
      expect(() =>
        WorkerConfig.fromEnvironment({
          SAVIA_WORKER_STAGE_CLEANUP_TIMEOUT_MS: '0',
        }),
      ).toThrow(WorkerConfigurationError);
      expect(() =>
        WorkerConfig.fromEnvironment({
          SAVIA_WORKER_STAGE_CLEANUP_TIMEOUT_MS: '60001',
        }),
      ).toThrow(WorkerConfigurationError);
    });

    it('validates ocrMemoryLimitBytes bounds [256 MiB, 4 GiB]', () => {
      // Min is 268_435_456 bytes (256 MiB); 268_435_455 must throw (mutation h target)
      expect(() =>
        WorkerConfig.fromEnvironment({
          SAVIA_WORKER_OCR_MEMORY_LIMIT_BYTES: '268435455',
        }),
      ).toThrow(WorkerConfigurationError);

      // Max is 4_294_967_296 bytes (4 GiB); 4_294_967_297 must throw
      expect(() =>
        WorkerConfig.fromEnvironment({
          SAVIA_WORKER_OCR_MEMORY_LIMIT_BYTES: '4294967297',
        }),
      ).toThrow(WorkerConfigurationError);

      // Non-integer must throw
      expect(() =>
        WorkerConfig.fromEnvironment({
          SAVIA_WORKER_OCR_MEMORY_LIMIT_BYTES: 'invalid',
        }),
      ).toThrow(WorkerConfigurationError);

      // Valid boundary values succeed
      const minConfig = WorkerConfig.fromEnvironment({
        SAVIA_WORKER_OCR_MEMORY_LIMIT_BYTES: '268435456',
      });
      expect(minConfig.ocrMemoryLimitBytes).toBe(268_435_456);

      const maxConfig = WorkerConfig.fromEnvironment({
        SAVIA_WORKER_OCR_MEMORY_LIMIT_BYTES: '4294967296',
      });
      expect(maxConfig.ocrMemoryLimitBytes).toBe(4_294_967_296);
    });

    it('validates ocrConcurrency invariant (ocrConcurrency <= batchSize)', () => {
      // ocrConcurrency > batchSize must throw (mutation c target)
      expect(() =>
        WorkerConfig.fromEnvironment({
          SAVIA_WORKER_BATCH_SIZE: '2',
          DATABASE_POOL_MAX: '4',
          SAVIA_WORKER_OCR_CONCURRENCY: '3',
        }),
      ).toThrow(WorkerConfigurationError);

      // Constructor enforcement of ocrConcurrency <= batchSize
      expect(
        () =>
          new WorkerConfig(
            2,
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
            30_000,
            30_000,
            30_000,
            2_000,
            10_000,
            10_000,
            20_000,
            30_000,
            2_000,
            1_073_741_824,
            3, // ocrConcurrency (3) > batchSize (2)
          ),
      ).toThrow(WorkerConfigurationError);

      // ocrConcurrency < 1 must throw
      expect(
        () =>
          new WorkerConfig(
            2,
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
            30_000,
            30_000,
            30_000,
            2_000,
            10_000,
            10_000,
            20_000,
            30_000,
            2_000,
            1_073_741_824,
            0, // ocrConcurrency < 1
          ),
      ).toThrow(WorkerConfigurationError);
    });

    it('rejects individual OCR caps greater than or equal to visibility timeout', () => {
      // ocrComputeTimeoutMs >= VT
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
            30_000,
            30_000,
            30_000,
            2_000,
            10_000,
            300_000, // ocrComputeTimeoutMs >= VT
          ),
      ).toThrow(WorkerConfigurationError);

      // storageDownloadTimeoutMs >= VT
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
            30_000,
            30_000,
            30_000,
            2_000,
            10_000,
            10_000,
            300_000, // storageDownloadTimeoutMs >= VT
          ),
      ).toThrow(WorkerConfigurationError);

      // ocrTimeoutMs >= VT
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
            30_000,
            30_000,
            30_000,
            2_000,
            10_000,
            10_000,
            20_000,
            300_000, // ocrTimeoutMs >= VT
          ),
      ).toThrow(WorkerConfigurationError);

      // stageCleanupTimeoutMs >= VT
      expect(
        () =>
          new WorkerConfig(
            1,
            50, // VT = 50s = 50_000ms
            1000,
            30,
            undefined,
            5000,
            5,
            5_000,
            20_000,
            10_000,
            5_000,
            5_000,
            1_000,
            2_000,
            10_000,
            10_000,
            10_000,
            2_000,
            5_000,
            5_000,
            5_000,
            5_000,
            50_000, // stageCleanupTimeoutMs == VT
          ),
      ).toThrow(WorkerConfigurationError);
    });

    it('pins the sequential receipt OCR visibility budget equation and reserves multiplier', () => {
      // Default equation:
      // caps: transition (15s) + ocrCompute (10s) + storageDownload (20s) + ocr (30s) + stageCleanup (2s) + persist (60s) = 137,000ms
      // reserves: leaseSafety (20s) + terminalReserve (10s) + 5 * minOperationMs (5 * 1s = 5s) = 35,000ms
      // total budget: 137,000 + 35,000 = 172,000ms
      //
      // Pass computeTimeoutMs = 100_000 (< 172_000) so non-OCR compute cap does not preempt the OCR budget check.
      //
      // Boundary test (mutation b target):
      // When visibilityMs == 172,000ms (172s), budget == visibilityMs.
      // Strict '<' requires receiptOcrBudgetMs < visibilityMs.
      // Therefore, at VT = 172s, it MUST throw WorkerConfigurationError with receiptOcrBudgetMs.
      expect(
        () =>
          new WorkerConfig(
            1,
            172, // VT = 172s (172_000ms) == budget (172_000ms)
            1000,
            30,
            undefined,
            5000,
            5,
            15_000,
            100_000, // computeTimeoutMs < 172s
          ),
      ).toThrow(WorkerConfigurationError);

      // When visibilityMs == 173,000ms (173s), budget (172,000ms) < visibilityMs (173,000ms).
      // It MUST SUCCEED (mutation a target: changing 5x multiplier alters this threshold).
      const validBudgetConfig = new WorkerConfig(
        1,
        173, // VT = 173s (173_000ms) > budget (172_000ms)
        1000,
        30,
        undefined,
        5000,
        5,
        15_000,
        100_000, // computeTimeoutMs < 173s
      );
      expect(validBudgetConfig.visibilityTimeoutSeconds).toBe(173);

      // If custom caps exceed visibility budget, WorkerConfigurationError is raised
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
            30_000,
            30_000,
            30_000,
            2_000,
            10_000,
            50_000, // elevated ocrCompute
            50_000, // elevated storageDownload
            100_000, // elevated ocrTimeout
            10_000, // elevated cleanup
            1_073_741_824,
            1,
          ),
      ).toThrow(WorkerConfigurationError);
    });

    it('resolves compute timeout strictly: 10s for validated OCR handlers, 180s for non-OCR handlers', () => {
      const config = WorkerConfig.fromEnvironment({});
      expect(config.ocrComputeTimeoutMs).toBe(10_000);
      expect(config.computeTimeoutMs).toBe(180_000);

      // (d) OCR handler receives ocrComputeTimeoutMs (10,000 ms), NOT 180,000 ms
      const ocrHandler = {
        jobType: 'receipt_ocr',
        ocrBudget: JOB_OCR_BUDGETS.RECEIPT_OCR,
        parsePayload: vi.fn(),
        compute: vi.fn(),
        download: vi.fn(),
        ocr: vi.fn(),
        persist: vi.fn(),
      };
      const ocrResolved = config.resolveComputeTimeoutMs(ocrHandler);
      expect(ocrResolved).toBe(10_000);
      expect(ocrResolved).not.toBe(180_000);
      expect(resolveComputeTimeoutMs(config, ocrHandler)).toBe(10_000);

      // (e) Non-OCR handler receives computeTimeoutMs (180,000 ms), NOT 10,000 ms
      const nonOcrHandler = {
        jobType: 'custom_job',
        parsePayload: vi.fn(),
        compute: vi.fn(),
        persist: vi.fn(),
      };
      const nonOcrResolved = config.resolveComputeTimeoutMs(nonOcrHandler);
      expect(nonOcrResolved).toBe(180_000);
      expect(nonOcrResolved).not.toBe(10_000);
      expect(resolveComputeTimeoutMs(config, nonOcrHandler)).toBe(180_000);

      // Proof against real handlers in the repository:
      // Real handler 1: ForecastJobHandler (NonRenderingJobHandler)
      const realForecastHandler = new ForecastJobHandler({} as never);
      expect(config.resolveComputeTimeoutMs(realForecastHandler)).toBe(180_000);

      // Real handler 2: ReportJobHandler (RenderingJobHandler with PDF_RENDER)
      const realReportHandler = new ReportJobHandler(
        {} as never,
        {} as never,
        {} as never,
        undefined,
        2_000,
      );
      expect(config.resolveComputeTimeoutMs(realReportHandler)).toBe(180_000);

      // Handler with invalid/unknown ocrBudget throws Error
      expect(() =>
        config.resolveComputeTimeoutMs({
          jobType: 'bogus_ocr',
          ocrBudget: 'invalid_budget' as never,
        }),
      ).toThrow(/Unknown or invalid OCR budget/);

      // Handler cannot define both ocrBudget and renderBudget
      expect(() =>
        config.resolveComputeTimeoutMs({
          jobType: 'conflicting_job',
          ocrBudget: JOB_OCR_BUDGETS.RECEIPT_OCR,
          renderBudget: JOB_RENDER_BUDGETS.PDF_RENDER,
        }),
      ).toThrow(/cannot define both ocrBudget and renderBudget/);
    });
  });
});
