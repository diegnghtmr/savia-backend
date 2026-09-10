import { describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';
import {
  RECEIPT_OUTCOMES,
  RECEIPT_STATUSES,
  type ReceiptConfirmOutcome,
  type ReceiptCreateOutcome,
  type ReceiptGetOutcome,
  type ReceiptsPort,
  type ReceiptUploadCommand,
} from '../../src/receipts/receipt.port.js';
import { ReceiptsController } from '../../src/receipts/receipts.controller.js';
import type { CreateTransactionCommand } from '../../src/platform/ledger-writer.port.js';
import { ArtifactStorageUnavailableError } from '../../src/platform/artifact-storage.port.js';

class FakeReply {
  public statusCode = 200;
  public sentBody: unknown = null;
  public headers: Record<string, string> = {};
  public request = { id: 'test-req-id', url: '/v1/receipts' };

  public status(code: number): this {
    this.statusCode = code;
    return this;
  }

  public type(_contentType?: string): this {
    void _contentType;
    return this;
  }

  public send(payload?: unknown): this {
    this.sentBody = payload;
    return this;
  }

  public header(name: string, value: string): this {
    this.headers[name] = value;
    return this;
  }
}

class FakeReceiptsPort implements ReceiptsPort {
  public createResult: ReceiptCreateOutcome = {
    kind: RECEIPT_OUTCOMES.CREATED,
    receipt: {
      id: 'aaaaaaaa-bbbb-4000-8000-000000000001',
      status: RECEIPT_STATUSES.UPLOADED,
      fileName: 'receipt.pdf',
      processingLocation: 'savia',
      merchant: null,
      date: null,
      currency: null,
      total: null,
      transactionId: null,
      createdAt: '2026-09-07T12:00:00.000Z',
    },
  };
  public getResult: ReceiptGetOutcome = {
    kind: RECEIPT_OUTCOMES.FOUND,
    receipt: {
      id: 'aaaaaaaa-bbbb-4000-8000-000000000001',
      status: RECEIPT_STATUSES.UPLOADED,
      fileName: 'receipt.pdf',
      processingLocation: 'savia',
      merchant: null,
      date: null,
      currency: null,
      total: null,
      transactionId: null,
      createdAt: '2026-09-07T12:00:00.000Z',
    },
  };
  public confirmResult: ReceiptConfirmOutcome = {
    kind: RECEIPT_OUTCOMES.CREATED,
    transaction: {
      id: 'cccccccc-dddd-4000-8000-000000000001',
      status: 'confirmed',
      type: 'expense',
      accountId: '22222222-3333-4000-8000-000000000002',
      amount: { amountMinor: '1000', currency: 'USD' },
      occurredAt: '2026-09-07T12:00:00.000Z',
      categoryId: null,
      payeeId: null,
      description: null,
      notes: null,
      tagIds: [],
      receiptId: 'aaaaaaaa-bbbb-4000-8000-000000000001',
      reconciliationId: null,
      version: 1,
      createdAt: '2026-09-07T12:00:00.000Z',
      updatedAt: '2026-09-07T12:00:00.000Z',
    },
  };

  public createCalls: unknown[] = [];
  public getCalls: unknown[] = [];
  public confirmCalls: unknown[] = [];
  public createError: Error | null = null;

  public async createReceipt(
    subject: string,
    workspaceId: string,
    command: ReceiptUploadCommand,
    idempotencyKey: string,
  ): Promise<ReceiptCreateOutcome> {
    this.createCalls.push({ subject, workspaceId, command, idempotencyKey });
    if (this.createError) throw this.createError;
    return this.createResult;
  }

  public async getReceipt(
    subject: string,
    workspaceId: string,
    id: string,
  ): Promise<ReceiptGetOutcome> {
    this.getCalls.push({ subject, workspaceId, id });
    return this.getResult;
  }

  public async confirmReceipt(
    subject: string,
    workspaceId: string,
    id: string,
    command: CreateTransactionCommand,
    idempotencyKey: string,
  ): Promise<ReceiptConfirmOutcome> {
    this.confirmCalls.push({
      subject,
      workspaceId,
      id,
      command,
      idempotencyKey,
    });
    return this.confirmResult;
  }
}

describe('ReceiptsController', () => {
  const subject = '55555555-6666-4000-8000-000000000005';
  const workspaceId = '11111111-2222-4000-8000-000000000001';
  const receiptId = 'aaaaaaaa-bbbb-4000-8000-000000000001';
  const accountId = '22222222-3333-4000-8000-000000000002';
  const idempotencyKey = '33333333-4444-4000-8000-000000000003';

  function createValidFilePart(
    options: {
      filename?: string;
      mimetype?: string;
      fieldname?: string;
      truncated?: boolean;
      content?: Buffer;
    } = {},
  ) {
    const filename = options.filename ?? 'receipt.pdf';
    const mimetype = options.mimetype ?? 'application/pdf';
    const fieldname = options.fieldname ?? 'file';
    const truncated = options.truncated ?? false;
    const content = options.content ?? Buffer.from('pdf data');

    const fileStream = (async function* () {
      yield content;
    })();
    (fileStream as unknown as { truncated: boolean }).truncated = truncated;

    return {
      type: 'file',
      fieldname,
      filename,
      mimetype,
      file: fileStream,
    };
  }

  function createCreateRequest(
    parts: unknown[],
    headers: Record<string, string> = {},
  ): AuthenticatedRequest & FastifyRequest {
    return {
      identity: { subject },
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
        ...headers,
      },
      parts: async function* () {
        for (const part of parts) {
          yield part;
        }
      },
    } as unknown as AuthenticatedRequest & FastifyRequest;
  }

  describe('create', () => {
    it('returns 503 with Retry-After when artifact storage is unavailable', async () => {
      const port = new FakeReceiptsPort();
      port.createError = new ArtifactStorageUnavailableError(
        'Storage upload failed with status 503.',
      );
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();

      await controller.create(
        createCreateRequest([createValidFilePart()]),
        reply as unknown as FastifyReply,
      );

      expect(reply.statusCode).toBe(503);
      expect(reply.headers['retry-after']).toBe('5');
      expect(reply.sentBody).toMatchObject({
        type: 'https://savia.app/problems/dependency-unavailable',
        title: 'Artifact storage is temporarily unavailable',
        status: 503,
      });
    });

    it('returns 400 when x-workspace-id header is missing or invalid', async () => {
      const port = new FakeReceiptsPort();
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const req = createCreateRequest([], { 'x-workspace-id': 'invalid-uuid' });

      await controller.create(req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(400);
      expect((reply.sentBody as { title: string }).title).toBe(
        'Invalid receipt headers',
      );
      expect(port.createCalls).toHaveLength(0);
    });

    it('returns 400 when idempotency-key header is missing or invalid', async () => {
      const port = new FakeReceiptsPort();
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const req = createCreateRequest([], { 'idempotency-key': '' });

      await controller.create(req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(400);
      expect((reply.sentBody as { title: string }).title).toBe(
        'Invalid receipt headers',
      );
      expect(port.createCalls).toHaveLength(0);
    });

    it('returns 422 when multiple file parts are provided', async () => {
      const port = new FakeReceiptsPort();
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const parts = [createValidFilePart(), createValidFilePart()];
      const req = createCreateRequest(parts);

      await controller.create(req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(422);
      expect((reply.sentBody as { detail: string }).detail).toBe(
        'Only one file part named file is allowed.',
      );
    });

    it('returns 422 when file part is missing or filename is empty', async () => {
      const port = new FakeReceiptsPort();
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const parts = [
        {
          type: 'field',
          fieldname: 'processingPreference',
          value: 'savia',
        },
      ];
      const req = createCreateRequest(parts);

      await controller.create(req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(422);
      expect((reply.sentBody as { detail: string }).detail).toBe(
        'file is required.',
      );
    });

    it('returns 422 when uploaded file is truncated (>5MB)', async () => {
      const port = new FakeReceiptsPort();
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const parts = [
        createValidFilePart({
          truncated: true,
        }),
      ];
      const req = createCreateRequest(parts);

      await controller.create(req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(422);
      expect((reply.sentBody as { detail: string }).detail).toBe(
        'The uploaded file exceeds the maximum size.',
      );
    });

    it('returns 422 when MIME type is disallowed', async () => {
      const port = new FakeReceiptsPort();
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const parts = [createValidFilePart({ mimetype: 'text/plain' })];
      const req = createCreateRequest(parts);

      await controller.create(req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(422);
      expect((reply.sentBody as { detail: string }).detail).toBe(
        'Only PDF, JPEG, PNG, and WebP files are accepted.',
      );
    });

    it('returns 422 when unexpected multipart field is present', async () => {
      const port = new FakeReceiptsPort();
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const parts = [
        createValidFilePart(),
        { type: 'field', fieldname: 'unknownField', value: 'bad' },
      ];
      const req = createCreateRequest(parts);

      await controller.create(req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(422);
      expect((reply.sentBody as { detail: string }).detail).toBe(
        'Unexpected multipart field: unknownField',
      );
    });

    it('returns 422 when device_result is requested without deviceOcrResult', async () => {
      const port = new FakeReceiptsPort();
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const parts = [
        createValidFilePart(),
        {
          type: 'field',
          fieldname: 'processingPreference',
          value: 'device_result',
        },
      ];
      const req = createCreateRequest(parts);

      await controller.create(req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(422);
      expect((reply.sentBody as { detail: string }).detail).toBe(
        'deviceOcrResult is required for device_result.',
      );
    });

    it('returns 422 when savia preference is supplied with deviceOcrResult', async () => {
      const port = new FakeReceiptsPort();
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const parts = [
        createValidFilePart(),
        {
          type: 'field',
          fieldname: 'processingPreference',
          value: 'savia',
        },
        {
          type: 'field',
          fieldname: 'deviceOcrResult',
          value: JSON.stringify({
            merchant: { value: 'Shop', confidence: 0.9 },
          }),
        },
      ];
      const req = createCreateRequest(parts);

      await controller.create(req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(422);
      expect((reply.sentBody as { detail: string }).detail).toBe(
        'deviceOcrResult is only allowed with device_result.',
      );
    });

    it('returns 422 when external_provider preference is supplied with deviceOcrResult', async () => {
      const port = new FakeReceiptsPort();
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const parts = [
        createValidFilePart(),
        {
          type: 'field',
          fieldname: 'processingPreference',
          value: 'external_provider',
        },
        {
          type: 'field',
          fieldname: 'deviceOcrResult',
          value: JSON.stringify({
            merchant: { value: 'Shop', confidence: 0.9 },
          }),
        },
      ];
      const req = createCreateRequest(parts);

      await controller.create(req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(422);
      expect((reply.sentBody as { detail: string }).detail).toBe(
        'deviceOcrResult is only allowed with device_result.',
      );
    });

    it('propagates storage failure exception to surface as 500 error', async () => {
      const port = new FakeReceiptsPort();
      port.createError = new Error('ArtifactStorage network partition');
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const parts = [createValidFilePart()];
      const req = createCreateRequest(parts);

      await expect(
        controller.create(req, reply as unknown as FastifyReply),
      ).rejects.toThrow('ArtifactStorage network partition');
    });

    it('returns 403 when port returns FORBIDDEN', async () => {
      const port = new FakeReceiptsPort();
      port.createResult = { kind: RECEIPT_OUTCOMES.FORBIDDEN };
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const parts = [createValidFilePart()];
      const req = createCreateRequest(parts);

      await controller.create(req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(403);
      expect((reply.sentBody as { title: string }).title).toBe(
        'Workspace access forbidden',
      );
    });

    it('returns 409 when port returns CONFLICT', async () => {
      const port = new FakeReceiptsPort();
      port.createResult = { kind: RECEIPT_OUTCOMES.CONFLICT };
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const parts = [createValidFilePart()];
      const req = createCreateRequest(parts);

      await controller.create(req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(409);
      expect((reply.sentBody as { title: string }).title).toBe(
        'Idempotency key reused with different payload',
      );
    });

    it('returns 404 when port returns NOT_FOUND', async () => {
      const port = new FakeReceiptsPort();
      port.createResult = { kind: RECEIPT_OUTCOMES.NOT_FOUND };
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const parts = [createValidFilePart()];
      const req = createCreateRequest(parts);

      await controller.create(req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(404);
      expect((reply.sentBody as { title: string }).title).toBe(
        'Receipt not found',
      );
    });

    it('returns replayed response when port returns TRANSACTION_REPLAYED', async () => {
      const port = new FakeReceiptsPort();
      port.createResult = {
        kind: RECEIPT_OUTCOMES.TRANSACTION_REPLAYED,
        status: 202,
        body: { id: receiptId, status: 'uploaded' },
      };
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const parts = [createValidFilePart()];
      const req = createCreateRequest(parts);

      await controller.create(req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(202);
      expect(reply.sentBody).toEqual({ id: receiptId, status: 'uploaded' });
    });

    it('returns 202 on successful upload', async () => {
      const port = new FakeReceiptsPort();
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const parts = [createValidFilePart()];
      const req = createCreateRequest(parts);

      await controller.create(req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(202);
      expect(reply.sentBody).toEqual(
        (port.createResult as { receipt: unknown }).receipt,
      );
    });
  });

  describe('get', () => {
    it('returns 400 on invalid x-workspace-id header', async () => {
      const port = new FakeReceiptsPort();
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const req = {
        identity: { subject },
        headers: { 'x-workspace-id': 'not-a-uuid' },
      } as unknown as AuthenticatedRequest;

      await controller.get(receiptId, req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(400);
      expect((reply.sentBody as { title: string }).title).toBe(
        'Invalid receipt request',
      );
      expect(port.getCalls).toHaveLength(0);
    });

    it('returns 400 on invalid receiptId UUID', async () => {
      const port = new FakeReceiptsPort();
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const req = {
        identity: { subject },
        headers: { 'x-workspace-id': workspaceId },
      } as unknown as AuthenticatedRequest;

      await controller.get('not-a-uuid', req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(400);
      expect((reply.sentBody as { title: string }).title).toBe(
        'Invalid receipt request',
      );
      expect(port.getCalls).toHaveLength(0);
    });

    it('returns 403 when get returns FORBIDDEN', async () => {
      const port = new FakeReceiptsPort();
      port.getResult = { kind: RECEIPT_OUTCOMES.FORBIDDEN };
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const req = {
        identity: { subject },
        headers: { 'x-workspace-id': workspaceId },
      } as unknown as AuthenticatedRequest;

      await controller.get(receiptId, req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(403);
      expect((reply.sentBody as { title: string }).title).toBe(
        'Workspace access forbidden',
      );
    });

    it('returns 404 when get returns NOT_FOUND', async () => {
      const port = new FakeReceiptsPort();
      port.getResult = { kind: RECEIPT_OUTCOMES.NOT_FOUND };
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const req = {
        identity: { subject },
        headers: { 'x-workspace-id': workspaceId },
      } as unknown as AuthenticatedRequest;

      await controller.get(receiptId, req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(404);
      expect((reply.sentBody as { title: string }).title).toBe(
        'Receipt not found',
      );
    });

    it('returns 200 with receipt on successful get', async () => {
      const port = new FakeReceiptsPort();
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const req = {
        identity: { subject },
        headers: { 'x-workspace-id': workspaceId },
      } as unknown as AuthenticatedRequest;

      await controller.get(receiptId, req, reply as unknown as FastifyReply);

      expect(reply.statusCode).toBe(200);
      expect(reply.sentBody).toEqual(
        (port.getResult as { receipt: unknown }).receipt,
      );
    });
  });

  describe('confirm', () => {
    const validTransactionPayload = {
      transaction: {
        type: 'expense',
        accountId,
        amount: { amountMinor: '1000', currency: 'USD' },
        occurredAt: '2026-09-07T12:00:00.000Z',
      },
    };

    function createConfirmRequest(
      body: unknown = validTransactionPayload,
      headers: Record<string, string> = {},
    ): AuthenticatedRequest {
      return {
        identity: { subject },
        headers: {
          'x-workspace-id': workspaceId,
          'idempotency-key': idempotencyKey,
          ...headers,
        },
        body,
      } as unknown as AuthenticatedRequest;
    }

    it('returns 400 on invalid headers or receiptId', async () => {
      const port = new FakeReceiptsPort();
      const controller = new ReceiptsController(port);

      const reply1 = new FakeReply();
      await controller.confirm(
        receiptId,
        createConfirmRequest(validTransactionPayload, {
          'x-workspace-id': 'bad',
        }),
        reply1 as unknown as FastifyReply,
      );
      expect(reply1.statusCode).toBe(400);

      const reply2 = new FakeReply();
      await controller.confirm(
        receiptId,
        createConfirmRequest(validTransactionPayload, {
          'idempotency-key': '',
        }),
        reply2 as unknown as FastifyReply,
      );
      expect(reply2.statusCode).toBe(400);

      const reply3 = new FakeReply();
      await controller.confirm(
        'not-a-uuid',
        createConfirmRequest(),
        reply3 as unknown as FastifyReply,
      );
      expect(reply3.statusCode).toBe(400);
    });

    it('returns 422 when transaction command validation fails', async () => {
      const port = new FakeReceiptsPort();
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();
      const invalidPayload = {
        transaction: {
          type: 'invalid_type',
        },
      };

      await controller.confirm(
        receiptId,
        createConfirmRequest(invalidPayload),
        reply as unknown as FastifyReply,
      );

      expect(reply.statusCode).toBe(422);
      expect((reply.sentBody as { title: string }).title).toBe(
        'Receipt confirmation validation failed',
      );
    });

    it('returns 422 when confirmation has an unknown top-level property', async () => {
      const port = new FakeReceiptsPort();
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();

      await controller.confirm(
        receiptId,
        createConfirmRequest({ ...validTransactionPayload, unexpected: true }),
        reply as unknown as FastifyReply,
      );

      expect(reply.statusCode).toBe(422);
      expect(
        (reply.sentBody as { errors: Array<{ field: string }> }).errors[0]
          .field,
      ).toBe('unexpected');
      expect(port.confirmCalls).toHaveLength(0);
    });

    it('returns 403 when port returns FORBIDDEN', async () => {
      const port = new FakeReceiptsPort();
      port.confirmResult = { kind: RECEIPT_OUTCOMES.FORBIDDEN };
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();

      await controller.confirm(
        receiptId,
        createConfirmRequest(),
        reply as unknown as FastifyReply,
      );

      expect(reply.statusCode).toBe(403);
      expect((reply.sentBody as { title: string }).title).toBe(
        'Workspace access forbidden',
      );
    });

    it('returns 404 when port returns NOT_FOUND', async () => {
      const port = new FakeReceiptsPort();
      port.confirmResult = { kind: RECEIPT_OUTCOMES.NOT_FOUND };
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();

      await controller.confirm(
        receiptId,
        createConfirmRequest(),
        reply as unknown as FastifyReply,
      );

      expect(reply.statusCode).toBe(404);
      expect((reply.sentBody as { title: string }).title).toBe(
        'Receipt not found',
      );
    });

    it('returns 409 when port returns CONFLICT', async () => {
      const port = new FakeReceiptsPort();
      port.confirmResult = { kind: RECEIPT_OUTCOMES.CONFLICT };
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();

      await controller.confirm(
        receiptId,
        createConfirmRequest(),
        reply as unknown as FastifyReply,
      );

      expect(reply.statusCode).toBe(409);
      expect((reply.sentBody as { title: string }).title).toBe(
        'Receipt confirmation conflict',
      );
    });

    it('returns 422 when port returns TRANSACTION_INVALID', async () => {
      const port = new FakeReceiptsPort();
      port.confirmResult = { kind: RECEIPT_OUTCOMES.TRANSACTION_INVALID };
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();

      await controller.confirm(
        receiptId,
        createConfirmRequest(),
        reply as unknown as FastifyReply,
      );

      expect(reply.statusCode).toBe(422);
      expect((reply.sentBody as { title: string }).title).toBe(
        'Transaction validation failed',
      );
    });

    it('returns replayed status and body when port returns TRANSACTION_REPLAYED', async () => {
      const port = new FakeReceiptsPort();
      port.confirmResult = {
        kind: RECEIPT_OUTCOMES.TRANSACTION_REPLAYED,
        status: 201,
        body: { id: 'replayed-tx' },
      };
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();

      await controller.confirm(
        receiptId,
        createConfirmRequest(),
        reply as unknown as FastifyReply,
      );

      expect(reply.statusCode).toBe(201);
      expect(reply.sentBody).toEqual({ id: 'replayed-tx' });
    });

    it('returns 201 with created transaction on successful confirmation', async () => {
      const port = new FakeReceiptsPort();
      const controller = new ReceiptsController(port);
      const reply = new FakeReply();

      await controller.confirm(
        receiptId,
        createConfirmRequest(),
        reply as unknown as FastifyReply,
      );

      expect(reply.statusCode).toBe(201);
      expect(reply.sentBody).toEqual(
        (port.confirmResult as { transaction: unknown }).transaction,
      );
    });
  });
});
