import { PostgresConfig } from './postgres-config.js';

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

    const minDeadlineOverheadMs =
      leaseSafetyMs + terminalReserveMs + 3 * minOperationMs;
    if (minDeadlineOverheadMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `leaseSafetyMs (${leaseSafetyMs}ms) + terminalReserveMs (${terminalReserveMs}ms) + 3·minOperationMs (3·${minOperationMs}ms = ${3 * minOperationMs}ms) = ${minDeadlineOverheadMs}ms must be strictly less than visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms).`,
      );
    }
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
    );
  }
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
