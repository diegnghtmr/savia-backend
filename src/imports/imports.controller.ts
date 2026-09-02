import {
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import {
  IMPORT_OUTCOMES,
  IMPORTS_PORT,
  type ImportsPort,
} from './import.port.js';
import { validateFormatHint } from './import-command.js';
import { validateImportJobId } from './import-query.js';
@Controller('v1/import-jobs')
@UseGuards(JwtAuthGuard)
export class ImportsController {
  public constructor(
    @Inject(IMPORTS_PORT) private readonly port: ImportsPort,
  ) {}
  @Post() public async create(
    @Req() request: AuthenticatedRequest & FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const h = parseWorkspaceHeader(request.headers['x-workspace-id']);
    const k = validateIdempotencyKey(request.headers['idempotency-key']);
    if (h.kind !== 'ok' || k.kind !== 'ok')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid import headers',
        status: 400,
      });
    let fileName = '';
    let bytes: Buffer | undefined;
    let hint = null;
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || bytes)
            throw new Error('Only one file part named file is allowed.');
          fileName = part.filename;
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) chunks.push(Buffer.from(chunk));
          if (part.file.truncated)
            throw new Error('The uploaded file exceeds the maximum size.');
          bytes = Buffer.concat(chunks);
        } else if (part.fieldname === 'formatHint')
          hint = validateFormatHint(part.value);
        else throw new Error('Only file and formatHint parts are allowed.');
      }
      if (!bytes || !fileName) throw new Error('file is required.');
    } catch (error) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Import upload rejected',
        status: 422,
        detail:
          error instanceof Error
            ? error.message
            : 'The multipart upload is invalid.',
      });
    }
    const outcome = await this.port.createImportJob(
      request.identity.subject,
      h.workspaceId,
      { fileName, bytes, formatHint: hint },
      k.key,
    );
    if (outcome.kind === IMPORT_OUTCOMES.FORBIDDEN)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    if (outcome.kind === IMPORT_OUTCOMES.CONFLICT)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
    if (outcome.kind === IMPORT_OUTCOMES.FAILED)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Import analysis failed',
        status: 422,
        detail: outcome.detail,
      });
    if (outcome.kind === IMPORT_OUTCOMES.REPLAYED)
      return void reply.status(outcome.status).send(outcome.body);
    void reply.status(202).send(outcome.job);
  }
  @Get(':importJobId') public async get(
    @Param('importJobId') raw: string,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const h = parseWorkspaceHeader(request.headers['x-workspace-id']);
    if (h.kind !== 'ok')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid X-Workspace-Id header',
        status: 400,
      });
    let id: string;
    try {
      id = validateImportJobId(raw);
    } catch (error) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid import job identifier',
        status: 400,
        detail: error instanceof Error ? error.message : undefined,
      });
    }
    const outcome = await this.port.getImportJob(
      request.identity.subject,
      h.workspaceId,
      id,
    );
    if (outcome.kind === 'forbidden')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    if (outcome.kind === 'not-found')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Import job not found',
        status: 404,
      });
    void reply.status(200).send(outcome.job);
  }
}
