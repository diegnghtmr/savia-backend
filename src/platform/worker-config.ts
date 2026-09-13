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
  ) {
    if (batchSize > 10) {
      throw new WorkerConfigurationError('batchSize must not exceed 10.');
    }
    if (poolSize !== undefined && poolSize < batchSize + 1) {
      throw new WorkerConfigurationError(
        `poolSize (${poolSize}) must be at least batchSize + 1 (${batchSize + 1}).`,
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
    const poolSize =
      environment.DATABASE_POOL_MAX !== undefined
        ? readPositiveInteger(
            environment.DATABASE_POOL_MAX,
            4,
            'DATABASE_POOL_MAX',
            32,
          )
        : undefined;
    if (poolSize !== undefined && poolSize < batchSize + 1) {
      throw new WorkerConfigurationError(
        `DATABASE_POOL_MAX (${poolSize}) must be at least SAVIA_WORKER_BATCH_SIZE + 1 (${batchSize + 1}).`,
      );
    }
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
