import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

import type { AuthenticatedRequest } from './authenticated-request.js';
import type { RequestIdentity } from './request-identity.js';
import { JoseJwtVerifier } from './jose-jwt-verifier.js';
import { CliTokenVerifier } from './cli-token-verifier.js';
import { CLI_SCOPE_POLICY, routeKey } from './cli-scope-policy.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  public constructor(
    private readonly verifier: JoseJwtVerifier,
    private readonly cliTokenVerifier: CliTokenVerifier,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (token === undefined) throw new UnauthorizedException();

    let identity: RequestIdentity;
    try {
      identity = await (token.startsWith('svt_')
        ? this.cliTokenVerifier.verify(token)
        : this.verifier.verify(token));
    } catch {
      throw new UnauthorizedException();
    }
    request.identity = identity;
    if (identity.authMethod === 'cli_token') {
      const requiredScopes = CLI_SCOPE_POLICY.get(
        routeKey(request.method, request.routeOptions.url ?? request.url),
      );
      if (
        requiredScopes === undefined ||
        !requiredScopes.every((scope) => identity.scopes.includes(scope))
      ) {
        throw new ForbiddenException();
      }
    }
    return true;
  }
}

function extractBearerToken(
  authorization: string | undefined,
): string | undefined {
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? '');
  return match?.[1];
}
