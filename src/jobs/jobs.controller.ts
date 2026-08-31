import {
  Controller,
  Get,
  Inject,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { JOB_READ_OUTCOMES, JOBS_PORT, type JobsPort } from './job.port.js';
import { validateJobId, JobQueryValidationError } from './job-query.js';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';

@Controller('v1/jobs')
@UseGuards(JwtAuthGuard)
export class JobsController {
  public constructor(
    @Inject(JOBS_PORT)
    private readonly jobsPort: JobsPort,
  ) {}

  @Get(':jobId')
  public async getJob(
    @Param('jobId') rawJobId: string,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const header = parseWorkspaceHeader(request.headers['x-workspace-id']);
    if (header.kind !== 'ok') {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid X-Workspace-Id header',
        status: 400,
      });
      return;
    }

    let jobId: string;
    try {
      jobId = validateJobId(rawJobId);
    } catch (error) {
      if (error instanceof JobQueryValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid job identifier',
          status: 400,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }

    const outcome = await this.jobsPort.getJob(
      request.identity.subject,
      header.workspaceId,
      jobId,
    );

    if (outcome.kind === JOB_READ_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    if (outcome.kind === JOB_READ_OUTCOMES.NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Job not found',
        status: 404,
      });
      return;
    }

    void reply.status(200).send(outcome.job);
  }
}
