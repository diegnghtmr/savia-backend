import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';

@Injectable()
export class NotificationSettingsAuthGuard implements CanActivate {
  public constructor(private readonly jwt: JwtAuthGuard) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      if (!(await this.jwt.canActivate(context))) return false;
    } catch (error) {
      // Unlike the shared CLI scope denial, these session-only routes specify 401.
      if (error instanceof ForbiddenException)
        throw new UnauthorizedException();
      throw error;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.identity.authMethod === 'cli_token')
      throw new UnauthorizedException();
    return true;
  }
}
