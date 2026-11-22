import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import type { AuthenticatedRequest } from './authenticated-request.js';
import { JoseJwtVerifier } from './jose-jwt-verifier.js';
import { extractBearerToken } from './jwt-auth.guard.js';

@Injectable()
export class SessionJwtAuthGuard implements CanActivate {
  public constructor(private readonly verifier: JoseJwtVerifier) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token || token.startsWith('svt_')) throw new UnauthorizedException();

    try {
      const identity = await this.verifier.verify(token);
      if (identity.authMethod === 'session') {
        request.identity = identity;
        return true;
      }
    } catch {
      throw new UnauthorizedException();
    }
    throw new UnauthorizedException();
  }
}
