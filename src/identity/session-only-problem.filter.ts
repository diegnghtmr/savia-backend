import {
  type ArgumentsHost,
  Catch,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { OnboardingProblemFilter } from './onboarding-problem.filter.js';

@Catch(ForbiddenException)
export class SessionOnlyProblemFilter extends OnboardingProblemFilter {
  public override catch(
    exception: ForbiddenException,
    host: ArgumentsHost,
  ): void {
    const request = host.switchToHttp().getRequest<AuthenticatedRequest>();
    // The shared guard has verified the CLI token but denied its use here.
    // These routes require a different credential, not a broader CLI scope.
    super.catch(
      request.identity?.authMethod === 'cli_token'
        ? new UnauthorizedException()
        : exception,
      host,
    );
  }
}
