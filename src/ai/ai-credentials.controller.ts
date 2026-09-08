import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { parseIfMatch } from '../platform/if-match.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import {
  isUuid,
  createCredentialCommand,
  setDefaultModelCommand,
  updateCredentialCommand,
  AICredentialValidationError,
} from './ai-credential-command.js';
import {
  AI_CREDENTIALS_PORT,
  AI_OUTCOMES,
  type AIServicePort,
} from './ai-credential.port.js';
@Controller('v1/ai')
@UseGuards(JwtAuthGuard)
export class AICredentialsController {
  public constructor(
    @Inject(AI_CREDENTIALS_PORT) private readonly service: AIServicePort,
  ) {}
  @Get('providers') public providers(
    @Req() q: AuthenticatedRequest,
    @Res() r: FastifyReply,
  ) {
    if (parseWorkspaceHeader(q.headers['x-workspace-id']).kind !== 'ok')
      return sendProblem(r, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    void r.status(200).send(this.service.listProviders());
  }
  @Get('credentials') public async list(
    @Req() q: AuthenticatedRequest,
    @Res() r: FastifyReply,
  ) {
    const w = parseWorkspaceHeader(q.headers['x-workspace-id']);
    if (w.kind !== 'ok')
      return sendProblem(r, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    void r
      .status(200)
      .send(
        await this.service.listCredentials(q.identity.subject, w.workspaceId),
      );
  }
  @Post('credentials') public async create(
    @Req() q: AuthenticatedRequest,
    @Body() b: unknown,
    @Res() r: FastifyReply,
  ) {
    const w = parseWorkspaceHeader(q.headers['x-workspace-id']);
    const k = validateIdempotencyKey(q.headers['idempotency-key']);
    if (w.kind !== 'ok' || k.kind !== 'ok')
      return sendProblem(r, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    try {
      const o = await this.service.createCredential(
        q.identity.subject,
        w.workspaceId,
        createCredentialCommand(b),
        k.key,
      );
      return this.send(r, o, 201);
    } catch (e) {
      if (e instanceof AICredentialValidationError)
        return sendProblem(r, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'AI credential validation failed',
          status: 422,
          errors: e.violations,
        });
      throw e;
    }
  }
  @Patch('credentials/:id') public async update(
    @Req() q: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() b: unknown,
    @Res() r: FastifyReply,
  ) {
    const w = parseWorkspaceHeader(q.headers['x-workspace-id']);
    const k = validateIdempotencyKey(q.headers['idempotency-key']);
    const m = parseIfMatch(q.headers['if-match']);
    if (w.kind !== 'ok' || k.kind !== 'ok')
      return sendProblem(r, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    if (!isUuid(id) || m.kind !== 'versions' || m.versions.length !== 1)
      return sendProblem(r, {
        type: PROBLEM_TYPES.PRECONDITION_FAILED,
        title: 'Precondition failed',
        status: 412,
      });
    try {
      return this.send(
        r,
        await this.service.updateCredential(
          q.identity.subject,
          w.workspaceId,
          id,
          updateCredentialCommand(b),
          k.key,
          m.versions[0],
        ),
        200,
      );
    } catch (e) {
      if (e instanceof AICredentialValidationError)
        return sendProblem(r, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'AI credential validation failed',
          status: 422,
          errors: e.violations,
        });
      throw e;
    }
  }
  @Delete('credentials/:id') public async revoke(
    @Req() q: AuthenticatedRequest,
    @Param('id') id: string,
    @Res() r: FastifyReply,
  ) {
    const w = parseWorkspaceHeader(q.headers['x-workspace-id']);
    const k = validateIdempotencyKey(q.headers['idempotency-key']);
    if (w.kind !== 'ok' || k.kind !== 'ok')
      return sendProblem(r, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    if (!isUuid(id))
      return sendProblem(r, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Credential not found',
        status: 404,
      });
    const o = await this.service.revokeCredential(
      q.identity.subject,
      w.workspaceId,
      id,
      k.key,
    );
    return o.kind === AI_OUTCOMES.OK
      ? void r.status(204).send()
      : sendProblem(r, {
          type:
            o.kind === AI_OUTCOMES.CONFLICT
              ? PROBLEM_TYPES.CONFLICT
              : PROBLEM_TYPES.NOT_FOUND,
          title:
            o.kind === AI_OUTCOMES.CONFLICT
              ? 'Idempotency conflict'
              : 'Credential not found',
          status: o.kind === AI_OUTCOMES.CONFLICT ? 409 : 404,
        });
  }
  @Put('default-model') public async setDefault(
    @Req() q: AuthenticatedRequest,
    @Body() b: unknown,
    @Res() r: FastifyReply,
  ) {
    const w = parseWorkspaceHeader(q.headers['x-workspace-id']);
    const k = validateIdempotencyKey(q.headers['idempotency-key']);
    if (w.kind !== 'ok' || k.kind !== 'ok')
      return sendProblem(r, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    try {
      const x = setDefaultModelCommand(b);
      const o = await this.service.setDefaultModel(
        q.identity.subject,
        w.workspaceId,
        x.modelRef,
        x.credentialId,
        k.key,
      );
      return o.kind === AI_OUTCOMES.OK
        ? void r.status(204).send()
        : sendProblem(r, {
            type: PROBLEM_TYPES.CONFLICT,
            title: 'Default model conflicts with credential',
            status: 409,
          });
    } catch (e) {
      if (e instanceof AICredentialValidationError)
        return sendProblem(r, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Invalid default model',
          status: 422,
          errors: e.violations,
        });
      throw e;
    }
  }
  private send(
    r: FastifyReply,
    o: { kind: string; credential?: unknown },
    status: number,
  ) {
    if (o.kind === AI_OUTCOMES.CREATED || o.kind === AI_OUTCOMES.OK)
      return void r.status(status).send(o.credential);
    if (o.kind === AI_OUTCOMES.NOT_FOUND)
      return sendProblem(r, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Credential not found',
        status: 404,
      });
    if (o.kind === AI_OUTCOMES.FORBIDDEN)
      return sendProblem(r, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Credential access forbidden',
        status: 403,
      });
    if (o.kind === AI_OUTCOMES.PRECONDITION)
      return sendProblem(r, {
        type: PROBLEM_TYPES.PRECONDITION_FAILED,
        title: 'Precondition failed',
        status: 412,
      });
    return sendProblem(r, {
      type: PROBLEM_TYPES.CONFLICT,
      title: 'Credential conflict',
      status: 409,
    });
  }
}
