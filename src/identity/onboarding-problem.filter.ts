import {
  type ArgumentsHost,
  BadRequestException,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply } from 'fastify';

import type { AuthenticatedRequest } from './authenticated-request.js';
import { BootstrapCommandValidationError } from './bootstrap-command.js';
import { CommitOutcomeUnknownError } from './pg-transaction.js';
import { PROBLEM_TYPES, sendProblem } from './problem-details.js';

const RETRY_AFTER_SECONDS = 5;

@Catch()
export class OnboardingProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(OnboardingProblemFilter.name);

  public catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (exception instanceof BootstrapCommandValidationError)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.VALIDATION_FAILED,
        title: 'Request validation failed',
        status: 400,
        errors: exception.violations,
      });
    if (exception instanceof UnauthorizedException)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNAUTHORIZED,
        title: 'Authentication is required',
        status: 401,
      });
    if (exception instanceof CommitOutcomeUnknownError) {
      // The write may or may not have landed. Retrying is safe only for
      // commands that carry a replay mechanism (such as an idempotent command
      // per subject or an Idempotency-Key); for a version-bumping PATCH,
      // the client's protection is If-Match, which makes a retry answer 412
      // once the first write actually landed.
      // This is the only outcome an operator may need to reconcile by hand,
      // so the log names the subject and the underlying cause.
      const { subject } = host
        .switchToHttp()
        .getRequest<AuthenticatedRequest>().identity;
      this.logger.error(
        `Onboarding commit outcome is unknown for subject ${subject}.`,
        exception.cause instanceof Error
          ? exception.cause.stack
          : String(exception.cause),
      );
      void reply.header('retry-after', String(RETRY_AFTER_SECONDS));
      return sendProblem(reply, {
        type: PROBLEM_TYPES.OUTCOME_UNKNOWN,
        title: 'Onboarding outcome is unknown',
        status: 503,
      });
    }
    if (
      exception instanceof BadRequestException ||
      (exception instanceof HttpException && exception.getStatus() === 400)
    ) {
      this.logger.error(
        'Request validation or parsing failed.',
        exception instanceof Error ? exception.stack : String(exception),
      );
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Bad request',
        status: 400,
      });
    }
    // Anything unclassified is a server-side defect whose detail could carry
    // connection strings or row contents, so only the log receives it.
    this.logger.error(
      'Onboarding failed unexpectedly.',
      exception instanceof Error ? exception.stack : String(exception),
    );
    return sendProblem(reply, {
      type: PROBLEM_TYPES.INTERNAL,
      title: 'Internal server error',
      status: 500,
    });
  }
}

export function registerProblemFilter(app: NestFastifyApplication): void {
  app.useGlobalFilters(new OnboardingProblemFilter());
}
