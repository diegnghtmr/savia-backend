import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerModule } from '../src/worker.module.js';
import { ReceiptOcrJobHandler } from '../src/receipts/receipt-ocr-job.handler.js';
import { ReceiptWorkerModule } from '../src/receipts/receipt-worker.module.js';
import {
  JOB_HANDLERS,
  JOB_OCR_BUDGETS,
  JOB_RENDER_BUDGETS,
  type JobHandler,
} from '../src/platform/job-handler.port.js';
import { JOB_WRITER_TYPES } from '../src/platform/job-writer.port.js';
import { JobRunner } from '../src/platform/job-runner.js';
import { WorkerConfig } from '../src/platform/worker-config.js';
import { ReportJobHandler } from '../src/reports/report-job.handler.js';
import { ForecastJobHandler } from '../src/forecasts/forecast-job.handler.js';
import { ExportJobHandler } from '../src/exports/export-job.handler.js';
import * as tesseractAdapter from '../src/platform/system-tesseract.adapter.js';
import { OcrPreflightError } from '../src/platform/system-tesseract.adapter.js';
import type { JobQueue } from '../src/platform/job-queue.port.js';
import type { JobWriter } from '../src/platform/job-writer.port.js';
import type { PgTransaction } from '../src/platform/pg-transaction.js';

describe('WorkerModule with ReceiptWorkerModule', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('resolves ReceiptOcrJobHandler through the real import graph', async () => {
    process.env.DATABASE_URL =
      'postgresql://postgres:postgres@127.0.0.1:5432/test';

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    const handler = moduleRef.get(ReceiptOcrJobHandler);
    expect(handler).toBeInstanceOf(ReceiptOcrJobHandler);
    expect(handler.jobType).toBe(JOB_WRITER_TYPES.RECEIPT_OCR);
  });

  it('JOB_HANDLERS includes ReceiptOcrJobHandler', async () => {
    process.env.DATABASE_URL =
      'postgresql://postgres:postgres@127.0.0.1:5432/test';

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    const handlers = moduleRef.get<JobHandler[]>(JOB_HANDLERS);
    const ocrHandler = handlers.find(
      (h) => h.jobType === JOB_WRITER_TYPES.RECEIPT_OCR,
    );
    expect(ocrHandler).toBeDefined();
    expect(ocrHandler).toBeInstanceOf(ReceiptOcrJobHandler);
  });

  it('ReceiptWorkerModule explicitly exports ReceiptOcrJobHandler', async () => {
    process.env.DATABASE_URL =
      'postgresql://postgres:postgres@127.0.0.1:5432/test';

    const moduleRef = await Test.createTestingModule({
      imports: [ReceiptWorkerModule],
    }).compile();

    const handler = moduleRef.get(ReceiptOcrJobHandler);
    expect(handler).toBeInstanceOf(ReceiptOcrJobHandler);
    expect(handler.ocrBudget).toBe(JOB_OCR_BUDGETS.RECEIPT_OCR);
  });

  it('validates the OCR marker at registration and does not reclassify render/non-OCR handlers', () => {
    const config = WorkerConfig.fromEnvironment({
      DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/test',
    });
    const ocrHandler = new ReceiptOcrJobHandler(
      {} as never,
      {} as never,
      {} as never,
    );
    const reportHandler = new ReportJobHandler(
      {} as never,
      {} as never,
      {} as never,
      undefined,
      2_000,
    );
    const forecastHandler = new ForecastJobHandler({} as never);
    const exportHandler = new ExportJobHandler({} as never, {} as never);

    const runner = new JobRunner(
      {
        claim: vi.fn(),
        ack: vi.fn(),
        archive: vi.fn(),
        defer: vi.fn(),
        failOrphanedJob: vi.fn(),
      } as unknown as JobQueue,
      {} as PgTransaction,
      {} as JobWriter,
      config,
      [forecastHandler, reportHandler, exportHandler, ocrHandler],
    );
    void runner;

    expect(config.resolveComputeTimeoutMs(ocrHandler)).toBe(10_000);
    expect(config.resolveComputeTimeoutMs(reportHandler)).toBe(180_000);
    expect(config.resolveComputeTimeoutMs(forecastHandler)).toBe(180_000);
    expect(config.resolveComputeTimeoutMs(exportHandler)).toBe(180_000);
    expect(reportHandler.renderBudget).toBe(JOB_RENDER_BUDGETS.PDF_RENDER);
    expect(
      'ocrBudget' in reportHandler &&
        (reportHandler as { ocrBudget?: unknown }).ocrBudget !== undefined,
    ).toBe(false);
  });

  it('refuses to register a render handler marked with the OCR budget', () => {
    const config = WorkerConfig.fromEnvironment({
      DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/test',
    });
    expect(
      () =>
        new JobRunner(
          {
            claim: vi.fn(),
            ack: vi.fn(),
            archive: vi.fn(),
            defer: vi.fn(),
            failOrphanedJob: vi.fn(),
          } as unknown as JobQueue,
          {} as PgTransaction,
          {} as JobWriter,
          config,
          [
            {
              jobType: JOB_WRITER_TYPES.REPORT_RUN,
              renderBudget: JOB_RENDER_BUDGETS.PDF_RENDER,
              ocrBudget: JOB_OCR_BUDGETS.RECEIPT_OCR,
              parsePayload: () => ({}),
              compute: async () => ({}),
              persist: async () => {},
              render: async () => ({}),
            } as unknown as JobHandler,
          ],
        ),
    ).toThrow(/cannot define both ocrBudget and renderBudget/);
  });

  it('does not start a worker whose OCR preflight fails', async () => {
    process.env.DATABASE_URL =
      'postgresql://postgres:postgres@127.0.0.1:5432/test';
    vi.spyOn(tesseractAdapter, 'runOcrStartupPreflight').mockRejectedValue(
      new OcrPreflightError("Failed loading language 'spa'"),
    );

    const moduleRef = await Test.createTestingModule({
      imports: [ReceiptWorkerModule],
    }).compile();

    await expect(moduleRef.init()).rejects.toThrow(OcrPreflightError);
  });
});
