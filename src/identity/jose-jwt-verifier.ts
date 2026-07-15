import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTVerifyOptions,
} from 'jose';
import { AuthConfig } from './auth-config.js';
import type { RequestIdentity } from './request-identity.js';
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
  public constructor(config: AuthConfig, options: JoseJwtVerifierOptions = {}) {
    this.verificationOptions = {
      algorithms: [...config.algorithms],
      audience: config.audience,
      issuer: config.issuer,
      requiredClaims: ['sub', 'exp'],
    };
    this.jwks = createRemoteJWKSet(config.jwksUri, {
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
      cooldownDuration: options.cooldownDuration ?? JWKS_COOLDOWN_DURATION_MS,
      timeoutDuration: options.timeoutDuration ?? JWKS_TIMEOUT_DURATION_MS,
      ...(options.fetch === undefined ? {} : { [customFetch]: options.fetch }),
    });
  }
  public async verify(token: string): Promise<RequestIdentity> {
    try {
      const { payload } = await jwtVerify(
        token,
        this.jwks,
        this.verificationOptions,
      );
      if (typeof payload.sub !== 'string' || payload.sub.trim() === '') {
        throw new IdentityVerificationError();
      }
      return { subject: payload.sub };
    } catch (error) {
      if (error instanceof IdentityVerificationError) throw error;
      throw new IdentityVerificationError();
    }
  }
}
