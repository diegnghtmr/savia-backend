import {
  Controller,
  Get,
  Injectable,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import {
  TRANSIENT_NETWORK_CODES,
  TRANSIENT_SQLSTATES,
  errorHasSqlstate,
} from '../platform/job-retry-policy.js';
import { JoseJwtVerifier } from '../platform/jose-jwt-verifier.js';
import { TransactionTimeoutError } from '../platform/pg-transaction.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';
import { WorkspaceBackupService } from './workspace-backup.service.js';

@Injectable()
class BackupSessionGuard implements CanActivate {
  public constructor(private readonly verifier: JoseJwtVerifier) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = /^Bearer ([^\s]+)$/.exec(
      request.headers.authorization ?? '',
    )?.[1];
    if (!token || token.startsWith('svt_')) throw new UnauthorizedException();
    try {
      const identity = await this.verifier.verify(token);
      if (
        identity.authMethod !== 'session' ||
        !UUID_PATTERN.test(identity.subject)
      ) {
        throw new UnauthorizedException();
      }
      request.identity = identity;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}

function badRequest(reply: FastifyReply, title: string, detail?: string) {
  sendProblem(reply, {
    type: PROBLEM_TYPES.BAD_REQUEST,
    title,
    status: 400,
    detail,
  });
}

function readWorkspace(req: AuthenticatedRequest, reply: FastifyReply) {
  const header = parseWorkspaceHeader(req.headers['x-workspace-id']);
  if (header.kind === 'ok') return header.workspaceId;
  badRequest(reply, 'Invalid X-Workspace-Id header');
  return undefined;
}

function forbidden(reply: FastifyReply) {
  sendProblem(reply, {
    type: PROBLEM_TYPES.FORBIDDEN,
    title: 'Workspace access forbidden',
    status: 403,
  });
}

const UNAVAILABLE_CODES = [
  ...TRANSIENT_NETWORK_CODES,
  ...TRANSIENT_SQLSTATES,
  '57P01',
  '57P03',
  '53300',
];

function unavailable(reply: FastifyReply, error: unknown) {
  if (
    !(error instanceof TransactionTimeoutError) &&
    !UNAVAILABLE_CODES.some((code) => errorHasSqlstate(error, code))
  ) {
    throw error;
  }
  void reply.header('retry-after', '5');
  sendProblem(reply, {
    type: PROBLEM_TYPES.DEPENDENCY_UNAVAILABLE,
    title: 'Backup service temporarily unavailable',
    status: 503,
  });
}

@Controller('v1/backup-jobs')
@UseGuards(BackupSessionGuard)
export class WorkspaceBackupController {
  public constructor(private readonly service: WorkspaceBackupService) {}

  @Post()
  public async create(
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const workspace = readWorkspace(req, reply);
    if (!workspace) return;
    const key = validateIdempotencyKey(req.headers['idempotency-key']);
    if (key.kind !== 'ok') {
      return badRequest(reply, 'Invalid Idempotency-Key header', key.reason);
    }
    if (req.body !== undefined || Object.keys(req.query ?? {}).length) {
      return badRequest(
        reply,
        'Workspace backup does not accept a body or filters',
      );
    }
    try {
      const outcome = await this.service.create(
        req.identity.subject,
        workspace,
        key.key.toLowerCase(),
      );
      if (outcome.kind === 'forbidden') return forbidden(reply);
      if (outcome.kind === 'conflict') {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.CONFLICT,
          title: 'Idempotency key reused with different payload',
          status: 409,
        });
      }
      void reply.status(202).send(outcome.body);
    } catch (error) {
      unavailable(reply, error);
    }
  }

  @Get(':backupJobId')
  public async get(
    @Param('backupJobId') id: string,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    void reply.header('cache-control', 'no-store');
    const workspace = readWorkspace(req, reply);
    if (!workspace) return;
    if (!UUID_PATTERN.test(id)) {
      return badRequest(reply, 'Invalid backup job identifier');
    }
    try {
      const outcome = await this.service.get(
        req.identity.subject,
        workspace,
        id.toLowerCase(),
      );
      if (outcome.kind === 'forbidden') return forbidden(reply);
      if (outcome.kind === 'not-found') {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.NOT_FOUND,
          title: 'Backup job not found',
          status: 404,
        });
      }
      void reply.status(200).send(outcome.body);
    } catch (error) {
      unavailable(reply, error);
    }
  }
}
