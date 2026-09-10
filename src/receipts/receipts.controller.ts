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
import { UUID_PATTERN } from '../platform/uuid.js';
import { ArtifactStorageUnavailableError } from '../platform/artifact-storage.port.js';
import {
  createTransactionCommand,
  TransactionCommandValidationError,
} from '../ledger/transaction-command.js';
import {
  RECEIPT_OUTCOMES,
  RECEIPT_PROCESSING_PREFERENCES,
  RECEIPTS_PORT,
  type ReceiptCreateOutcome,
  type ReceiptsPort,
} from './receipt.port.js';
import {
  parseDeviceOcrResult,
  parseProcessingPreference,
  ReceiptCommandValidationError,
} from './receipt-command.js';

const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const MAX_FILENAME_LENGTH = 255;

@Controller('v1/receipts')
@UseGuards(JwtAuthGuard)
export class ReceiptsController {
  public constructor(
    @Inject(RECEIPTS_PORT) private readonly port: ReceiptsPort,
  ) {}

  @Post()
  public async create(
    @Req() request: AuthenticatedRequest & FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const header = parseWorkspaceHeader(request.headers['x-workspace-id']);
    const key = validateIdempotencyKey(request.headers['idempotency-key']);
    if (header.kind !== 'ok' || key.kind !== 'ok')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid receipt headers',
        status: 400,
      });
    let fileName = '';
    let contentType = '';
    let bytes: Buffer | undefined;
    let preference: unknown;
    let ocr: unknown;
    let parsedPreference: (typeof RECEIPT_PROCESSING_PREFERENCES)[keyof typeof RECEIPT_PROCESSING_PREFERENCES];
    let parsedOcr: Record<string, unknown> | null;
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || bytes)
            throw new Error('Only one file part named file is allowed.');
          fileName = part.filename;
          if (
            fileName.length === 0 ||
            fileName.length > MAX_FILENAME_LENGTH ||
            containsControlCharacter(fileName)
          )
            throw new Error(
              'Filename must be 1-255 characters without control characters.',
            );
          contentType = part.mimetype;
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) chunks.push(Buffer.from(chunk));
          if (part.file.truncated)
            throw new Error('The uploaded file exceeds the maximum size.');
          bytes = Buffer.concat(chunks);
        } else if (part.fieldname === 'processingPreference')
          preference = part.value;
        else if (part.fieldname === 'deviceOcrResult') ocr = part.value;
        else throw new Error(`Unexpected multipart field: ${part.fieldname}`);
      }
      if (!bytes || !fileName) throw new Error('file is required.');
      if (!ALLOWED_CONTENT_TYPES.has(contentType))
        throw new Error('Only PDF, JPEG, PNG, and WebP files are accepted.');
      parsedPreference = parseProcessingPreference(preference);
      parsedOcr = parseDeviceOcrResult(ocr);
      if (
        parsedPreference === RECEIPT_PROCESSING_PREFERENCES.DEVICE_RESULT &&
        parsedOcr === null
      )
        throw new Error('deviceOcrResult is required for device_result.');
      if (
        parsedPreference !== RECEIPT_PROCESSING_PREFERENCES.DEVICE_RESULT &&
        parsedOcr !== null
      )
        throw new Error('deviceOcrResult is only allowed with device_result.');
    } catch (error) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Receipt upload rejected',
        status: 422,
        detail: error instanceof Error ? error.message : undefined,
      });
    }
    let outcome: ReceiptCreateOutcome;
    try {
      outcome = await this.port.createReceipt(
        request.identity.subject,
        header.workspaceId,
        {
          fileName,
          contentType,
          bytes,
          processingPreference: parsedPreference,
          deviceOcrResult: parsedOcr,
        },
        key.key,
      );
    } catch (error) {
      if (error instanceof ArtifactStorageUnavailableError) {
        void reply.header('retry-after', '5');
        return sendProblem(reply, {
          type: PROBLEM_TYPES.DEPENDENCY_UNAVAILABLE,
          title: 'Artifact storage is temporarily unavailable',
          status: 503,
        });
      }
      throw error;
    }
    if (outcome.kind === RECEIPT_OUTCOMES.FORBIDDEN)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    if (outcome.kind === RECEIPT_OUTCOMES.CONFLICT)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
    if (outcome.kind === RECEIPT_OUTCOMES.NOT_FOUND)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Receipt not found',
        status: 404,
      });
    if (outcome.kind === RECEIPT_OUTCOMES.TRANSACTION_REPLAYED)
      return void reply.status(outcome.status).send(outcome.body);
    return void reply.status(202).send(outcome.receipt);
  }

  @Get(':receiptId')
  public async get(
    @Param('receiptId') id: string,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const header = parseWorkspaceHeader(request.headers['x-workspace-id']);
    if (header.kind !== 'ok' || !UUID_PATTERN.test(id))
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid receipt request',
        status: 400,
      });
    const outcome = await this.port.getReceipt(
      request.identity.subject,
      header.workspaceId,
      id,
    );
    if (outcome.kind === RECEIPT_OUTCOMES.FORBIDDEN)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    if (outcome.kind === RECEIPT_OUTCOMES.NOT_FOUND)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Receipt not found',
        status: 404,
      });
    void reply.status(200).send(outcome.receipt);
  }

  @Post(':receiptId/confirm')
  public async confirm(
    @Param('receiptId') id: string,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const header = parseWorkspaceHeader(request.headers['x-workspace-id']);
    const key = validateIdempotencyKey(request.headers['idempotency-key']);
    if (header.kind !== 'ok' || key.kind !== 'ok' || !UUID_PATTERN.test(id))
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid receipt confirmation request',
        status: 400,
      });
    try {
      const body = (request as FastifyRequest & { body: unknown }).body;
      if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
        const violations = Object.keys(body)
          .filter((key) => key !== 'transaction')
          .map((key) => ({
            field: key,
            code: 'not-allowed',
            message: 'is not allowed',
          }));
        if (violations.length)
          throw new TransactionCommandValidationError(violations);
      }
      const transactionBody =
        typeof body === 'object' && body !== null && 'transaction' in body
          ? (body as Record<string, unknown>).transaction
          : undefined;
      const command = createTransactionCommand(transactionBody);
      const outcome = await this.port.confirmReceipt(
        request.identity.subject,
        header.workspaceId,
        id,
        command,
        key.key,
      );
      if (outcome.kind === RECEIPT_OUTCOMES.FORBIDDEN)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.FORBIDDEN,
          title: 'Workspace access forbidden',
          status: 403,
        });
      if (outcome.kind === RECEIPT_OUTCOMES.NOT_FOUND)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.NOT_FOUND,
          title: 'Receipt not found',
          status: 404,
        });
      if (outcome.kind === RECEIPT_OUTCOMES.CONFLICT)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.CONFLICT,
          title: 'Receipt confirmation conflict',
          status: 409,
        });
      if (outcome.kind === RECEIPT_OUTCOMES.TRANSACTION_INVALID)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Transaction validation failed',
          status: 422,
        });
      if (outcome.kind === RECEIPT_OUTCOMES.TRANSACTION_REPLAYED)
        return void reply.status(outcome.status).send(outcome.body);
      void reply.status(201).send(outcome.transaction);
    } catch (error) {
      if (
        error instanceof TransactionCommandValidationError ||
        error instanceof ReceiptCommandValidationError
      )
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Receipt confirmation validation failed',
          status: 422,
          errors: error.violations,
        });
      throw error;
    }
  }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}
