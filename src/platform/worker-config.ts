import { PostgresConfig } from './postgres-config.js';

export class WorkerConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WorkerConfigurationError';
  }
}

export class WorkerConfig {
  public static readonly SAFETY_MARGIN_MS = 30_000;

  public constructor(
    public readonly batchSize: number,
    public readonly visibilityTimeoutSeconds: number,
    public readonly pollIntervalMs: number,
    public readonly drainTimeoutSeconds: number,
    public readonly poolSize?: number,
    public readonly poolCloseGraceMs: number = 5_000,
    public readonly maxAttempts: number = 5,
    public readonly computeTimeoutMs: number = 180_000,
    public readonly persistTimeoutMs: number = 60_000,
    public readonly safetyMarginMs: number = WorkerConfig.SAFETY_MARGIN_MS,
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
    const requiredVisibilityMs =
      computeTimeoutMs + persistTimeoutMs + safetyMarginMs;
    const visibilityMs = visibilityTimeoutSeconds * 1_000;
    if (requiredVisibilityMs >= visibilityMs) {
      throw new WorkerConfigurationError(
        `visibilityTimeoutSeconds (${visibilityTimeoutSeconds}s = ${visibilityMs}ms) must be strictly greater than computeTimeoutMs (${computeTimeoutMs}ms) + persistTimeoutMs (${persistTimeoutMs}ms) + safetyMarginMs (${safetyMarginMs}ms) = ${requiredVisibilityMs}ms.`,
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
      computeTimeoutMs,
      persistTimeoutMs,
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
