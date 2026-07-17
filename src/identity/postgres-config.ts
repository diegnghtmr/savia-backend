export class PostgresConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PostgresConfigurationError';
  }
}
export class PostgresConfig {
  private constructor(
    public readonly connectionString: string,
    public readonly poolMax: number,
    public readonly checkoutTimeoutMs: number,
  ) {}
  public static fromEnvironment(
    environment: NodeJS.ProcessEnv,
  ): PostgresConfig {
    return PostgresConfig.fromUrl(environment.DATABASE_URL, environment);
  }

  public static fromUrl(
    connectionString: string | undefined,
    environment: NodeJS.ProcessEnv = {},
  ): PostgresConfig {
    if (!connectionString?.trim())
      throw new PostgresConfigurationError('DATABASE_URL must be configured.');
    const url = parsePostgresUrl(connectionString);
    return new PostgresConfig(
      url.toString(),
      readPositiveInteger(
        environment.DATABASE_POOL_MAX,
        4,
        'DATABASE_POOL_MAX',
        32,
      ),
      readPositiveInteger(
        environment.DATABASE_CHECKOUT_TIMEOUT_MS,
        1_000,
        'DATABASE_CHECKOUT_TIMEOUT_MS',
        10_000,
      ),
    );
  }
}

function parsePostgresUrl(connectionString: string): URL {
  try {
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname)
      throw new Error();
    return url;
  } catch {
    throw new PostgresConfigurationError(
      'DATABASE_URL must be a PostgreSQL URL.',
    );
  }
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new PostgresConfigurationError(`${name} must be an integer.`);
  }
  if (parsed <= 0)
    throw new PostgresConfigurationError(`${name} must be greater than zero.`);
  if (parsed > maximum) {
    throw new PostgresConfigurationError(`${name} must not exceed ${maximum}.`);
  }
  return parsed;
}
