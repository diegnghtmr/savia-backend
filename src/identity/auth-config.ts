const ASYMMETRIC_JWT_ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'] as const;
type AsymmetricJwtAlgorithm = (typeof ASYMMETRIC_JWT_ALGORITHMS)[number];
type Environment = Readonly<Record<string, string | undefined>>;
export class AuthConfig {
  private constructor(
    public readonly issuer: string,
    public readonly audience: string,
    public readonly jwksUri: URL,
    public readonly algorithms: readonly AsymmetricJwtAlgorithm[],
  ) {}
  public static fromEnvironment(environment: Environment): AuthConfig {
    const issuer = requireNonEmpty(environment.JWT_ISSUER, 'JWT_ISSUER');
    const audience = requireNonEmpty(environment.JWT_AUDIENCE, 'JWT_AUDIENCE');
    const jwksUri = parseHttpsUrl(environment.JWT_JWKS_URI);
    const algorithms = parseAlgorithms(environment.JWT_ALGORITHMS);
    return new AuthConfig(issuer, audience, jwksUri, algorithms);
  }
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (value?.trim()) return value;
  throw new Error(`JWT configuration ${name} must be a non-empty string.`);
}
function parseHttpsUrl(value: string | undefined): URL {
  try {
    const url = new URL(requireNonEmpty(value, 'JWT_JWKS_URI'));
    if (url.protocol !== 'https:') throw new Error('not HTTPS');
    return url;
  } catch {
    throw new Error('JWT configuration JWT_JWKS_URI must be an HTTPS URL.');
  }
}
function parseAlgorithms(
  value: string | undefined,
): readonly AsymmetricJwtAlgorithm[] {
  const algorithms = requireNonEmpty(value, 'JWT_ALGORITHMS')
    .split(',')
    .map((algorithm) => algorithm.trim());
  if (
    algorithms.length === 0 ||
    algorithms.some(
      (algorithm) =>
        !ASYMMETRIC_JWT_ALGORITHMS.includes(
          algorithm as AsymmetricJwtAlgorithm,
        ),
    )
  ) {
    throw new Error('JWT configuration JWT_ALGORITHMS is invalid.');
  }
  return [...new Set(algorithms)] as AsymmetricJwtAlgorithm[];
}
