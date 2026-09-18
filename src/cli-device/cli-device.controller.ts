import { Body, Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import {
  CliDeviceCommandValidationError,
  createCliDeviceAuthorizationCommand,
} from './cli-device-command.js';
import { CLI_DEVICE_PORT, type CliDevicePort } from './cli-device.port.js';

@Controller('v1/cli/device')
export class CliDeviceController {
  public constructor(
    @Inject(CLI_DEVICE_PORT) private readonly port: CliDevicePort,
  ) {}
  @Post('authorize')
  public async authorize(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    try {
      const result = await this.port.authorize(
        createCliDeviceAuthorizationCommand(body),
        request.ip,
      );
      if ('kind' in result) {
        reply.header('Retry-After', result.retryAfter);
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Rate limit exceeded',
          status: 429,
        });
      }
      await reply.status(200).send(result);
    } catch (error) {
      if (error instanceof CliDeviceCommandValidationError)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'CLI device authorization validation failed',
          status: 400,
          errors: error.violations,
        });
      throw error;
    }
  }
}
