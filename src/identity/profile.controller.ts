import { Controller, Get, Inject, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { AuthenticatedRequest } from './authenticated-request.js';
import { PROBLEM_TYPES, sendProblem } from './problem-details.js';
import { PROFILE_PORT, type ProfilePort } from './profile.port.js';
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
}
