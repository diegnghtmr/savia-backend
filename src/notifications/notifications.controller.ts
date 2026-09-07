import {
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import {
  NOTIFICATION_OUTCOMES,
  NOTIFICATION_PORT,
  type NotificationPort,
} from './notification.port.js';
import {
  createNotificationListQuery,
  NotificationQueryValidationError,
} from './notification-query.js';

@Controller('v1/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  public constructor(
    @Inject(NOTIFICATION_PORT) private readonly port: NotificationPort,
  ) {}

  @Get()
  public async listNotifications(
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Query('cursor') cursorParam?: string,
    @Query('limit') limitParam?: string,
    @Query('unreadOnly') unreadOnlyParam?: string,
  ): Promise<void> {
    let query;
    try {
      query = createNotificationListQuery(req.identity.subject, {
        cursorParam,
        limitParam,
        unreadOnlyParam,
      });
    } catch (error) {
      if (error instanceof NotificationQueryValidationError) {
        // Contract gap: status 400 is emitted at runtime for invalid query parameters,
        // but undeclared in upstream OpenAPI for listNotifications.
        sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid notification list query',
          status: 400,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }

    const outcome = await this.port.listNotifications(
      req.identity.subject,
      query,
    );

    void reply.status(200).send(outcome.page);
  }

  @Post(':notificationId/read')
  public async markNotificationRead(
    @Param('notificationId') notificationId: string,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const keyResult = validateIdempotencyKey(req.headers['idempotency-key']);
    if (keyResult.kind !== 'ok') {
      // Contract gap: status 400 is emitted at runtime for invalid Idempotency-Key header,
      // but undeclared in upstream OpenAPI for markNotificationRead.
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid Idempotency-Key header',
        detail: keyResult.reason,
        status: 400,
      });
      return;
    }

    if (!UUID_PATTERN.test(notificationId)) {
      // Contract gap: status 400 is emitted at runtime for malformed UUID notificationId parameter,
      // but undeclared in upstream OpenAPI for markNotificationRead.
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid identifier parameter',
        status: 400,
      });
      return;
    }

    const outcome = await this.port.markNotificationRead(
      req.identity.subject,
      notificationId.toLowerCase(),
      keyResult.key,
    );

    if (
      outcome.kind === NOTIFICATION_OUTCOMES.NO_CONTENT ||
      outcome.kind === NOTIFICATION_OUTCOMES.REPLAYED
    ) {
      void reply.status(204).send();
      return;
    }

    if (outcome.kind === NOTIFICATION_OUTCOMES.NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Notification not found',
        status: 404,
      });
      return;
    }

    if (outcome.kind === NOTIFICATION_OUTCOMES.CONFLICT) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency conflict',
        status: 409,
      });
      return;
    }
  }
}
