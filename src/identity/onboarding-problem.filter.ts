import {
  type ArgumentsHost,
  BadRequestException,
  Catch,
  type ExceptionFilter,
  ForbiddenException,
  HttpException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply } from 'fastify';

import { BootstrapCommandValidationError } from './bootstrap-command.js';
import { CommitOutcomeUnknownError } from '../platform/pg-transaction.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';

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
    if (exception instanceof ForbiddenException)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Forbidden',
        status: 403,
      });
    if (exception instanceof CommitOutcomeUnknownError) {
      // Log only fixed codes; subjects and underlying errors can contain private input.
      this.logger.error('outcome-unknown');
      void reply.header('retry-after', String(RETRY_AFTER_SECONDS));
      return sendProblem(reply, {
        type: PROBLEM_TYPES.OUTCOME_UNKNOWN,
        title: 'Operation outcome is unknown',
        status: 503,
      });
    }
    if (
      exception instanceof BadRequestException ||
      (exception instanceof HttpException && exception.getStatus() === 400)
    ) {
      this.logger.error('bad-request');
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Bad request',
        status: 400,
      });
    }
    this.logger.error('internal');
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
