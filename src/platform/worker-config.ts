import { PostgresConfig } from './postgres-config.js';
import { JOB_OCR_BUDGETS, type JobHandler } from './job-handler.port.js';

export class WorkerConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WorkerConfigurationError';
  }
}

export class WorkerConfig {
  public constructor(
    public readonly batchSize: number,
    public readonly visibilityTimeoutSeconds: number,
    public readonly pollIntervalMs: number,
    public readonly drainTimeoutSeconds: number,
    public readonly poolSize?: number,
    public readonly poolCloseGraceMs: number = 5_000,
    public readonly maxAttempts: number = 5,
    public readonly transitionTimeoutMs: number = 15_000,
    public readonly computeTimeoutMs: number = 180_000,
    public readonly persistTimeoutMs: number = 60_000,
    public readonly leaseSafetyMs: number = 20_000,
    public readonly terminalReserveMs: number = 10_000,
    public readonly minOperationMs: number = 1_000,
    public readonly queueTimeoutMs: number = 8_000,
    public readonly storageUploadTimeoutMs: number = 30_000,
    public readonly pdfRenderTimeoutMs: number = 30_000,
    public readonly exportSerializeTimeoutMs: number = 30_000,
    public readonly renderSettleTimeoutMs: number = 2_000,
    public readonly rendererLaunchTimeoutMs: number = 10_000,
    public readonly ocrComputeTimeoutMs: number = 10_000,
    public readonly storageDownloadTimeoutMs: number = 20_000,
    public readonly ocrTimeoutMs: number = 30_000,
    public readonly stageCleanupTimeoutMs: number = 2_000,
    public readonly ocrMemoryLimitBytes: number = 1_073_741_824,
    public readonly ocrConcurrency: number = Math.min(2, batchSize),
  ) {
    if (batchSize > 10) {
      throw new WorkerConfigurationError('batchSize must not exceed 10.');
    }
    if (poolSize !== undefined && poolSize < batchSize + 1) {
      throw new WorkerConfigurationError(
        `poolSize (${poolSize}) must be at least batchSize + 1 (${batchSize + 1}).`,
      );
    }
    if (maxAttempts < 1) {
      throw new WorkerConfigurationError('maxAttempts must be at least 1.');
    }
    if (transitionTimeoutMs < 1) {
      throw new WorkerConfigurationError(
        'transitionTimeoutMs must be at least 1.',
      );
    }
    if (computeTimeoutMs < 1) {
      throw new WorkerConfigurationError(
        'computeTimeoutMs must be at least 1.',
      );
    }
    if (persistTimeoutMs < 1) {
      throw new WorkerConfigurationError(
        'persistTimeoutMs must be at least 1.',
      );
    }
    if (leaseSafetyMs < 1) {
      throw new WorkerConfigurationError('leaseSafetyMs must be at least 1.');
    }
    if (terminalReserveMs < 1) {
      throw new WorkerConfigurationError(
        'terminalReserveMs must be at least 1.',
      );
    }
    if (minOperationMs < 1) {
      throw new WorkerConfigurationError('minOperationMs must be at least 1.');
    }
    if (queueTimeoutMs < 1) {
      throw new WorkerConfigurationError('queueTimeoutMs must be at least 1.');
    }
    if (storageUploadTimeoutMs < 1) {
      throw new WorkerConfigurationError(
        'storageUploadTimeoutMs must be at least 1.',
      );
    }
    if (pdfRenderTimeoutMs < 1) {
      throw new WorkerConfigurationError(
        'pdfRenderTimeoutMs must be at least 1.',
      );
    }
    if (exportSerializeTimeoutMs < 1) {
      throw new WorkerConfigurationError(
        'exportSerializeTimeoutMs must be at least 1.',
      );
    }
    if (renderSettleTimeoutMs < 1) {
      throw new WorkerConfigurationError(
        'renderSettleTimeoutMs must be at least 1.',
      );
    }
    if (rendererLaunchTimeoutMs < 1) {
      throw new WorkerConfigurationError(
        'rendererLaunchTimeoutMs must be at least 1.',
      );
    }
    if (ocrComputeTimeoutMs < 1) {
      throw new WorkerConfigurationError(
        'ocrComputeTimeoutMs must be at least 1.',
      );
    }
    if (storageDownloadTimeoutMs < 1) {
      throw new WorkerConfigurationError(
        'storageDownloadTimeoutMs must be at least 1.',
      );
    }
    if (ocrTimeoutMs < 1) {
      throw new WorkerConfigurationError('ocrTimeoutMs must be at least 1.');
    }
    if (stageCleanupTimeoutMs < 1) {
      throw new WorkerConfigurationError(
        'stageCleanupTimeoutMs must be at least 1.',
      );
    }
    if (
      ocrMemoryLimitBytes < 268_435_456 ||
      ocrMemoryLimitBytes > 4_294_967_296
    ) {
      throw new WorkerConfigurationError(
        `ocrMemoryLimitBytes (${ocrMemoryLimitBytes} bytes) must be between 268435456 (256 MiB) and 4294967296 (4 GiB).`,
      );
    }
    if (ocrConcurrency < 1) {
      throw new WorkerConfigurationError('ocrConcurrency must be at least 1.');
    }
    if (ocrConcurrency > batchSize) {
      throw new WorkerConfigurationError(
        `ocrConcurrency (${ocrConcurrency}) must not exceed batchSize (${batchSize}).`,
      );
    }
    if (queueTimeoutMs >= terminalReserveMs) {
      throw new WorkerConfigurationError(
        `queueTimeoutMs (${queueTimeoutMs}ms) must be strictly less than terminalReserveMs (${terminalReserveMs}ms).`,
      );
    }

    const visibilityMs = visibilityTimeoutSeconds * 1_000;
    if (transitionTimeoutMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `transitionTimeoutMs (${transitionTimeoutMs}ms) must be strictly less than visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms).`,
      );
    }
    if (computeTimeoutMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `computeTimeoutMs (${computeTimeoutMs}ms) must be strictly less than visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms).`,
      );
    }
    if (persistTimeoutMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `persistTimeoutMs (${persistTimeoutMs}ms) must be strictly less than visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms).`,
      );
    }
    if (queueTimeoutMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `queueTimeoutMs (${queueTimeoutMs}ms) must be strictly less than visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms).`,
      );
    }
    if (storageUploadTimeoutMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `storageUploadTimeoutMs (${storageUploadTimeoutMs}ms) must be strictly less than visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms).`,
      );
    }
    if (pdfRenderTimeoutMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `pdfRenderTimeoutMs (${pdfRenderTimeoutMs}ms) must be strictly less than visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms).`,
      );
    }
    if (exportSerializeTimeoutMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `exportSerializeTimeoutMs (${exportSerializeTimeoutMs}ms) must be strictly less than visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms).`,
      );
    }
    if (renderSettleTimeoutMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `renderSettleTimeoutMs (${renderSettleTimeoutMs}ms) must be strictly less than visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms).`,
      );
    }
    if (rendererLaunchTimeoutMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `rendererLaunchTimeoutMs (${rendererLaunchTimeoutMs}ms) must be strictly less than visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms).`,
      );
    }
    if (ocrComputeTimeoutMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `ocrComputeTimeoutMs (${ocrComputeTimeoutMs}ms) must be strictly less than visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms).`,
      );
    }
    if (storageDownloadTimeoutMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `storageDownloadTimeoutMs (${storageDownloadTimeoutMs}ms) must be strictly less than visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms).`,
      );
    }
    if (ocrTimeoutMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `ocrTimeoutMs (${ocrTimeoutMs}ms) must be strictly less than visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms).`,
      );
    }
    if (stageCleanupTimeoutMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `stageCleanupTimeoutMs (${stageCleanupTimeoutMs}ms) must be strictly less than visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms).`,
      );
    }

    const minDeadlineOverheadMs =
      leaseSafetyMs + terminalReserveMs + 3 * minOperationMs;
    if (minDeadlineOverheadMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `leaseSafetyMs (${leaseSafetyMs}ms) + terminalReserveMs (${terminalReserveMs}ms) + 3·minOperationMs (3·${minOperationMs}ms = ${3 * minOperationMs}ms) = ${minDeadlineOverheadMs}ms must be strictly less than visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms).`,
      );
    }

    const deliveryIoCapsMs =
      pdfRenderTimeoutMs + renderSettleTimeoutMs + storageUploadTimeoutMs;
    const deliveryIoBudgetMs = deliveryIoCapsMs + minDeadlineOverheadMs;
    if (deliveryIoBudgetMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `pdfRenderTimeoutMs (${pdfRenderTimeoutMs}ms) + renderSettleTimeoutMs (${renderSettleTimeoutMs}ms) + storageUploadTimeoutMs (${storageUploadTimeoutMs}ms) + leaseSafetyMs (${leaseSafetyMs}ms) + terminalReserveMs (${terminalReserveMs}ms) + 3·minOperationMs (3·${minOperationMs}ms = ${3 * minOperationMs}ms) = ${deliveryIoBudgetMs}ms must be strictly less than visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms).`,
      );
    }

    const exportIoCapsMs = exportSerializeTimeoutMs + storageUploadTimeoutMs;
    const exportIoBudgetMs = exportIoCapsMs + minDeadlineOverheadMs;
    if (exportIoBudgetMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `exportSerializeTimeoutMs (${exportSerializeTimeoutMs}ms) + storageUploadTimeoutMs (${storageUploadTimeoutMs}ms) + leaseSafetyMs (${leaseSafetyMs}ms) + terminalReserveMs (${terminalReserveMs}ms) + 3·minOperationMs (3·${minOperationMs}ms = ${3 * minOperationMs}ms) = ${exportIoBudgetMs}ms must be strictly less than visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms).`,
      );
    }

    const receiptOcrCapsMs =
      transitionTimeoutMs +
      ocrComputeTimeoutMs +
      storageDownloadTimeoutMs +
      ocrTimeoutMs +
      stageCleanupTimeoutMs +
      persistTimeoutMs;
    const receiptOcrReservesMs =
      leaseSafetyMs + terminalReserveMs + 5 * minOperationMs;
    const receiptOcrBudgetMs = receiptOcrCapsMs + receiptOcrReservesMs;
    if (receiptOcrBudgetMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `transitionTimeoutMs (${transitionTimeoutMs}ms) + ocrComputeTimeoutMs (${ocrComputeTimeoutMs}ms) + storageDownloadTimeoutMs (${storageDownloadTimeoutMs}ms) + ocrTimeoutMs (${ocrTimeoutMs}ms) + stageCleanupTimeoutMs (${stageCleanupTimeoutMs}ms) + persistTimeoutMs (${persistTimeoutMs}ms) + leaseSafetyMs (${leaseSafetyMs}ms) + terminalReserveMs (${terminalReserveMs}ms) + 5·minOperationMs (5·${minOperationMs}ms = ${5 * minOperationMs}ms) = ${receiptOcrBudgetMs}ms must be strictly less than visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms).`,
      );
    }
  }

  public resolveComputeTimeoutMs(
    handler:
      | JobHandler
      | { ocrBudget?: unknown; renderBudget?: unknown; jobType?: string },
  ): number {
    return resolveComputeTimeoutMs(this, handler);
  }

  public static fromEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
  ): WorkerConfig {
    const batchSize = readPositiveInteger(
      environment.SAVIA_WORKER_BATCH_SIZE,
      1,
      'SAVIA_WORKER_BATCH_SIZE',
      10,
    );
    const poolSize = PostgresConfig.poolMaxFromEnvironment(environment);
    if (poolSize < batchSize + 1) {
      throw new WorkerConfigurationError(
        `DATABASE_POOL_MAX (${poolSize}) must be at least SAVIA_WORKER_BATCH_SIZE + 1 (${batchSize + 1}).`,
      );
    }

    const maxAttempts = readPositiveInteger(
      environment.SAVIA_WORKER_MAX_ATTEMPTS,
      5,
      'SAVIA_WORKER_MAX_ATTEMPTS',
      100,
    );

    const transitionTimeoutMs = readPositiveInteger(
      environment.SAVIA_WORKER_TRANSITION_TIMEOUT_MS,
      15_000,
      'SAVIA_WORKER_TRANSITION_TIMEOUT_MS',
      3_600_000,
    );

    const computeTimeoutMs = readPositiveInteger(
      environment.SAVIA_WORKER_COMPUTE_TIMEOUT_MS,
      180_000,
      'SAVIA_WORKER_COMPUTE_TIMEOUT_MS',
      3_600_000,
    );

    const persistTimeoutMs = readPositiveInteger(
      environment.SAVIA_WORKER_PERSIST_TIMEOUT_MS,
      60_000,
      'SAVIA_WORKER_PERSIST_TIMEOUT_MS',
      3_600_000,
    );

    const leaseSafetyMs = readPositiveInteger(
      environment.SAVIA_WORKER_LEASE_SAFETY_MS,
      20_000,
      'SAVIA_WORKER_LEASE_SAFETY_MS',
      3_600_000,
    );

    const terminalReserveMs = readPositiveInteger(
      environment.SAVIA_WORKER_TERMINAL_RESERVE_MS,
      10_000,
      'SAVIA_WORKER_TERMINAL_RESERVE_MS',
      3_600_000,
    );

    const minOperationMs = readPositiveInteger(
      environment.SAVIA_WORKER_MIN_OPERATION_MS,
      1_000,
      'SAVIA_WORKER_MIN_OPERATION_MS',
      60_000,
    );

    const queueTimeoutMs = readPositiveInteger(
      environment.SAVIA_WORKER_QUEUE_TIMEOUT_MS,
      8_000,
      'SAVIA_WORKER_QUEUE_TIMEOUT_MS',
      3_600_000,
    );

    const storageUploadTimeoutMs = readPositiveInteger(
      environment.SAVIA_WORKER_STORAGE_UPLOAD_TIMEOUT_MS,
      30_000,
      'SAVIA_WORKER_STORAGE_UPLOAD_TIMEOUT_MS',
      3_600_000,
    );

    const pdfRenderTimeoutMs = readPositiveInteger(
      environment.SAVIA_WORKER_PDF_RENDER_TIMEOUT_MS,
      30_000,
      'SAVIA_WORKER_PDF_RENDER_TIMEOUT_MS',
      3_600_000,
    );

    const exportSerializeTimeoutMs = readPositiveInteger(
      environment.SAVIA_WORKER_EXPORT_SERIALIZE_TIMEOUT_MS,
      30_000,
      'SAVIA_WORKER_EXPORT_SERIALIZE_TIMEOUT_MS',
      3_600_000,
    );

    const renderSettleTimeoutMs = readPositiveInteger(
      environment.SAVIA_WORKER_RENDER_SETTLE_TIMEOUT_MS,
      2_000,
      'SAVIA_WORKER_RENDER_SETTLE_TIMEOUT_MS',
      3_600_000,
    );

    const rendererLaunchTimeoutMs = readPositiveInteger(
      environment.SAVIA_WORKER_RENDERER_LAUNCH_TIMEOUT_MS,
      10_000,
      'SAVIA_WORKER_RENDERER_LAUNCH_TIMEOUT_MS',
      3_600_000,
    );

    const ocrComputeTimeoutMs = readPositiveInteger(
      environment.SAVIA_WORKER_OCR_COMPUTE_TIMEOUT_MS,
      10_000,
      'SAVIA_WORKER_OCR_COMPUTE_TIMEOUT_MS',
      3_600_000,
    );

    const storageDownloadTimeoutMs = readPositiveInteger(
      environment.SAVIA_WORKER_STORAGE_DOWNLOAD_TIMEOUT_MS,
      20_000,
      'SAVIA_WORKER_STORAGE_DOWNLOAD_TIMEOUT_MS',
      3_600_000,
    );

    const ocrTimeoutMs = readPositiveInteger(
      environment.SAVIA_WORKER_OCR_TIMEOUT_MS,
      30_000,
      'SAVIA_WORKER_OCR_TIMEOUT_MS',
      3_600_000,
    );

    const stageCleanupTimeoutMs = readPositiveInteger(
      environment.SAVIA_WORKER_STAGE_CLEANUP_TIMEOUT_MS,
      2_000,
      'SAVIA_WORKER_STAGE_CLEANUP_TIMEOUT_MS',
      60_000,
    );

    const ocrMemoryLimitBytes = readIntegerInRange(
      environment.SAVIA_WORKER_OCR_MEMORY_LIMIT_BYTES,
      1_073_741_824,
      'SAVIA_WORKER_OCR_MEMORY_LIMIT_BYTES',
      268_435_456,
      4_294_967_296,
    );

    const ocrConcurrency = readPositiveInteger(
      environment.SAVIA_WORKER_OCR_CONCURRENCY,
      Math.min(2, batchSize),
      'SAVIA_WORKER_OCR_CONCURRENCY',
      batchSize,
    );

    return new WorkerConfig(
      batchSize,
      readPositiveInteger(
        environment.SAVIA_WORKER_VT_SECONDS,
        300,
        'SAVIA_WORKER_VT_SECONDS',
        3_600,
      ),
      readPositiveInteger(
        environment.SAVIA_WORKER_POLL_INTERVAL_MS,
        1_000,
        'SAVIA_WORKER_POLL_INTERVAL_MS',
        60_000,
      ),
      readPositiveInteger(
        environment.SAVIA_WORKER_DRAIN_TIMEOUT_SECONDS,
        30,
        'SAVIA_WORKER_DRAIN_TIMEOUT_SECONDS',
        120,
      ),
      poolSize,
      readPositiveInteger(
        environment.SAVIA_WORKER_POOL_CLOSE_GRACE_MS,
        5_000,
        'SAVIA_WORKER_POOL_CLOSE_GRACE_MS',
        60_000,
      ),
      maxAttempts,
      transitionTimeoutMs,
      computeTimeoutMs,
      persistTimeoutMs,
      leaseSafetyMs,
      terminalReserveMs,
      minOperationMs,
      queueTimeoutMs,
      storageUploadTimeoutMs,
      pdfRenderTimeoutMs,
      exportSerializeTimeoutMs,
      renderSettleTimeoutMs,
      rendererLaunchTimeoutMs,
      ocrComputeTimeoutMs,
      storageDownloadTimeoutMs,
      ocrTimeoutMs,
      stageCleanupTimeoutMs,
      ocrMemoryLimitBytes,
      ocrConcurrency,
    );
  }
}

export function resolveComputeTimeoutMs(
  config: WorkerConfig,
  handler:
    | JobHandler
    | { ocrBudget?: unknown; renderBudget?: unknown; jobType?: string },
): number {
  if ('ocrBudget' in handler && handler.ocrBudget !== undefined) {
    if (handler.ocrBudget !== JOB_OCR_BUDGETS.RECEIPT_OCR) {
      throw new Error(
        `Unknown or invalid OCR budget "${String(handler.ocrBudget)}".`,
      );
    }
    if ('renderBudget' in handler && handler.renderBudget !== undefined) {
      throw new Error(
        `Handler "${String(handler.jobType)}" cannot define both ocrBudget and renderBudget.`,
      );
    }
    return config.ocrComputeTimeoutMs;
  }
  return config.computeTimeoutMs;
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  max: number,
): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new WorkerConfigurationError(
      `${name} must be a positive integer between 1 and ${max}.`,
    );
  }
  return parsed;
}

function readIntegerInRange(
  value: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new WorkerConfigurationError(
      `${name} must be an integer between ${min} and ${max}.`,
    );
  }
  return parsed;
}
