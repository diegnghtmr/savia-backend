import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  DeliveryDeadline,
  DeliveryDeadlineExceededError,
} from '../../src/platform/delivery-deadline.js';
import type { JobHandler } from '../../src/platform/job-handler.port.js';
import type { JobQueue } from '../../src/platform/job-queue.port.js';
import { JobRunner } from '../../src/platform/job-runner.js';
import type { JobWriter } from '../../src/platform/job-writer.port.js';
import type { PgTransaction } from '../../src/platform/pg-transaction.js';
import { WorkerConfig } from '../../src/platform/worker-config.js';

describe('JobRunner executeBoundedStage (S7 unit spec)', () => {
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
      handlers?: JobHandler[];
    } = {},
  ) {
    const config =
      options.config ??
      new WorkerConfig(
        1, // batchSize
        300, // visibilityTimeoutSeconds (300s)
        1000, // pollIntervalMs
        30, // drainTimeoutSeconds
      );

    const mockQueue: JobQueue = {
      claim: vi.fn().mockResolvedValue([]),
      ack: vi.fn().mockResolvedValue(true),
      archive: vi.fn().mockResolvedValue(true),
      defer: vi.fn().mockResolvedValue(true),
      failOrphanedJob: vi.fn().mockResolvedValue(true),
    };

    const mockTransaction = {
      run: vi.fn(),
      runRead: vi.fn(),
      runAsQueueConsumer: vi.fn(),
    } as unknown as PgTransaction;

    const mockJobWriter = {
      transitionToProcessing: vi.fn(),
      completeJob: vi.fn(),
      failJob: vi.fn(),
      deadLetter: vi.fn(),
      findJobById: vi.fn(),
      createQueuedJob: vi.fn(),
    } as unknown as JobWriter;

    const runner = new JobRunner(
      mockQueue,
      mockTransaction,
      mockJobWriter,
      config,
      options.handlers,
      fakeClock,
    );

    return { runner, config, mockQueue };
  }

  it('normal completion within deadline returns result', async () => {
    const { runner } = createTestHarness();
    const deadline = runner.createDeadline();

    let observedSignal: AbortSignal | undefined;
    let observedTimeoutMs = 0;

    const stagePromise = runner.executeBoundedStage(
      deadline,
      30_000,
      'test-stage',
      async (signal, timeoutMs) => {
        observedSignal = signal;
        observedTimeoutMs = timeoutMs;
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { success: true, count: 42 };
      },
    );

    await vi.advanceTimersByTimeAsync(500);
    const result = await stagePromise;

    expect(result).toEqual({ success: true, count: 42 });
    expect(observedSignal?.aborted).toBe(false);
    expect(observedTimeoutMs).toBe(30_000);
  });

  it('rejects below minOperationMs rather than starting work it cannot finish', async () => {
    const { runner } = createTestHarness();
    // Claimed at clockTime. Advance clock so remaining forWork < minOperationMs
    const deadline = runner.createDeadline();
    // visibility = 300s (300,000ms), leaseSafetyMs = 20,000ms, terminalReserveMs = 10,000ms
    // Work ceiling = 300,000 - 20,000 - 10,000 = 270,000ms
    // Advance clock by 269,500ms -> remaining forWork is 500ms < minOperationMs (1,000ms)
    clockTime += 269_500;

    const executeSpy = vi.fn();
    await expect(
      runner.executeBoundedStage(deadline, 30_000, 'starved-stage', executeSpy),
    ).rejects.toThrow(DeliveryDeadlineExceededError);

    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('on timeout calls controller.abort and awaits stage promise through cleanup before throwing DeliveryDeadlineExceededError', async () => {
    const { runner } = createTestHarness();
    const deadline = runner.createDeadline();

    const cleanupEvents: string[] = [];
    let abortObserved = false;

    const stagePromise = runner.executeBoundedStage(
      deadline,
      5_000,
      'cleanup-stage',
      async (signal) => {
        signal.addEventListener('abort', () => {
          abortObserved = true;
          cleanupEvents.push('abort_received');
        });

        // Simulating child process or adapter awaiting cancellation
        try {
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              // Grace period / cleanup delay of 600ms before rejection
              setTimeout(() => {
                cleanupEvents.push('cleanup_finished');
                reject(new Error('child killed after SIGTERM'));
              }, 600);
            });
          });
        } finally {
          cleanupEvents.push('finally_block');
        }
      },
    );

    let settledBeforeCleanup = false;
    stagePromise.then(
      () => {
        settledBeforeCleanup = true;
      },
      () => {
        settledBeforeCleanup = true;
      },
    );
    const errPromise = stagePromise.catch((e: unknown) => e);

    // Advance to timeout (5,000ms)
    await vi.advanceTimersByTimeAsync(5_000);
    expect(abortObserved).toBe(true);
    expect(cleanupEvents).toContain('abort_received');
    expect(cleanupEvents).not.toContain('cleanup_finished');
    expect(settledBeforeCleanup).toBe(false);

    // Advance 600ms through cleanup
    await vi.advanceTimersByTimeAsync(600);
    expect(cleanupEvents).toContain('cleanup_finished');
    expect(cleanupEvents).toContain('finally_block');
    expect(settledBeforeCleanup).toBe(true);

    const err = await errPromise;
    expect(err).toBeInstanceOf(DeliveryDeadlineExceededError);
    expect((err as DeliveryDeadlineExceededError).message).toContain(
      'Stage "cleanup-stage" timed out after 5000ms',
    );
  });

  describe('Timeout state machine (5 binding properties)', () => {
    it('Property 1: once timeout fires, no later fulfillment may override the timeout result', async () => {
      const { runner } = createTestHarness();
      const deadline = runner.createDeadline();

      let resolveStage!: (val: string) => void;
      const deferredPromise = new Promise<string>((resolve) => {
        resolveStage = resolve;
      });

      const stagePromise = runner.executeBoundedStage(
        deadline,
        2_000,
        'late-fulfillment-stage',
        async () => deferredPromise,
      );
      const errPromise = stagePromise.catch((e: unknown) => e);

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(2_000);

      // Now stage fulfills AFTER timeout
      resolveStage('late-success-value');
      await vi.advanceTimersByTimeAsync(100);

      // The caller MUST still receive DeliveryDeadlineExceededError, NOT 'late-success-value'
      const err = await errPromise;
      expect(err).toBeInstanceOf(DeliveryDeadlineExceededError);
    });

    it('Property 2: once timeout fires, no later adapter error may override the timeout result', async () => {
      const { runner } = createTestHarness();
      const deadline = runner.createDeadline();

      let rejectStage!: (err: Error) => void;
      const deferredPromise = new Promise<string>((_, reject) => {
        rejectStage = reject;
      });

      const stagePromise = runner.executeBoundedStage(
        deadline,
        2_000,
        'late-error-stage',
        async () => deferredPromise,
      );
      const errPromise = stagePromise.catch((e: unknown) => e);

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(2_000);

      // Late adapter error arrives
      rejectStage(new Error('adapter connection reset by peer'));
      await vi.advanceTimersByTimeAsync(100);

      const err = await errPromise;
      expect(err).toBeInstanceOf(DeliveryDeadlineExceededError);
      expect((err as Error).message).not.toContain(
        'adapter connection reset by peer',
      );
      expect((err as Error).message).toContain(
        'Stage "late-error-stage" timed out after 2000ms',
      );
    });

    it('Property 3: aborts exactly once on timeout', async () => {
      const { runner } = createTestHarness();
      const deadline = runner.createDeadline();

      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
      let abortCount = 0;
      let abortReason: unknown;

      const stagePromise = runner.executeBoundedStage(
        deadline,
        2_000,
        'abort-once-stage',
        async (signal) => {
          signal.addEventListener('abort', () => {
            abortCount++;
            abortReason = signal.reason;
          });
          return new Promise(() => {}); // never settles
        },
      );
      const errPromise = stagePromise.catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(abortCount).toBe(1);
      expect(abortReason).toBeInstanceOf(DeliveryDeadlineExceededError);

      // Advance further through cleanup window
      await vi.advanceTimersByTimeAsync(1_000);
      expect(abortSpy).toHaveBeenCalledTimes(1); // exactly once, not called again

      // Advance past cleanup bound
      await vi.advanceTimersByTimeAsync(2_000);
      expect(abortSpy).toHaveBeenCalledTimes(1);

      await errPromise;
      abortSpy.mockRestore();
    });

    it('Property 4: observes stage promise so a late rejection is never unhandled', async () => {
      const { runner } = createTestHarness();
      const deadline = runner.createDeadline();

      let unhandledCount = 0;
      const unhandledListener = () => {
        unhandledCount++;
      };
      process.on('unhandledRejection', unhandledListener);

      try {
        let lateReject!: (err: Error) => void;
        const deferred = new Promise<string>((_, reject) => {
          lateReject = reject;
        });

        const stagePromise = runner.executeBoundedStage(
          deadline,
          1_000,
          'unhandled-observer-stage',
          async () => deferred,
        );
        const errPromise = stagePromise.catch((e: unknown) => e);

        // Advance to timeout and beyond
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(2_000);
        await errPromise;

        // Late rejection long after stage has failed and returned
        lateReject(new Error('late orphaned network fault'));
        await vi.advanceTimersByTimeAsync(500);

        expect(unhandledCount).toBe(0);
      } finally {
        process.removeListener('unhandledRejection', unhandledListener);
      }
    });

    it('Property 5: preserves original adapter error only when it occurred before timeout', async () => {
      const { runner } = createTestHarness();
      const deadline = runner.createDeadline();

      class CustomAdapterError extends Error {
        public readonly code = 'adapter_fault';
      }

      let abortCalled = false;

      const stagePromise = runner.executeBoundedStage(
        deadline,
        10_000,
        'adapter-pre-timeout-stage',
        async (signal) => {
          signal.addEventListener('abort', () => {
            abortCalled = true;
          });
          // Reject at 200ms, well before 10,000ms timeout
          await new Promise((_, reject) => {
            setTimeout(
              () => reject(new CustomAdapterError('syntax error in query')),
              200,
            );
          });
          return 'ok';
        },
      );
      const errPromise = stagePromise.catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(200);

      const err = await errPromise;
      expect(err).toBeInstanceOf(CustomAdapterError);
      expect((err as CustomAdapterError).message).toBe('syntax error in query');
      expect((err as CustomAdapterError).code).toBe('adapter_fault');
      expect(err).not.toBeInstanceOf(DeliveryDeadlineExceededError);
      expect(abortCalled).toBe(false);
    });
  });

  describe('Cleanup-overrun ownership', () => {
    it('registers in runner in-flight registry, keeps activeJobsCount visible, does not release permit, and emits unhealthy event', async () => {
      const { runner, config } = createTestHarness();
      const deadline = runner.createDeadline();

      const unhealthyEvents: unknown[] = [];
      runner.on('unhealthy', (ev: unknown) => {
        unhealthyEvents.push(ev);
      });

      let permitReleased = false;
      const mockPermit = {
        release: vi.fn(() => {
          permitReleased = true;
        }),
      };

      let childSettled = false;
      let lateResolveChild!: () => void;
      const childPromise = new Promise<string>((resolve) => {
        lateResolveChild = () => {
          childSettled = true;
          resolve('finally exited');
        };
      });

      const initialActive = runner.activeJobsCount;
      expect(initialActive).toBe(0);

      const stagePromise = runner.executeBoundedStage(
        deadline,
        3_000,
        'overrun-stage',
        async () => childPromise,
        {
          jobId: '00000000-0000-0000-0000-000000000099',
          workspaceId: '00000000-0000-0000-0000-000000000001',
          getPermit: () => mockPermit,
        },
      );
      const errPromise = stagePromise.catch((e: unknown) => e);

      // Advance to timeout (3,000ms)
      await vi.advanceTimersByTimeAsync(3_000);
      expect(permitReleased).toBe(false);

      // Advance through stageCleanupTimeoutMs (2,000ms) - child is STILL hanging
      await vi.advanceTimersByTimeAsync(config.stageCleanupTimeoutMs);

      // 1. Hard bound triggered: executeBoundedStage rejects with overrun deadline error
      const err = await errPromise;
      expect(err).toBeInstanceOf(DeliveryDeadlineExceededError);
      expect((err as Error).message).toContain(
        'post-abort cleanup exceeded bound',
      );

      // 2. Permit ownership: permit MUST NOT be released on overrun!
      expect(permitReleased).toBe(false);
      expect(mockPermit.release).not.toHaveBeenCalled();

      // 3. activeJobsCount visibility: runner must report activeJobsCount > 0 due to in-flight registry
      expect(runner.activeJobsCount).toBe(1);
      expect(runner.cleanupOverrunCount).toBe(1);

      // 4. Actionable unhealthy/fatal event emitted
      expect(unhealthyEvents).toHaveLength(1);
      expect(unhealthyEvents[0]).toMatchObject({
        type: 'cleanup_overrun',
        stageName: 'overrun-stage',
        jobId: '00000000-0000-0000-0000-000000000099',
      });

      // 5. Shutdown behavior: stop() waits while activeJobsCount > 0
      let stopFinished = false;
      const stopPromise = runner.stop().then(() => {
        stopFinished = true;
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(stopFinished).toBe(false); // cannot stop while overrun is pending

      // 6. Eventual deregistration when close/settlement arrives after the bound
      lateResolveChild();
      await vi.advanceTimersByTimeAsync(50);
      expect(childSettled).toBe(true);

      // Child settled: deregistered, permit released, activeJobsCount back to 0
      expect(permitReleased).toBe(true);
      expect(mockPermit.release).toHaveBeenCalledTimes(1);
      expect(runner.cleanupOverrunCount).toBe(0);
      expect(runner.activeJobsCount).toBe(0);

      // Shutdown completes
      await stopPromise;
      expect(stopFinished).toBe(true);
    });

    it('keeps two same-jobId overruns both visible to activeJobsCount and stop()', async () => {
      const { runner, config } = createTestHarness();
      const jobId = '00000000-0000-0000-0000-000000000099';
      const workspaceId = '00000000-0000-0000-0000-000000000001';

      const stageA = runner
        .executeBoundedStage(
          runner.createDeadline(),
          3_000,
          'overrun-a',
          async () => new Promise<string>(() => undefined),
          { jobId, workspaceId },
        )
        .catch((error: unknown) => error);
      const stageB = runner
        .executeBoundedStage(
          runner.createDeadline(),
          3_000,
          'overrun-b',
          async () => new Promise<string>(() => undefined),
          { jobId, workspaceId },
        )
        .catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(config.stageCleanupTimeoutMs);

      const [errA, errB] = await Promise.all([stageA, stageB]);
      expect(errA).toBeInstanceOf(DeliveryDeadlineExceededError);
      expect(errB).toBeInstanceOf(DeliveryDeadlineExceededError);

      expect(runner.cleanupOverrunCount).toBe(2);
      expect(runner.activeJobsCount).toBe(2);
      expect(runner.inFlightCleanupRegistry.size).toBe(2);

      const entries = [...runner.inFlightCleanupRegistry.values()];
      expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
      expect(entries.every((entry) => entry.jobId === jobId)).toBe(true);

      let stopFinished = false;
      const stopPromise = runner.stop().then(() => {
        stopFinished = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(stopFinished).toBe(false);
      expect(runner.activeJobsCount).toBe(2);

      await vi.advanceTimersByTimeAsync(config.drainTimeoutSeconds * 1_000);
      await stopPromise;
      expect(stopFinished).toBe(true);
      expect(runner.activeJobsCount).toBe(2);
    });
  });

  describe('OCR sequential caps and DeliveryDeadline walk (S6 review binding item)', () => {
    it('consumes full sequential caps over a real DeliveryDeadline with lease safety and terminal reserve intact', () => {
      // Default config: visibility 300s, leaseSafety 20s, terminalReserve 10s
      const config = new WorkerConfig(1, 300, 1000, 30);
      const claimedAt = clockTime;
      const deadline = new DeliveryDeadline({
        visibilityTimeoutSeconds: config.visibilityTimeoutSeconds,
        leaseSafetyMs: config.leaseSafetyMs,
        terminalReserveMs: config.terminalReserveMs,
        minOperationMs: config.minOperationMs,
        claimedAt,
        clock: fakeClock,
      });

      // 1. Transition phase
      expect(deadline.forWork(config.transitionTimeoutMs)).toBe(
        config.transitionTimeoutMs,
      );
      clockTime += config.transitionTimeoutMs;
      expect(deadline.isWorkExhausted()).toBe(false);

      // 2. OCR compute phase
      expect(deadline.forWork(config.ocrComputeTimeoutMs)).toBe(
        config.ocrComputeTimeoutMs,
      );
      clockTime += config.ocrComputeTimeoutMs;
      expect(deadline.isWorkExhausted()).toBe(false);

      // 3. Storage download phase
      expect(deadline.forWork(config.storageDownloadTimeoutMs)).toBe(
        config.storageDownloadTimeoutMs,
      );
      clockTime += config.storageDownloadTimeoutMs;
      expect(deadline.isWorkExhausted()).toBe(false);

      // 4. OCR bounded stage (semaphore wait + OCR execution)
      expect(deadline.forWork(config.ocrTimeoutMs)).toBe(config.ocrTimeoutMs);
      // Semaphore wait consumes 5,000ms; OCR execution consumes remaining 25,000ms (total 30,000ms)
      clockTime += 5_000;
      expect(deadline.isWorkExhausted()).toBe(false);
      clockTime += config.ocrTimeoutMs - 5_000;
      expect(deadline.isWorkExhausted()).toBe(false);

      // 5. Stage cleanup overrun bound
      clockTime += config.stageCleanupTimeoutMs;
      expect(deadline.isWorkExhausted()).toBe(false);

      // 6. Persist phase
      expect(deadline.forWork(config.persistTimeoutMs)).toBe(
        config.persistTimeoutMs,
      );
      clockTime += config.persistTimeoutMs;

      // Terminal verification:
      // Terminal reserve is intact
      expect(deadline.remaining()).toBeGreaterThanOrEqual(
        config.terminalReserveMs,
      );
      expect(deadline.isTerminalExhausted()).toBe(false);

      // Lease safety is intact: remaining wall-clock time until visibility timeout >= leaseSafetyMs + terminalReserveMs
      const remainingVisibilityMs =
        claimedAt + config.visibilityTimeoutSeconds * 1_000 - clockTime;
      expect(remainingVisibilityMs).toBeGreaterThanOrEqual(
        config.leaseSafetyMs + config.terminalReserveMs,
      );

      // Terminal action (e.g. safeAck) has sufficient budget
      expect(
        deadline.forTerminal(config.transitionTimeoutMs),
      ).toBeGreaterThanOrEqual(config.minOperationMs);
    });

    it('tight visibility bound walk: proves double-subtracted lease safety fails the sequential budget', () => {
      // Configure a tight worker config with specific OCR caps
      // Caps: transition 10s, ocrCompute 10s, download 20s, ocr 30s, cleanup 2s, persist 10s = 82s
      // Reserves: leaseSafety 20s + terminalReserve 10s + 5*minOp 5s = 35s
      // receiptOcrBudgetMs = 82s + 35s = 117s = 117,000ms
      // Minimum valid visibility is 118s (118,000ms)
      const config = new WorkerConfig(
        1,
        118, // 118s visibility
        1000,
        30,
        undefined,
        5000,
        5,
        10_000, // transitionTimeoutMs
        60_000, // computeTimeoutMs (< 118,000ms)
        10_000, // persistTimeoutMs
        20_000, // leaseSafetyMs
        10_000, // terminalReserveMs
        1_000, // minOperationMs
        8_000, // queueTimeoutMs
        30_000, // storageUploadTimeoutMs
        30_000, // pdfRenderTimeoutMs
        30_000, // exportSerializeTimeoutMs
        2_000, // renderSettleTimeoutMs
        10_000, // rendererLaunchTimeoutMs
        10_000, // ocrComputeTimeoutMs
        20_000, // storageDownloadTimeoutMs
        30_000, // ocrTimeoutMs
        2_000, // stageCleanupTimeoutMs
      );

      const claimedAt = clockTime;
      const deadline = new DeliveryDeadline({
        visibilityTimeoutSeconds: config.visibilityTimeoutSeconds,
        leaseSafetyMs: config.leaseSafetyMs,
        terminalReserveMs: config.terminalReserveMs,
        minOperationMs: config.minOperationMs,
        claimedAt,
        clock: fakeClock,
      });

      // Walk each stage
      expect(deadline.forWork(config.transitionTimeoutMs)).toBe(
        config.transitionTimeoutMs,
      );
      clockTime += config.transitionTimeoutMs;

      expect(deadline.forWork(config.ocrComputeTimeoutMs)).toBe(
        config.ocrComputeTimeoutMs,
      );
      clockTime += config.ocrComputeTimeoutMs;

      expect(deadline.forWork(config.storageDownloadTimeoutMs)).toBe(
        config.storageDownloadTimeoutMs,
      );
      clockTime += config.storageDownloadTimeoutMs;

      expect(deadline.forWork(config.ocrTimeoutMs)).toBe(config.ocrTimeoutMs);
      clockTime += config.ocrTimeoutMs;

      clockTime += config.stageCleanupTimeoutMs;

      // Persist phase: under correct single-subtraction, full 10,000ms is available
      expect(deadline.forWork(config.persistTimeoutMs)).toBe(
        config.persistTimeoutMs,
      );
      clockTime += config.persistTimeoutMs;

      // Terminal reserve and lease safety intact
      expect(deadline.remaining()).toBeGreaterThanOrEqual(
        config.terminalReserveMs,
      );
      expect(deadline.isTerminalExhausted()).toBe(false);
      const remainingVisibilityMs =
        claimedAt + config.visibilityTimeoutSeconds * 1_000 - clockTime;
      expect(remainingVisibilityMs).toBeGreaterThanOrEqual(
        config.leaseSafetyMs + config.terminalReserveMs,
      );

      // PROOF: If lease safety had been double-subtracted (e.g. subtracted once in expiresAt
      // and again from remaining in forWork), total work capacity would be starved by 14s (20s - 6s margin):
      const doubleSubtractedRemainingWork =
        deadline.remaining() - config.terminalReserveMs - config.leaseSafetyMs;
      expect(doubleSubtractedRemainingWork).toBeLessThan(0);
      expect(doubleSubtractedRemainingWork).toBe(-14_000);
    });
  });
});
