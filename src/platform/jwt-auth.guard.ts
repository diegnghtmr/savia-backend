import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import type { AuthenticatedRequest } from './authenticated-request.js';
import { JoseJwtVerifier } from './jose-jwt-verifier.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  public constructor(private readonly verifier: JoseJwtVerifier) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (token === undefined) throw new UnauthorizedException();

    try {
      request.identity = await this.verifier.verify(token);
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}

function extractBearerToken(
  authorization: string | undefined,
): string | undefined {
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? '');
  return match?.[1];
}
