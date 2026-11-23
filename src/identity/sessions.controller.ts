import {
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { encodeCursor } from '../platform/cursor.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { parseListQuery } from '../platform/list-query.js';
import {
  PostgresSessionStore,
  SessionStatusUnavailableError,
} from '../platform/postgres-session.store.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { SessionOnlyProblemFilter } from './session-only-problem.filter.js';

@Controller('v1/me/sessions')
@UseGuards(JwtAuthGuard)
@UseFilters(SessionOnlyProblemFilter)
export class SessionsController {
  public constructor(private readonly sessions: PostgresSessionStore) {}

  @Get()
  public async list(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Query('cursor') cursorParam?: string,
    @Query('limit') limitParam?: string,
  ): Promise<void> {
    const { subject, sessionId } = requireSession(request);
    const query = parseListQuery({
      ...(cursorParam === undefined ? {} : { cursorParam }),
      ...(limitParam === undefined ? {} : { limitParam }),
    });
    if (query.violations.length > 0) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid sessions query',
        status: 400,
        errors: query.violations,
      });
      return;
    }
    try {
      const rows = await this.sessions.list(
        subject,
        sessionId,
        query.cursor,
        query.limit + 1,
      );
      const page = rows.slice(0, query.limit);
      const hasNextPage = rows.length > query.limit;
      const last = page.at(-1);
      void reply.status(200).send({
        items: page.map((row) => ({
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          lastActiveAt: row.lastActiveAt.toISOString(),
          ...(row.userAgent === null ? {} : { userAgent: row.userAgent }),
          current: row.id === sessionId,
        })),
        pageInfo: {
          hasNextPage,
          nextCursor:
            hasNextPage && last
              ? encodeCursor({ id: last.id, createdAt: last.cursorAt })
              : null,
        },
      });
    } catch {
      throw new SessionStatusUnavailableError();
    }
  }

  @Post('revoke-others')
  public async revokeOthers(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { subject, sessionId } = requireSession(request);
    let active: boolean;
    try {
      active = await this.sessions.revokeOthers(subject, sessionId);
    } catch {
      throw new SessionStatusUnavailableError();
    }
    if (!active) throw new UnauthorizedException();
    void reply.status(204).send();
  }
}

function requireSession(request: AuthenticatedRequest) {
  if (request.identity.authMethod !== 'session' || !request.identity.sessionId)
    throw new UnauthorizedException();
  return {
    subject: request.identity.subject,
    sessionId: request.identity.sessionId,
  };
}
