import {
  Controller,
  Inject,
  Logger,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { createBootstrapCommand } from './bootstrap-command.js';
import {
  BOOTSTRAP_CONFLICT_KINDS,
  BOOTSTRAP_PORT,
  BOOTSTRAP_RESULT_KINDS,
  type BootstrapPort,
} from './bootstrap.port.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { OnboardingProblemFilter } from './onboarding-problem.filter.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { IDENTITY_PROBLEM_TYPES } from './identity-problem-types.js';

const SUCCESS_STATUS = {
  [BOOTSTRAP_RESULT_KINDS.CREATED]: 201,
  [BOOTSTRAP_RESULT_KINDS.REPLAYED]: 200,
} as const;

@Controller('v1/onboarding')
@UseGuards(JwtAuthGuard)
@UseFilters(OnboardingProblemFilter)
export class OnboardingController {
  private readonly logger = new Logger(OnboardingController.name);

  public constructor(
    @Inject(BOOTSTRAP_PORT) private readonly bootstrap: BootstrapPort,
  ) {}

  @Post()
  public async onboard(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const command = createBootstrapCommand(
      request.identity.subject,
      request.body,
    );
    const outcome = await this.bootstrap.execute(command);
    if (
      outcome.kind === BOOTSTRAP_RESULT_KINDS.CREATED ||
      outcome.kind === BOOTSTRAP_RESULT_KINDS.REPLAYED
    ) {
      void reply.status(SUCCESS_STATUS[outcome.kind]).send(outcome.aggregate);
      return;
    }
    if (outcome.kind === BOOTSTRAP_CONFLICT_KINDS.DIFFERENT_REQUEST) {
      sendProblem(reply, {
        type: IDENTITY_PROBLEM_TYPES.ONBOARDING_CONFLICT,
        title: 'Onboarding already exists with different data',
        status: 409,
      });
      return;
    }
    // A partial aggregate is a server-side defect the client cannot act on, so
    // the diagnosis stays in the log and never reaches the response body.
    this.logger.error(
      `Onboarding stopped on an ${outcome.kind} for subject ${command.subject}.`,
    );
    sendProblem(reply, {
      type: PROBLEM_TYPES.INTERNAL,
      title: 'Internal server error',
      status: 500,
    });
  }
}
