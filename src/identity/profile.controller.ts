import {
  Body,
  Controller,
  Get,
  Inject,
  Patch,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { AuthenticatedRequest } from './authenticated-request.js';
import { PROBLEM_TYPES, sendProblem } from './problem-details.js';
import {
  PROFILE_PORT,
  PROFILE_UPDATE_OUTCOMES,
  type ProfilePort,
} from './profile.port.js';
import {
  createProfileUpdateCommand,
  ProfileUpdateValidationError,
  type ProfileUpdateCommand,
} from './profile-update-command.js';
import { parseIfMatch } from './if-match.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

@Controller('v1/me')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  public constructor(
    @Inject(PROFILE_PORT) private readonly profile: ProfilePort,
  ) {}

  @Get()
  public async getProfile(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const userProfile = await this.profile.read(request.identity.subject);
    if (userProfile === undefined) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Profile not found',
        status: 404,
      });
      return;
    }
    void reply.status(200).send(userProfile);
  }

  @Patch()
  public async updateProfile(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<void> {
    let command: ProfileUpdateCommand;
    try {
      command = createProfileUpdateCommand(body);
    } catch (error) {
      if (error instanceof ProfileUpdateValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Unprocessable entity',
          status: 422,
          errors: error.violations,
        });
        return;
      }
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Bad request',
        status: 400,
      });
      return;
    }

    const ifMatch = parseIfMatch(request.headers['if-match']);
    if (ifMatch.kind === 'malformed') {
      sendProblem(reply, {
        type: PROBLEM_TYPES.PRECONDITION_FAILED,
        title: 'Precondition failed',
        status: 412,
      });
      return;
    }

    // RFC 9110 makes `*` false when no current representation exists, which
    // would be a 412. This route answers 404 there instead, deliberately:
    // the resource identity is the authenticated subject, so "you have no
    // profile" is the actual problem, while 412 would invite a retry with a
    // fresh validator that will never exist.
    const expectedVersion =
      ifMatch.kind === 'version' ? ifMatch.version : undefined;

    const outcome = await this.profile.update(
      request.identity.subject,
      command,
      expectedVersion,
    );

    if (outcome.kind === PROFILE_UPDATE_OUTCOMES.OK) {
      void reply
        .header('ETag', `"${outcome.version}"`)
        .status(200)
        .send(outcome.profile);
      return;
    }

    if (outcome.kind === PROFILE_UPDATE_OUTCOMES.NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Profile not found',
        status: 404,
      });
      return;
    }

    if (outcome.kind === PROFILE_UPDATE_OUTCOMES.VERSION_CONFLICT) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.PRECONDITION_FAILED,
        title: 'Precondition failed',
        status: 412,
      });
      return;
    }
  }
}
