import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTVerifyOptions,
} from 'jose';
import { AuthConfig } from './auth-config.js';
import type { SessionIdentity } from './request-identity.js';
import { UUID_PATTERN } from './uuid.js';
import type { PostgresSessionStore } from './postgres-session.store.js';
const JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const JWKS_COOLDOWN_DURATION_MS = 30 * 1000;
const JWKS_TIMEOUT_DURATION_MS = 5 * 1000;
interface JoseJwtVerifierOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly cooldownDuration?: number;
  readonly timeoutDuration?: number;
}
export class IdentityVerificationError extends Error {
  public readonly statusCode = 401;
  public constructor() {
    super('Unauthorized');
  }
}
export class JoseJwtVerifier {
  private readonly verificationOptions: JWTVerifyOptions;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  public constructor(
    config: AuthConfig,
    private readonly sessions: Pick<PostgresSessionStore, 'isActive'>,
    options: JoseJwtVerifierOptions = {},
  ) {
    this.verificationOptions = {
      algorithms: [...config.algorithms],
      audience: config.audience,
      issuer: config.issuer,
      requiredClaims: ['sub', 'exp', 'session_id'],
    };
    this.jwks = createRemoteJWKSet(config.jwksUri, {
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
      cooldownDuration: options.cooldownDuration ?? JWKS_COOLDOWN_DURATION_MS,
      timeoutDuration: options.timeoutDuration ?? JWKS_TIMEOUT_DURATION_MS,
      ...(options.fetch === undefined ? {} : { [customFetch]: options.fetch }),
    });
  }
  public async verify(token: string): Promise<SessionIdentity> {
    const {
      sub,
      session_id: sid,
      client_id,
      mcp_grant_id,
    } = await jwtVerify(token, this.jwks, this.verificationOptions).then(
      ({ payload }) => payload,
      () => {
        throw new IdentityVerificationError();
      },
    );
    if (
      typeof sub !== 'string' ||
      !UUID_PATTERN.test(sub) ||
      typeof sid !== 'string' ||
      !UUID_PATTERN.test(sid) ||
      client_id !== undefined ||
      mcp_grant_id !== undefined
    ) {
      throw new IdentityVerificationError();
    }
    const subject = sub.toLowerCase();
    const sessionId = sid.toLowerCase();
    if (!(await this.sessions.isActive(subject, sessionId)))
      throw new IdentityVerificationError();
    return { subject, sessionId, authMethod: 'session' };
  }
}
