import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DeliveryDeadlineExceededError } from '../../src/platform/delivery-deadline.js';
import {
  JOB_OCR_BUDGETS,
  type JobHandler,
  type NonRenderingJobHandler,
  type OcrJobHandler,
} from '../../src/platform/job-handler.port.js';
import type {
  JobQueue,
  QueueMessage,
} from '../../src/platform/job-queue.port.js';
import { JobRunner } from '../../src/platform/job-runner.js';
import type { JobWriter } from '../../src/platform/job-writer.port.js';
import type {
  PgTransaction,
  TransactionClient,
} from '../../src/platform/pg-transaction.js';
import {
  WorkerConfig,
  WorkerConfigurationError,
} from '../../src/platform/worker-config.js';

describe('JobRunner Concurrency and Mixed Batches (S7 unit spec)', () => {
  const wsId = '00000000-0000-0000-0000-000000000001';
  const actorId = '00000000-0000-0000-0000-000000000003';
  let clockTime = 1_000_000;
  const fakeClock = () => clockTime;

  beforeEach(() => {
    vi.useFakeTimers();
    clockTime = 1_000_000;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createTestHarness(
    options: {
      config?: WorkerConfig;
      messages?: QueueMessage[];
      handlers?: JobHandler[];
      jobRows?: Record<
        string,
        {
          id: string;
          workspace_id: string;
          created_by: string;
          type: string;
          status: string;
          payload: unknown;
          role: string;
        }
      >;
    } = {},
  ) {
    const config =
      options.config ??
      new WorkerConfig(
        2, // batchSize: 2
        300, // visibilityTimeoutSeconds
        1000, // pollIntervalMs
        30, // drainTimeoutSeconds
        undefined,
        5000,
        5,
        15_000,
        180_000, // computeTimeoutMs
        60_000,
        20_000,
        10_000,
        1_000, // minOperationMs
        8_000,
        30_000,
        30_000,
        30_000,
        2_000,
        10_000,
        10_000, // ocrComputeTimeoutMs
        20_000, // storageDownloadTimeoutMs
        30_000, // ocrTimeoutMs
        2_000, // stageCleanupTimeoutMs
        1_073_741_824, // ocrMemoryLimitBytes
        1, // ocrConcurrency: 1
      );

    const queueMessages = options.messages ?? [];

    const mockQueue: JobQueue = {
      claim: vi.fn().mockImplementation(async () => queueMessages),
      ack: vi.fn().mockResolvedValue(true),
      archive: vi.fn().mockResolvedValue(true),
      defer: vi.fn().mockResolvedValue(true),
      failOrphanedJob: vi.fn().mockResolvedValue(true),
    };

    const mockClient: TransactionClient = {
      query: vi
        .fn()
        .mockImplementation(async (sql: string, params?: unknown[]) => {
          if (sql.includes('from public.jobs') && params && params[0]) {
            const jId = String(params[0]);
            const row = options.jobRows?.[jId] ?? {
              id: jId,
              workspace_id: wsId,
              created_by: actorId,
              type: 'receipt_ocr',
              status: 'queued',
              payload: { storagePath: `workspaces/${wsId}/receipts/r1.jpg` },
              role: 'owner',
            };
            return { rows: [row] };
          }
          return { rows: [] };
        }),
    };

    const mockTransaction: Partial<PgTransaction> = {
      run: vi.fn().mockImplementation(async (_subject, cb) => cb(mockClient)),
      runRead: vi
        .fn()
        .mockImplementation(async (_subject, cb) => cb(mockClient)),
      runAsQueueConsumer: vi
        .fn()
        .mockImplementation(async (cb) => cb(mockClient)),
    };

    const mockJobWriter: Partial<JobWriter> = {
      transitionToProcessing: vi.fn().mockResolvedValue(undefined),
      completeJob: vi.fn().mockResolvedValue(undefined),
      failJob: vi.fn().mockResolvedValue(undefined),
      deadLetter: vi.fn().mockResolvedValue(undefined),
      findJobById: vi.fn().mockResolvedValue(undefined),
    };

    const runner = new JobRunner(
      mockQueue,
      mockTransaction as PgTransaction,
      mockJobWriter as JobWriter,
      config,
      options.handlers,
      fakeClock,
    );

    return { runner, config, mockQueue, mockJobWriter, mockTransaction };
  }

  function createMockOcrHandler(
    overrides: Partial<OcrJobHandler> = {},
  ): OcrJobHandler {
    return {
      jobType: 'receipt_ocr',
      ocrBudget: JOB_OCR_BUDGETS.RECEIPT_OCR,
      parsePayload: vi.fn((raw) => raw),
      compute: vi.fn().mockResolvedValue({ binding: 'b1' }),
      download: vi.fn().mockResolvedValue(Buffer.from('fake-image-bytes')),
      ocr: vi.fn().mockResolvedValue({ text: 'RECEIPT TOTAL 100.00' }),
      persist: vi.fn().mockResolvedValue('r1'),
      ...overrides,
    };
  }

  function createMockNonOcrHandler(
    overrides: Partial<NonRenderingJobHandler> = {},
  ): NonRenderingJobHandler {
    return {
      jobType: 'probe',
      parsePayload: vi.fn((raw) => raw),
      compute: vi.fn().mockResolvedValue({ computed: 123 }),
      persist: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('refuses explicit over-batch concurrency value (ocrConcurrency > batchSize)', () => {
    expect(
      () =>
        new WorkerConfig(
          2, // batchSize: 2
          300,
          1000,
          30,
          undefined,
          5000,
          5,
          15_000,
          180_000,
          60_000,
          20_000,
          10_000,
          1_000,
          8_000,
          30_000,
          30_000,
          30_000,
          2_000,
          10_000,
          10_000,
          20_000,
          30_000,
          2_000,
          1_073_741_824,
          3, // ocrConcurrency: 3 > batchSize: 2 -> REFUSED
        ),
    ).toThrow(WorkerConfigurationError);
  });

  it('abortable semaphore wait: cancelled waiter is removed without leaking semaphore slots (mutation g target)', async () => {
    // Config: batchSize 2, ocrConcurrency 1
    const ocrHandler = createMockOcrHandler();
    const { runner } = createTestHarness({ handlers: [ocrHandler] });

    // Directly test semaphore acquire & abort behavior
    const sem = runner.ocrSemaphore;
    expect(sem.availablePermits).toBe(1);

    const permit1 = await sem.acquire();
    expect(sem.availablePermits).toBe(0);
    expect(sem.waitingCount).toBe(0);

    // Enqueue waiter 2 with an abort signal
    const ac2 = new AbortController();
    const waitPromise2 = sem.acquire(ac2.signal);
    expect(sem.waitingCount).toBe(1);

    // Cancel/abort waiter 2
    ac2.abort(new Error('waiter 2 aborted'));
    await expect(waitPromise2).rejects.toThrow('waiter 2 aborted');

    // Waiter 2 MUST be removed from queue; no permits leaked
    expect(sem.waitingCount).toBe(0);
    expect(sem.availablePermits).toBe(0);

    // Enqueue waiter 3
    const waitPromise3 = sem.acquire();
    expect(sem.waitingCount).toBe(1);

    // Now permit 1 is released. Permit MUST go to waiter 3, not the dead waiter 2!
    permit1.release();
    const permit3 = await waitPromise3;
    expect(sem.waitingCount).toBe(0);
    expect(sem.availablePermits).toBe(0);

    // Release permit 3 -> returns available permits to 1
    permit3.release();
    expect(sem.availablePermits).toBe(1);
  });

  it('semaphore acquisition is inside the bounded stage: queue wait consumes OCR time (mutation f target)', async () => {
    // We prove that queue wait consumes OCR time rather than giving the stage a fresh 30-second budget.
    // If bounded stage is 30,000ms:
    // Job 1 holds OCR semaphore for 10,000ms.
    // Job 2 enters bounded stage (deadline 30,000ms). It waits on semaphore for 10,000ms.
    // After acquiring semaphore, Job 2 only has 20,000ms left before bounded stage times out.
    // If Job 2 takes 25,000ms (> 20,000ms remaining), it MUST time out at 30,000ms total!
    // (If semaphore wait had its own budget outside bounded stage, Job 2 would get 10s wait + 30s OCR = 40s total, and 10s + 25s = 35s would not time out).

    let resolveJob1Ocr!: () => void;
    let job2OcrRunning = false;

    const ocrHandler = createMockOcrHandler({
      ocr: vi
        .fn()
        .mockImplementationOnce(async () => {
          return new Promise((resolve) => {
            resolveJob1Ocr = () => resolve({ text: 'job1-done' });
          });
        })
        .mockImplementationOnce(async (_ctx, _buf, timeoutMs, signal) => {
          job2OcrRunning = true;
          // Job 2 tries to run for 25,000ms
          return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(
                new DeliveryDeadlineExceededError('job2 aborted on deadline'),
              );
            });
            setTimeout(() => resolve({ text: 'job2-done' }), 25_000);
          });
        }),
    });

    const jId1 = '00000000-0000-0000-0000-000000000011';
    const jId2 = '00000000-0000-0000-0000-000000000022';

    const messages: QueueMessage[] = [
      {
        msgId: '101',
        readCt: 1,
        enqueuedAt: new Date().toISOString(),
        vt: new Date().toISOString(),
        message: { job_id: jId1, workspace_id: wsId, actor_id: actorId },
      },
      {
        msgId: '102',
        readCt: 1,
        enqueuedAt: new Date().toISOString(),
        vt: new Date().toISOString(),
        message: { job_id: jId2, workspace_id: wsId, actor_id: actorId },
      },
    ];

    const { runner, mockJobWriter } = createTestHarness({
      handlers: [ocrHandler],
      messages,
      jobRows: {
        [jId1]: {
          id: jId1,
          workspace_id: wsId,
          created_by: actorId,
          type: 'receipt_ocr',
          status: 'queued',
          payload: { storagePath: `workspaces/${wsId}/receipts/r1.jpg` },
          role: 'owner',
        },
        [jId2]: {
          id: jId2,
          workspace_id: wsId,
          created_by: actorId,
          type: 'receipt_ocr',
          status: 'queued',
          payload: { storagePath: `workspaces/${wsId}/receipts/r2.jpg` },
          role: 'owner',
        },
      },
    });

    const runPromise = runner.runOnce();
    await vi.advanceTimersByTimeAsync(0);

    // Both messages claimed. Job 1 acquires OCR permit. Job 2 queues for semaphore.
    expect(ocrHandler.ocr).toHaveBeenCalledTimes(1);

    // Advance 10,000ms while Job 1 is running
    await vi.advanceTimersByTimeAsync(10_000);

    // Job 1 completes at 10,000ms
    resolveJob1Ocr();
    await vi.advanceTimersByTimeAsync(0);

    // Job 2 acquires semaphore and starts OCR at 10,000ms
    expect(ocrHandler.ocr).toHaveBeenCalledTimes(2);
    expect(job2OcrRunning).toBe(true);

    // Now advance 20,000ms (total 30,000ms from start of bounded stage)
    // Job 2 has consumed 10,000ms in queue wait + 20,000ms in OCR = 30,000ms total.
    // The bounded stage timeout (30,000ms) MUST FIRE NOW!
    await vi.advanceTimersByTimeAsync(20_000);

    // Job 2 timed out! Advance through cleanup
    await vi.advanceTimersByTimeAsync(2_000);

    await runPromise;

    // Job 1 completed, Job 2 timed out (deferred)
    expect(mockJobWriter.completeJob).toHaveBeenCalledWith(
      expect.anything(),
      wsId,
      jId1,
      'r1',
    );
    // Job 2 was NOT completed because its queue wait consumed its OCR budget and it timed out
    expect(mockJobWriter.completeJob).not.toHaveBeenCalledWith(
      expect.anything(),
      wsId,
      jId2,
      expect.anything(),
    );
  });

  it('mixed batch: OCR jobs obey ocrConcurrency while other job types process concurrently and unchanged', async () => {
    const ocrStartedLog: string[] = [];
    const nonOcrStartedLog: string[] = [];

    const ocrHandler = createMockOcrHandler({
      ocr: vi.fn().mockImplementation(async () => {
        ocrStartedLog.push('ocr');
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return { text: 'done' };
      }),
    });

    const nonOcrHandler = createMockNonOcrHandler({
      compute: vi.fn().mockImplementation(async () => {
        nonOcrStartedLog.push('non-ocr');
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { computed: true };
      }),
    });

    const jIdOcr = '00000000-0000-0000-0000-000000000001';
    const jIdNonOcr = '00000000-0000-0000-0000-000000000002';

    const messages: QueueMessage[] = [
      {
        msgId: '1',
        readCt: 1,
        enqueuedAt: new Date().toISOString(),
        vt: new Date().toISOString(),
        message: { job_id: jIdOcr, workspace_id: wsId, actor_id: actorId },
      },
      {
        msgId: '2',
        readCt: 1,
        enqueuedAt: new Date().toISOString(),
        vt: new Date().toISOString(),
        message: { job_id: jIdNonOcr, workspace_id: wsId, actor_id: actorId },
      },
    ];

    const { runner, mockJobWriter } = createTestHarness({
      handlers: [ocrHandler, nonOcrHandler],
      messages,
      jobRows: {
        [jIdOcr]: {
          id: jIdOcr,
          workspace_id: wsId,
          created_by: actorId,
          type: 'receipt_ocr',
          status: 'queued',
          payload: { storagePath: `workspaces/${wsId}/receipts/r1.jpg` },
          role: 'owner',
        },
        [jIdNonOcr]: {
          id: jIdNonOcr,
          workspace_id: wsId,
          created_by: actorId,
          type: 'probe',
          status: 'queued',
          payload: { value: 1 },
          role: 'owner',
        },
      },
    });

    const runPromise = runner.runOnce();
    await vi.advanceTimersByTimeAsync(0);

    // Both jobs started processing in the batch!
    expect(nonOcrStartedLog).toContain('non-ocr');

    // Advance 600ms: non-OCR job finishes while OCR job is still running its 5,000ms OCR
    await vi.advanceTimersByTimeAsync(600);
    expect(mockJobWriter.completeJob).toHaveBeenCalledWith(
      expect.anything(),
      wsId,
      jIdNonOcr,
      null,
    );

    // Advance remaining 4,400ms for OCR job
    await vi.advanceTimersByTimeAsync(4_400);

    const completed = await runPromise;
    expect(completed).toBe(2);
    expect(mockJobWriter.completeJob).toHaveBeenCalledWith(
      expect.anything(),
      wsId,
      jIdOcr,
      'r1',
    );
  });

  it('non-regression proof: non-OCR handlers receive computeTimeoutMs (180,000ms), NOT ocrComputeTimeoutMs (mutation h target)', async () => {
    let capturedTimeoutMs = 0;

    const probeHandler = createMockNonOcrHandler({
      compute: vi.fn(async () => {
        return { ok: true };
      }),
    });

    const jId = '00000000-0000-0000-0000-000000000077';
    const messages: QueueMessage[] = [
      {
        msgId: '101',
        readCt: 1,
        enqueuedAt: new Date().toISOString(),
        vt: new Date().toISOString(),
        message: { job_id: jId, workspace_id: wsId, actor_id: actorId },
      },
    ];

    const { runner, mockTransaction, config } = createTestHarness({
      handlers: [probeHandler],
      messages,
      jobRows: {
        [jId]: {
          id: jId,
          workspace_id: wsId,
          created_by: actorId,
          type: 'probe',
          status: 'queued',
          payload: { val: 1 },
          role: 'owner',
        },
      },
    });

    // Intercept runRead to verify the timeout passed to the read transaction
    const runReadSpy = vi.spyOn(mockTransaction as PgTransaction, 'runRead');
    runReadSpy.mockImplementation(async (_subject, cb, optionsOrTimeout) => {
      capturedTimeoutMs =
        typeof optionsOrTimeout === 'number'
          ? optionsOrTimeout
          : (optionsOrTimeout?.timeoutMs ?? 0);
      return cb({} as TransactionClient);
    });

    await runner.runOnce();

    // DeliveryDeadline forWork with 180,000ms cap (computeTimeoutMs)
    // 300,000ms - 20,000ms lease - 10,000ms terminal reserve = 270,000ms available > 180,000ms
    // So timeoutMs should be exactly 180,000ms!
    // If someone applied ocrComputeTimeoutMs (10,000ms), capturedTimeoutMs would be 10,000ms and this test dies!
    expect(capturedTimeoutMs).toBe(config.computeTimeoutMs);
    expect(capturedTimeoutMs).toBe(180_000);
    expect(capturedTimeoutMs).not.toBe(config.ocrComputeTimeoutMs);
  });

  it('no later batch exceeds concurrency during cleanup overrun', async () => {
    // Concurrency is 1. Batch 1 has OCR job that times out and overruns cleanup (child never exits).
    // Batch 2 arrives with an OCR job.
    // Batch 2 MUST NOT run OCR concurrently with the hanging job!
    let releaseBatch1Child!: () => void;
    let batch2OcrInvoked = false;

    const ocrHandler = createMockOcrHandler({
      ocr: vi
        .fn()
        .mockImplementationOnce(async () => {
          // Batch 1: hangs indefinitely (cleanup overrun)
          return new Promise((resolve) => {
            releaseBatch1Child = () => resolve({ text: 'batch1-settled-late' });
          });
        })
        .mockImplementationOnce(async () => {
          batch2OcrInvoked = true;
          return { text: 'batch2-done' };
        }),
    });

    const jId1 = '00000000-0000-0000-0000-000000000001';
    const jId2 = '00000000-0000-0000-0000-000000000002';

    const batch1Messages: QueueMessage[] = [
      {
        msgId: '1',
        readCt: 1,
        enqueuedAt: new Date().toISOString(),
        vt: new Date().toISOString(),
        message: { job_id: jId1, workspace_id: wsId, actor_id: actorId },
      },
    ];

    const { runner, mockQueue } = createTestHarness({
      handlers: [ocrHandler],
      messages: batch1Messages,
      jobRows: {
        [jId1]: {
          id: jId1,
          workspace_id: wsId,
          created_by: actorId,
          type: 'receipt_ocr',
          status: 'queued',
          payload: { storagePath: `workspaces/${wsId}/receipts/r1.jpg` },
          role: 'owner',
        },
        [jId2]: {
          id: jId2,
          workspace_id: wsId,
          created_by: actorId,
          type: 'receipt_ocr',
          status: 'queued',
          payload: { storagePath: `workspaces/${wsId}/receipts/r2.jpg` },
          role: 'owner',
        },
      },
    });

    // Run Batch 1
    const run1Promise = runner.runOnce();
    await vi.advanceTimersByTimeAsync(0);

    // Advance 30,000ms (timeout) + 2,000ms (cleanup overrun)
    await vi.advanceTimersByTimeAsync(32_000);
    await run1Promise;

    // Overrun is registered; permit is retained!
    expect(runner.cleanupOverrunCount).toBe(1);
    expect(runner.ocrAvailablePermits).toBe(0);

    // Now Batch 2 arrives with an OCR job
    vi.spyOn(mockQueue as JobQueue, 'claim').mockResolvedValueOnce([
      {
        msgId: '2',
        readCt: 1,
        enqueuedAt: new Date().toISOString(),
        vt: new Date().toISOString(),
        message: { job_id: jId2, workspace_id: wsId, actor_id: actorId },
      },
    ]);

    const run2Promise = runner.runOnce();
    await vi.advanceTimersByTimeAsync(0);

    // Batch 2 OCR job MUST NOT have started OCR because concurrency is 1 and overrun job holds permit!
    expect(batch2OcrInvoked).toBe(false);
    expect(ocrHandler.ocr).toHaveBeenCalledTimes(1);

    // Advance 5,000ms: Batch 2 is still waiting for permit
    await vi.advanceTimersByTimeAsync(5_000);
    expect(batch2OcrInvoked).toBe(false);

    // Now Batch 1 child finally exits!
    releaseBatch1Child();
    await vi.advanceTimersByTimeAsync(0);

    // Overrun deregisters, permit is passed to Batch 2!
    expect(runner.cleanupOverrunCount).toBe(0);
    expect(batch2OcrInvoked).toBe(true);
    expect(ocrHandler.ocr).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    await run2Promise;
  });
});
