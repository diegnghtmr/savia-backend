import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlaywrightPdfRenderer } from '../../src/platform/playwright-pdf-renderer.js';
import { WorkerConfig } from '../../src/platform/worker-config.js';
import { WorkerModule } from '../../src/worker.module.js';
import { ReportJobHandler } from '../../src/reports/report-job.handler.js';

describe('ReportWorkerModule settlement composition', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('resolves WorkerConfig, ReportJobHandler, and PlaywrightPdfRenderer holding the configured settlement timeout', async () => {
    process.env.DATABASE_URL =
      'postgresql://postgres:postgres@127.0.0.1:5432/test';
    process.env.SAVIA_WORKER_RENDER_SETTLE_TIMEOUT_MS = '1234';

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    const config = moduleRef.get(WorkerConfig);
    const handler = moduleRef.get(ReportJobHandler);
    const renderer = moduleRef.get(PlaywrightPdfRenderer);

    expect(config.renderSettleTimeoutMs).toBe(1234);
    expect(handler.renderSettleTimeoutMs).toBe(1234);
    expect(renderer.renderSettleTimeoutMs).toBe(1234);
  });
});
