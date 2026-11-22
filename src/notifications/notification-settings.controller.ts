import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { parseIfMatch } from '../platform/if-match.js';
import {
  TRANSIENT_NETWORK_CODES,
  TRANSIENT_SQLSTATES,
} from '../platform/job-retry-policy.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { TransactionTimeoutError } from '../platform/pg-transaction.js';
import { PostgresConfigurationError } from '../platform/postgres-config.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import { NotificationSettingsService } from './notification-settings.service.js';
import {
  parseNotificationPreferences,
  parsePushDeviceRequest,
} from './notification-settings.js';

const preconditionFailed = {
  type: PROBLEM_TYPES.PRECONDITION_FAILED,
  title: 'Precondition failed',
  status: 412,
};

@Controller('v1/me')
@UseGuards(JwtAuthGuard)
export class NotificationSettingsController {
  public constructor(
    @Inject(NotificationSettingsService)
    private readonly settings: NotificationSettingsService,
  ) {}

  @Get('notification-preferences')
  public async get(
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ) {
    await this.respond(reply, async () => {
      const result = await this.settings.read(req.identity.subject);
      void reply
        .header('ETag', result.etag)
        .status(200)
        .send(result.preferences);
    });
  }

  @Put('notification-preferences')
  public async put(
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Body() body: unknown,
  ) {
    const key = validateIdempotencyKey(req.headers['idempotency-key']);
    if (key.kind === 'invalid')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid Idempotency-Key header',
        status: 400,
        detail: key.reason,
      });
    const preferences = parseNotificationPreferences(body);
    if (preferences === undefined)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid notification preferences',
        status: 400,
      });
    const ifMatch = parseIfMatch(req.headers['if-match']);
    if (ifMatch.kind === 'malformed')
      return sendProblem(reply, preconditionFailed);

    await this.respond(reply, async () => {
      const result = await this.settings.replace(
        req.identity.subject,
        preferences,
        key.key,
        ifMatch,
      );
      switch (result.kind) {
        case 'ok':
          void reply
            .header('ETag', result.etag)
            .status(200)
            .send(result.preferences);
          return;
        case 'stale':
          return sendProblem(reply, preconditionFailed);
        case 'conflict':
          return sendProblem(reply, {
            type: PROBLEM_TYPES.CONFLICT,
            title: 'Idempotency conflict',
            status: 409,
          });
        case 'invalid_quiet_hours':
          return sendProblem(reply, {
            type: PROBLEM_TYPES.UNPROCESSABLE,
            title: 'Invalid quiet hours',
            status: 422,
          });
      }
    });
  }

  @Post('push-devices')
  public async register(
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Body() body: unknown,
  ) {
    const request = parsePushDeviceRequest(body);
    if (request === undefined)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid push device registration',
        status: 400,
      });
    await this.respond(reply, async () => {
      const result = await this.settings.registerDevice(
        req.identity.subject,
        request,
      );
      if (result === undefined)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.CONFLICT,
          title: 'Push device already registered',
          status: 409,
        });
      void reply
        .status(result.created ? 201 : 200)
        .send({ deviceId: result.deviceId });
    });
  }

  @Delete('push-devices/:deviceId')
  public async unregister(
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Param('deviceId') id: string,
  ) {
    if (!UUID_PATTERN.test(id))
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid identifier parameter',
        status: 400,
      });
    await this.respond(reply, async () => {
      if (!(await this.settings.removeDevice(req.identity.subject, id))) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.NOT_FOUND,
          title: 'Push device not found',
          status: 404,
        });
      }
      void reply.status(204).send();
    });
  }

  private async respond(
    reply: FastifyReply,
    action: () => Promise<void>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error ? String(error.code) : '';
      if (
        !(error instanceof TransactionTimeoutError) &&
        !(error instanceof PostgresConfigurationError) &&
        !TRANSIENT_NETWORK_CODES.has(code) &&
        !TRANSIENT_SQLSTATES.has(code) &&
        !/^08[\dA-Z]{3}$/.test(code) &&
        !['57P01', '57P02', '57P03', '53300'].includes(code)
      )
        throw error;
      void reply.header('Retry-After', '5');
      sendProblem(reply, {
        type: PROBLEM_TYPES.DEPENDENCY_UNAVAILABLE,
        title: 'Notification settings unavailable',
        status: 503,
      });
    }
  }
}
