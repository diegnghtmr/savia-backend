import {
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import {
  CATALOGS_PORT,
  CATALOG_CREATE_OUTCOMES,
  CATALOG_LIST_OUTCOMES,
  type CatalogsPort,
  type CategoryListQuery,
  type CreateCategoryCommand,
} from './catalogs.port.js';
import {
  createCategoryCommand,
  CatalogCommandValidationError,
} from './catalog-command.js';
import {
  createCategoryListQuery,
  CatalogQueryValidationError,
} from './catalog-query.js';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';

@Controller('v1/categories')
@UseGuards(JwtAuthGuard)
export class CategoriesController {
  public constructor(
    @Inject(CATALOGS_PORT)
    private readonly catalogsPort: CatalogsPort,
  ) {}

  @Post()
  public async createCategory(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const header = parseWorkspaceHeader(request.headers['x-workspace-id']);
    if (header.kind !== 'ok') {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid X-Workspace-Id header',
        status: 400,
      });
      return;
    }

    const keyResult = validateIdempotencyKey(
      request.headers['idempotency-key'],
    );
    if (keyResult.kind !== 'ok') {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid Idempotency-Key header',
        detail: keyResult.reason,
        status: 400,
      });
      return;
    }

    let command: CreateCategoryCommand;
    try {
      command = createCategoryCommand(request.body);
    } catch (error) {
      if (error instanceof CatalogCommandValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Category create validation failed',
          status: 422,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }

    const outcome = await this.catalogsPort.createCategory(
      request.identity.subject,
      header.workspaceId,
      command,
      keyResult.key,
    );

    if (outcome.kind === CATALOG_CREATE_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    if (outcome.kind === CATALOG_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
      return;
    }

    if (outcome.kind === CATALOG_CREATE_OUTCOMES.CONFLICT) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Category with this name already exists in the workspace',
        status: 409,
      });
      return;
    }

    if (outcome.kind === CATALOG_CREATE_OUTCOMES.PARENT_NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Parent category not found',
        detail:
          'The specified parent category was not found in this workspace.',
        status: 422,
      });
      return;
    }

    if (outcome.kind === CATALOG_CREATE_OUTCOMES.REPLAYED) {
      let r = reply.status(outcome.status);
      if (outcome.etag) {
        r = r.header('etag', outcome.etag);
      }
      void r.send(outcome.body);
      return;
    }

    // createCategory has NO ETag response header
    void reply.status(201).send(outcome.category);
  }

  @Get()
  public async listCategories(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Query('cursor') cursorParam?: string,
    @Query('limit') limitParam?: string,
  ): Promise<void> {
    const header = parseWorkspaceHeader(request.headers['x-workspace-id']);
    if (header.kind !== 'ok') {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid X-Workspace-Id header',
        status: 400,
      });
      return;
    }

    let query: CategoryListQuery;
    try {
      query = createCategoryListQuery({
        workspaceId: header.workspaceId,
        ...(cursorParam === undefined ? {} : { cursorParam }),
        ...(limitParam === undefined ? {} : { limitParam }),
      });
    } catch (error) {
      if (error instanceof CatalogQueryValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid list categories query',
          status: 400,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }

    const outcome = await this.catalogsPort.listCategories(
      request.identity.subject,
      query,
    );

    if (outcome.kind === CATALOG_LIST_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    void reply.status(200).send(outcome.page);
  }
}
