import {
  Body,
  Controller,
  ForbiddenException,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import {
  CliDeviceCommandValidationError,
  createCliDeviceAuthorizationCommand,
} from './cli-device-command.js';
import {
  CliDeviceTokenCommandValidationError,
  createCliDeviceTokenCommand,
} from './cli-device-token-command.js';
import { CLI_DEVICE_PORT, type CliDevicePort } from './cli-device.port.js';
import {
  CliDeviceApprovalCommandValidationError,
  createCliDeviceApprovalCommand,
} from './cli-device-approval-command.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';

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
  @Post('token')
  public async token(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    try {
      const result = await this.port.poll(
        createCliDeviceTokenCommand(body),
        request.ip,
      );
      if ('kind' in result && result.kind === 'rate_limited') {
        reply.header('Retry-After', 5);
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Rate limit exceeded',
          status: 429,
        });
      }
      if ('kind' in result && result.kind === 'invalid')
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Authorization is pending, denied or expired.',
          status: 400,
        });
      await reply.status(200).send(result);
    } catch (error) {
      if (error instanceof CliDeviceTokenCommandValidationError)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'CLI device token validation failed',
          status: 400,
          errors: error.violations,
        });
      throw error;
    }
  }
  @Post('approve')
  @UseGuards(JwtAuthGuard)
  public async approve(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (request.identity.authMethod === 'cli_token')
      throw new ForbiddenException();
    try {
      const result = await this.port.approve(
        request.identity.subject,
        createCliDeviceApprovalCommand(body),
      );
      if (result.kind === 'rate_limited') {
        reply.header('Retry-After', result.retryAfter);
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Rate limit exceeded',
          status: 429,
        });
      }
      if (result.kind === 'invalid')
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'The user code is invalid or expired.',
          status: 400,
        });
      await reply.status(204).send();
    } catch (error) {
      if (error instanceof CliDeviceApprovalCommandValidationError)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'CLI device approval validation failed',
          status: 400,
          errors: error.violations,
        });
      throw error;
    }
  }
}
