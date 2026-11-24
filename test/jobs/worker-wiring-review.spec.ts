import type { Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { expect, it, vi } from 'vitest';
import { FrankfurterRateJob } from '../../src/currencies/frankfurter-rate-job.js';
import { JOB_HANDLERS } from '../../src/platform/job-handler.port.js';
import { JOB_QUEUE } from '../../src/platform/job-queue.port.js';
import { JOB_SWEEP, JobRunner } from '../../src/platform/job-runner.js';
import { JOB_WRITER } from '../../src/platform/job-writer.port.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { WorkerConfig } from '../../src/platform/worker-config.js';
import { WorkerModule } from '../../src/worker.module.js';

it('injects the FX companion separately from the job sweeps', async () => {
  const providers = Reflect.getMetadata(
    MODULE_METADATA.PROVIDERS,
    WorkerModule,
  ) as Provider[];
  const runner = providers.find(
    (provider) =>
      typeof provider === 'object' &&
      'provide' in provider &&
      provider.provide === JobRunner,
  );
  expect(runner).toBeDefined();
  const stop = vi.fn().mockResolvedValue(undefined);
  const testing = await Test.createTestingModule({
    providers: [
      runner!,
      { provide: JOB_QUEUE, useValue: {} },
      { provide: PgTransaction, useValue: {} },
      { provide: JOB_WRITER, useValue: {} },
      { provide: WorkerConfig, useValue: new WorkerConfig(1, 300, 1000, 1) },
      { provide: JOB_HANDLERS, useValue: [] },
      { provide: JOB_SWEEP, useValue: [] },
      { provide: FrankfurterRateJob, useValue: { stop } },
    ],
  }).compile();
  await testing.close();
  expect(stop).toHaveBeenCalledOnce();
});
