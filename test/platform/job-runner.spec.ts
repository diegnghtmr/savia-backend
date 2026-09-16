import type { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DeliveryDeadlineExceededError } from '../../src/platform/delivery-deadline.js';
import type {
  JobExecutionContext,
  JobHandler,
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
import { WorkerConfig } from '../../src/platform/worker-config.js';

describe('JobRunner unit spec (S2)', () => {
  const wsId = '00000000-0000-0000-0000-000000000001';
  const jobId = '00000000-0000-0000-0000-000000000002';
  const actorId = '00000000-0000-0000-0000-000000000003';
  const resultResourceId = '00000000-0000-0000-0000-000000000004';

  function createTestHarness(
    options: {
      claimedMessages?: QueueMessage[];
      jobRow?: {
        id: string;
        workspace_id: string;
        created_by: string;
        type: string;
        status: string;
        payload: unknown;
        role: string | null;
      } | null;
      computeThrows?: boolean;
      computeError?: unknown;
      persistThrows?: boolean;
      persistError?: unknown;
      config?: WorkerConfig;
      batchSize?: number;
      mockTransaction?: Partial<PgTransaction>;
      clock?: () => number;
      reReadStatus?: string;
      reReadMissing?: boolean;
      reReadThrows?: unknown;
    } = {},
  ) {
    const callLog: string[] = [];

    const queueMessages: QueueMessage[] = options.claimedMessages ?? [
      {
        msgId: '101',
        readCt: 1,
        enqueuedAt: new Date().toISOString(),
        vt: new Date().toISOString(),
        message: {
          job_id: jobId,
          workspace_id: wsId,
          actor_id: actorId,
        },
      },
    ];

    const mockQueue: JobQueue = {
      claim: vi.fn().mockImplementation(async () => {
        callLog.push('claim');
        return queueMessages;
      }),
      ack: vi.fn().mockImplementation(async (msgId: number | string) => {
        callLog.push(`ack:${msgId}`);
        return true;
      }),
      archive: vi.fn().mockImplementation(async (msgId: number | string) => {
        callLog.push(`archive:${msgId}`);
        return true;
      }),
      defer: vi.fn().mockImplementation(async (msgId: number | string) => {
        callLog.push(`defer:${msgId}`);
        return true;
      }),
      failOrphanedJob: vi
        .fn()
        .mockImplementation(async (jId: string, aId: string) => {
          callLog.push(`fail_orphaned_job:${jId}:${aId}`);
          return true;
        }),
    };

    const defaultJobRow = {
      id: jobId,
      workspace_id: wsId,
      created_by: actorId,
      type: 'probe',
      status: 'queued',
      payload: { value: 42 },
      role: 'owner',
    };

    const activeJobRow =
      options.jobRow !== undefined ? options.jobRow : defaultJobRow;

    const mockClient: TransactionClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('from public.jobs')) {
          return { rows: activeJobRow ? [activeJobRow] : [] };
        }
        return { rows: [] };
      }),
    };

    const mockTransaction: Partial<PgTransaction> = {
      run: vi
        .fn()
        .mockImplementation(
          async (
            subject: string,
            callback: (client: TransactionClient) => Promise<unknown>,
          ) => {
            callLog.push(`run:${subject}`);
            return callback(mockClient);
          },
        ),
      runRead: vi
        .fn()
        .mockImplementation(
          async (
            subject: string,
            callback: (client: TransactionClient) => Promise<unknown>,
          ) => {
            callLog.push(`runRead:${subject}`);
            return callback(mockClient);
          },
        ),
      runAsQueueConsumer: vi
        .fn()
        .mockImplementation(
          async (callback: (client: TransactionClient) => Promise<unknown>) => {
            callLog.push('runAsQueueConsumer');
            return callback(mockClient);
          },
        ),
    };

    const mockJobWriter: Partial<JobWriter> = {
      transitionToProcessing: vi
        .fn()
        .mockImplementation(
          async (
            _client: TransactionClient,
            wId: string,
            jId: string,
            attemptCount?: number,
          ) => {
            callLog.push(
              `transitionToProcessing:${wId}:${jId}:${attemptCount}`,
            );
            return { id: jId, status: 'processing' };
          },
        ),
      completeJob: vi
        .fn()
        .mockImplementation(
          async (
            _client: TransactionClient,
            wId: string,
            jId: string,
            rId?: string | null,
          ) => {
            callLog.push(`completeJob:${wId}:${jId}:${rId}`);
            return { id: jId, status: 'completed' };
          },
        ),
      failJob: vi
        .fn()
        .mockImplementation(
          async (
            _client: TransactionClient,
            wId: string,
            jId: string,
            error: Record<string, unknown>,
          ) => {
            callLog.push(`failJob:${wId}:${jId}:${error.code}`);
            return { id: jId, status: 'failed' };
          },
        ),
      deadLetter: vi
        .fn()
        .mockImplementation(
          async (
            _client: TransactionClient,
            wId: string,
            jId: string,
            error: Record<string, unknown>,
          ) => {
            callLog.push(`deadLetter:${wId}:${jId}:${error.code}`);
            return { id: jId, status: 'dead_letter' };
          },
        ),
      findJobById: vi.fn().mockImplementation(async () => {
        callLog.push('findJobById');
        if (options.reReadThrows !== undefined) {
          throw options.reReadThrows;
        }
        if (options.reReadMissing) {
          return undefined;
        }
        return { status: options.reReadStatus ?? 'processing' };
      }),
    };

    const probeHandler: JobHandler<{ value: number }, { result: number }> = {
      jobType: 'probe',
      parsePayload: vi.fn((raw: unknown) => {
        callLog.push('parsePayload');
        return raw as { value: number };
      }),
      compute: vi.fn(
        async (
          ctx: JobExecutionContext<{ value: number }>,
          client: TransactionClient,
        ) => {
          void ctx;
          void client;
          callLog.push('compute');
          if (options.computeThrows) {
            throw (
              options.computeError ??
              Object.assign(new Error('Compute transient error'), {
                code: '40001',
              })
            );
          }
          return { result: 84 };
        },
      ),
      persist: vi.fn(
        async (
          ctx: JobExecutionContext<{ value: number }>,
          computed: { result: number },
          client: TransactionClient,
        ) => {
          void ctx;
          void computed;
          void client;
          callLog.push('persist');
          if (options.persistThrows) {
            throw (
              options.persistError ??
              Object.assign(new Error('Persist transient error'), {
                code: '40001',
              })
            );
          }
          return resultResourceId;
        },
      ),
      onFailure: vi.fn(async () => {
        callLog.push('onFailure');
      }),
    };

    const config =
      options.config ?? new WorkerConfig(options.batchSize ?? 1, 300, 1000, 30);
    const effectiveTransaction = options.mockTransaction ?? mockTransaction;
    const runner = new JobRunner(
      mockQueue,
      effectiveTransaction as PgTransaction,
      mockJobWriter as JobWriter,
      config,
      [probeHandler],
      options.clock,
    );

    return {
      runner,
      mockQueue,
      mockTransaction: effectiveTransaction,
      mockJobWriter,
      probeHandler,
      callLog,
    };
  }

  it('executes in order: claim -> validate envelope -> processing (attempt_count = read_ct) -> compute (read-only tx) -> persist + completed (short write tx) -> ack_job', async () => {
    const { runner, mockQueue, mockJobWriter, probeHandler, callLog } =
      createTestHarness();

    const processed = await runner.runOnce();
    expect(processed).toBe(1);

    expect(mockQueue.claim).toHaveBeenCalledWith(300, 1, expect.any(Number));
    expect(mockJobWriter.transitionToProcessing).toHaveBeenCalledWith(
      expect.anything(),
      wsId,
      jobId,
      1,
    );
    expect(probeHandler.compute).toHaveBeenCalled();
    expect(probeHandler.persist).toHaveBeenCalled();
    expect(mockJobWriter.completeJob).toHaveBeenCalledWith(
      expect.anything(),
      wsId,
      jobId,
      resultResourceId,
    );
    expect(mockQueue.ack).toHaveBeenCalledWith('101', expect.any(Number));

    // Verify ordering
    expect(callLog).toEqual([
      'claim',
      `run:${actorId}`, // T1 processing
      `transitionToProcessing:${wsId}:${jobId}:1`,
      'parsePayload',
      `runRead:${actorId}`, // read-only compute
      'compute',
      `run:${actorId}`, // T2 persist + complete
      'persist',
      `completeJob:${wsId}:${jobId}:${resultResourceId}`,
      'ack:101',
    ]);
  });

  it('bounds render and storage with independent caps rather than a summed budget', async () => {
    const { runner, probeHandler } = createTestHarness();
    const renderTimeouts: number[] = [];
    const storeTimeouts: number[] = [];
    probeHandler.render = vi.fn(async (_context, _computed, timeoutMs) => {
      renderTimeouts.push(timeoutMs);
      return { content: Buffer.from('{}'), contentType: 'application/json' };
    });
    probeHandler.store = vi.fn(async (_context, _rendered, timeoutMs) => {
      storeTimeouts.push(timeoutMs);
      return { result: 84 };
    });

    const processed = await runner.runOnce();
    expect(processed).toBe(1);
    expect(renderTimeouts).toEqual([30_000]);
    expect(storeTimeouts).toEqual([30_000]);
    expect(probeHandler.render).toHaveBeenCalledOnce();
    expect(probeHandler.store).toHaveBeenCalledOnce();
  });

  it('skips a job already terminal at re-check and acks it without running compute or persist', async () => {
    const { runner, mockQueue, mockJobWriter, probeHandler, callLog } =
      createTestHarness({
        jobRow: {
          id: jobId,
          workspace_id: wsId,
          created_by: actorId,
          type: 'probe',
          status: 'completed', // Already terminal
          payload: { value: 42 },
          role: 'owner',
        },
      });

    const processed = await runner.runOnce();
    expect(processed).toBe(1);

    expect(mockJobWriter.transitionToProcessing).not.toHaveBeenCalled();
    expect(probeHandler.compute).not.toHaveBeenCalled();
    expect(probeHandler.persist).not.toHaveBeenCalled();
    expect(mockQueue.ack).toHaveBeenCalledWith('101', expect.any(Number));

    expect(callLog).toEqual(['claim', `run:${actorId}`, 'ack:101']);
  });

  it('acks and stops without failure write or dead-letter when completeJob refuses because job is already terminal', async () => {
    const alreadyTerminalError = Object.assign(
      new Error(
        `Cannot complete job ${jobId}: expected status processing, got completed`,
      ),
      { code: 'P0001' },
    );

    const { runner, mockQueue, mockJobWriter } = createTestHarness({
      reReadStatus: 'completed',
    });

    mockJobWriter.completeJob = vi.fn().mockRejectedValue(alreadyTerminalError);

    const processed = await runner.runOnce();
    expect(processed).toBe(1);

    expect(mockJobWriter.findJobById).toHaveBeenCalledTimes(1);
    expect(mockQueue.ack).toHaveBeenCalledTimes(1);
    expect(mockJobWriter.failJob).not.toHaveBeenCalled();
    expect(mockJobWriter.deadLetter).not.toHaveBeenCalled();
  });

  it('acks once and skips failJob when completeJob raises P0001 and the re-read status is completed', async () => {
    const p0001 = Object.assign(new Error('complete_job refused'), {
      code: 'P0001',
    });
    const { runner, mockQueue, mockJobWriter } = createTestHarness({
      reReadStatus: 'completed',
    });
    mockJobWriter.completeJob = vi.fn().mockRejectedValue(p0001);

    const processed = await runner.runOnce();
    expect(processed).toBe(1);
    expect(mockQueue.ack).toHaveBeenCalledTimes(1);
    expect(mockJobWriter.failJob).not.toHaveBeenCalled();
    expect(mockJobWriter.deadLetter).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed', 'cancelled', 'dead_letter'] as const)(
    'runs the permanent-failure path when persist raises P0001 whose message contains %s and the re-read is processing',
    async (terminalWord) => {
      const persistError = Object.assign(
        new Error(`Report generation ${terminalWord}`),
        { code: 'P0001' },
      );
      const { runner, mockQueue, mockJobWriter, callLog } = createTestHarness({
        persistThrows: true,
        persistError,
        reReadStatus: 'processing',
      });

      const processed = await runner.runOnce();
      expect(processed).toBe(1);

      expect(mockJobWriter.findJobById).toHaveBeenCalledTimes(1);
      expect(mockJobWriter.failJob).toHaveBeenCalledTimes(1);
      expect(mockJobWriter.deadLetter).not.toHaveBeenCalled();
      expect(mockQueue.ack).toHaveBeenCalledTimes(1);
      const failIndex = callLog.findIndex((entry) =>
        entry.startsWith('failJob:'),
      );
      const ackIndex = callLog.indexOf('ack:101');
      expect(failIndex).toBeGreaterThan(-1);
      expect(ackIndex).toBeGreaterThan(failIndex);
    },
  );

  it('runs the permanent-failure path when persist raises P0001 "Report generation failed" and the re-read is processing', async () => {
    const persistError = Object.assign(new Error('Report generation failed'), {
      code: 'P0001',
    });
    const { runner, mockQueue, mockJobWriter, callLog } = createTestHarness({
      persistThrows: true,
      persistError,
      reReadStatus: 'processing',
    });

    const processed = await runner.runOnce();
    expect(processed).toBe(1);

    expect(mockJobWriter.failJob).toHaveBeenCalledTimes(1);
    expect(mockQueue.ack).toHaveBeenCalledTimes(1);
    expect(mockJobWriter.deadLetter).not.toHaveBeenCalled();
    expect(callLog.indexOf('ack:101')).toBeGreaterThan(
      callLog.findIndex((entry) => entry.startsWith('failJob:')),
    );
  });

  it('acks once and skips further writes when invalid-payload failJob raises P0001 and the re-read status is completed', async () => {
    const { runner, mockQueue, mockJobWriter, probeHandler } =
      createTestHarness({
        reReadStatus: 'completed',
      });
    vi.mocked(probeHandler.parsePayload).mockImplementation(() => {
      throw new Error('Invalid payload');
    });
    mockJobWriter.failJob = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('fail_job refused'), { code: 'P0001' }),
      );

    const processed = await runner.runOnce();
    expect(processed).toBe(1);
    expect(mockJobWriter.findJobById).toHaveBeenCalledTimes(1);
    expect(mockQueue.ack).toHaveBeenCalledTimes(1);
    expect(mockJobWriter.failJob).toHaveBeenCalledTimes(1);
    expect(mockJobWriter.completeJob).not.toHaveBeenCalled();
    expect(mockJobWriter.deadLetter).not.toHaveBeenCalled();
    expect(probeHandler.compute).not.toHaveBeenCalled();
    expect(probeHandler.persist).not.toHaveBeenCalled();
  });

  it('calls fail_orphaned_job and acks message when actor is invisible or demoted', async () => {
    // Demoted actor: role is viewer (lacks write role)
    const { runner, mockQueue, probeHandler, callLog } = createTestHarness({
      jobRow: {
        id: jobId,
        workspace_id: wsId,
        created_by: actorId,
        type: 'probe',
        status: 'queued',
        payload: { value: 42 },
        role: 'viewer', // demoted!
      },
    });

    const processed = await runner.runOnce();
    expect(processed).toBe(1);

    expect(mockQueue.failOrphanedJob).toHaveBeenCalledWith(
      jobId,
      actorId,
      expect.any(Number),
    );
    expect(mockQueue.ack).toHaveBeenCalledWith('101', expect.any(Number));
    expect(probeHandler.compute).not.toHaveBeenCalled();
    expect(probeHandler.persist).not.toHaveBeenCalled();

    expect(callLog).toEqual([
      'claim',
      `run:${actorId}`,
      `fail_orphaned_job:${jobId}:${actorId}`,
      'ack:101',
    ]);
  });

  it('calls fail_orphaned_job and acks message when envelope workspace does not match job workspace', async () => {
    const { runner, mockQueue, probeHandler } = createTestHarness({
      jobRow: {
        id: jobId,
        workspace_id: '00000000-0000-0000-0000-999999999999', // Different workspace
        created_by: actorId,
        type: 'probe',
        status: 'queued',
        payload: { value: 42 },
        role: 'owner',
      },
    });

    const processed = await runner.runOnce();
    expect(processed).toBe(1);

    expect(mockQueue.failOrphanedJob).toHaveBeenCalledWith(
      jobId,
      actorId,
      expect.any(Number),
    );
    expect(mockQueue.ack).toHaveBeenCalledWith('101', expect.any(Number));
    expect(probeHandler.compute).not.toHaveBeenCalled();
  });

  it('leaves the message unacked and defers with backoff when compute throws a transient error, and does not crash the loop', async () => {
    const { runner, mockQueue, probeHandler, callLog } = createTestHarness({
      computeThrows: true,
    });

    await expect(runner.runOnce()).resolves.toBe(1);

    expect(probeHandler.compute).toHaveBeenCalled();
    expect(probeHandler.persist).not.toHaveBeenCalled();
    // Message MUST NOT be acked; it should be deferred
    expect(mockQueue.ack).not.toHaveBeenCalled();
    expect(mockQueue.defer).toHaveBeenCalledWith(
      '101',
      expect.any(Number),
      expect.any(Number),
    );

    expect(callLog).toContain('compute');
    expect(callLog).toContain('onFailure');
    expect(callLog).not.toContain('ack:101');
    expect(callLog).toContain('defer:101');
  });

  it('produces non-decreasing backoff delays drawn from [d(n)/2, d(n)] across two successive transient failures with seeded random', async () => {
    let callIndex = 0;
    const seedValues = [0.4, 0.6];
    const randomSpy = vi
      .spyOn(Math, 'random')
      .mockImplementation(() => seedValues[callIndex++ % seedValues.length]);

    try {
      const message1: QueueMessage = {
        msgId: '101',
        readCt: 1,
        enqueuedAt: new Date().toISOString(),
        vt: new Date().toISOString(),
        message: { job_id: jobId, workspace_id: wsId, actor_id: actorId },
      };
      const message2: QueueMessage = {
        msgId: '101',
        readCt: 2,
        enqueuedAt: new Date().toISOString(),
        vt: new Date().toISOString(),
        message: { job_id: jobId, workspace_id: wsId, actor_id: actorId },
      };

      const messagesQueue = [message1, message2];
      let claimIndex = 0;

      const { runner, mockQueue } = createTestHarness({
        computeThrows: true,
        computeError: Object.assign(
          new Error('Transient serialization failure'),
          {
            code: '40001',
          },
        ),
      });

      mockQueue.claim = vi.fn().mockImplementation(async () => {
        const msg = messagesQueue[claimIndex++];
        return msg ? [msg] : [];
      });

      // Attempt 1 (readCt = 1): d(1) = 5, [2.5, 5] with seed 0.4 -> 2.5 + 0.4 * 2.5 = 3.5 -> round = 4
      await expect(runner.runOnce()).resolves.toBe(1);
      // Attempt 2 (readCt = 2): d(2) = 10, [5, 10] with seed 0.6 -> 5 + 0.6 * 5 = 8.0 -> round = 8
      await expect(runner.runOnce()).resolves.toBe(1);

      expect(mockQueue.defer).toHaveBeenCalledTimes(2);
      expect(mockQueue.defer).toHaveBeenNthCalledWith(
        1,
        '101',
        4,
        expect.any(Number),
      );
      expect(mockQueue.defer).toHaveBeenNthCalledWith(
        2,
        '101',
        8,
        expect.any(Number),
      );

      const firstDelay = vi.mocked(mockQueue.defer).mock.calls[0][1] as number;
      const secondDelay = vi.mocked(mockQueue.defer).mock.calls[1][1] as number;

      // d(1) = 5 -> [2.5, 5]
      expect(firstDelay).toBeGreaterThanOrEqual(2.5);
      expect(firstDelay).toBeLessThanOrEqual(5);

      // d(2) = 10 -> [5, 10]
      expect(secondDelay).toBeGreaterThanOrEqual(5);
      expect(secondDelay).toBeLessThanOrEqual(10);

      // Non-decreasing progression
      expect(secondDelay).toBeGreaterThanOrEqual(firstDelay);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('marks job as failed and acks the message when compute throws a permanent error', async () => {
    const { runner, mockQueue, mockJobWriter, probeHandler, callLog } =
      createTestHarness({
        computeThrows: true,
        computeError: Object.assign(new Error('Invalid column value'), {
          code: '22001',
        }),
      });

    await expect(runner.runOnce()).resolves.toBe(1);

    expect(probeHandler.compute).toHaveBeenCalled();
    expect(probeHandler.persist).not.toHaveBeenCalled();
    expect(mockJobWriter.failJob).toHaveBeenCalledWith(
      expect.anything(),
      wsId,
      jobId,
      expect.objectContaining({
        type: 'https://savia.app/problems/job-failed',
        title: 'Job Failed',
        status: 500,
        code: 'job_failed',
      }),
    );
    expect(mockQueue.ack).toHaveBeenCalledWith('101', expect.any(Number));
    expect(mockQueue.defer).not.toHaveBeenCalled();

    expect(callLog).toContain('compute');
    expect(callLog).toContain('onFailure');
    expect(callLog).toContain('ack:101');
  });

  it('dead-letters the job and archives the message when transient compute error reaches maxAttempts', async () => {
    const { runner, mockQueue, mockJobWriter, probeHandler, callLog } =
      createTestHarness({
        claimedMessages: [
          {
            msgId: '101',
            readCt: 5, // maxAttempts reached
            enqueuedAt: new Date().toISOString(),
            vt: new Date().toISOString(),
            message: {
              job_id: jobId,
              workspace_id: wsId,
              actor_id: actorId,
            },
          },
        ],
        computeThrows: true,
        computeError: Object.assign(new Error('Transient deadlock'), {
          code: '40P01',
        }),
      });

    await expect(runner.runOnce()).resolves.toBe(1);

    expect(probeHandler.compute).toHaveBeenCalled();
    expect(mockJobWriter.deadLetter).toHaveBeenCalledWith(
      expect.anything(),
      wsId,
      jobId,
      expect.objectContaining({
        type: 'https://savia.app/problems/job-exhausted',
        title: 'Job Retries Exhausted',
        status: 500,
        code: 'job_retries_exhausted',
      }),
    );
    // MUST archive message, NOT ack, NOT defer
    expect(mockQueue.archive).toHaveBeenCalledWith('101', expect.any(Number));
    expect(mockQueue.ack).not.toHaveBeenCalled();
    expect(mockQueue.defer).not.toHaveBeenCalled();

    // Verify ordering: deadLetter before archive
    const deadLetterIdx = callLog.findIndex((c) => c.startsWith('deadLetter:'));
    const archiveIdx = callLog.indexOf('archive:101');
    expect(deadLetterIdx).toBeGreaterThanOrEqual(0);
    expect(archiveIdx).toBeGreaterThan(deadLetterIdx);
  });

  it('dead-letters the job and archives the message when claim-time read_ct > maxAttempts without running compute', async () => {
    const { runner, mockQueue, mockJobWriter, probeHandler, callLog } =
      createTestHarness({
        claimedMessages: [
          {
            msgId: '101',
            readCt: 6, // > maxAttempts (5)
            enqueuedAt: new Date().toISOString(),
            vt: new Date().toISOString(),
            message: {
              job_id: jobId,
              workspace_id: wsId,
              actor_id: actorId,
            },
          },
        ],
      });

    await expect(runner.runOnce()).resolves.toBe(1);

    expect(probeHandler.compute).not.toHaveBeenCalled();
    expect(mockJobWriter.deadLetter).toHaveBeenCalledWith(
      expect.anything(),
      wsId,
      jobId,
      expect.objectContaining({
        type: 'https://savia.app/problems/job-exhausted',
        title: 'Job Retries Exhausted',
        status: 500,
        code: 'job_retries_exhausted',
      }),
    );
    expect(mockQueue.archive).toHaveBeenCalledWith('101', expect.any(Number));
    expect(mockQueue.ack).not.toHaveBeenCalled();

    // Verify ordering: deadLetter before archive
    const deadLetterIdx = callLog.findIndex((c) => c.startsWith('deadLetter:'));
    const archiveIdx = callLog.indexOf('archive:101');
    expect(deadLetterIdx).toBeGreaterThanOrEqual(0);
    expect(archiveIdx).toBeGreaterThan(deadLetterIdx);
  });

  it('defers with backoff when persist throws a transient error and read_ct < maxAttempts', async () => {
    const { runner, mockQueue, probeHandler, callLog } = createTestHarness({
      persistThrows: true,
      persistError: Object.assign(
        new Error('Serialization failure in persist'),
        {
          code: '40001',
        },
      ),
    });

    await expect(runner.runOnce()).resolves.toBe(1);

    expect(probeHandler.compute).toHaveBeenCalled();
    expect(probeHandler.persist).toHaveBeenCalled();
    expect(mockQueue.defer).toHaveBeenCalledWith(
      '101',
      expect.any(Number),
      expect.any(Number),
    );
    expect(mockQueue.ack).not.toHaveBeenCalled();
    expect(callLog).toContain('defer:101');
  });

  it('dead-letters the job and archives the message when persist transient error reaches maxAttempts', async () => {
    const { runner, mockQueue, mockJobWriter, probeHandler, callLog } =
      createTestHarness({
        claimedMessages: [
          {
            msgId: '101',
            readCt: 5,
            enqueuedAt: new Date().toISOString(),
            vt: new Date().toISOString(),
            message: {
              job_id: jobId,
              workspace_id: wsId,
              actor_id: actorId,
            },
          },
        ],
        persistThrows: true,
        persistError: Object.assign(
          new Error('Connection lost during persist'),
          {
            code: '08006',
          },
        ),
      });

    await expect(runner.runOnce()).resolves.toBe(1);

    expect(probeHandler.compute).toHaveBeenCalled();
    expect(probeHandler.persist).toHaveBeenCalled();
    expect(mockJobWriter.deadLetter).toHaveBeenCalledWith(
      expect.anything(),
      wsId,
      jobId,
      expect.objectContaining({
        type: 'https://savia.app/problems/job-exhausted',
        title: 'Job Retries Exhausted',
      }),
    );
    expect(mockQueue.archive).toHaveBeenCalledWith('101', expect.any(Number));
    expect(mockQueue.ack).not.toHaveBeenCalled();
    expect(mockQueue.defer).not.toHaveBeenCalled();

    const deadLetterIdx = callLog.findIndex((c) => c.startsWith('deadLetter:'));
    const archiveIdx = callLog.indexOf('archive:101');
    expect(deadLetterIdx).toBeGreaterThanOrEqual(0);
    expect(archiveIdx).toBeGreaterThan(deadLetterIdx);
  });

  it('archives the message, logs an error, and does not run domain work when actor_id is missing', async () => {
    const { runner, mockQueue, mockJobWriter, probeHandler, callLog } =
      createTestHarness({
        claimedMessages: [
          {
            msgId: '201',
            readCt: 1,
            enqueuedAt: new Date().toISOString(),
            vt: new Date().toISOString(),
            message: {
              job_id: jobId,
              workspace_id: wsId,
            },
          },
        ],
      });

    const processed = await runner.runOnce();
    expect(processed).toBe(1);

    expect(mockQueue.archive).toHaveBeenCalledWith('201', expect.any(Number));
    expect(mockQueue.ack).not.toHaveBeenCalled();
    expect(mockQueue.failOrphanedJob).not.toHaveBeenCalled();
    expect(mockJobWriter.transitionToProcessing).not.toHaveBeenCalled();
    expect(probeHandler.compute).not.toHaveBeenCalled();
    expect(probeHandler.persist).not.toHaveBeenCalled();
    expect(callLog).toEqual(['claim', 'archive:201']);
  });

  it('archives the message, logs an error, and does not run domain work when actor_id is not a valid uuid', async () => {
    const { runner, mockQueue, mockJobWriter, probeHandler, callLog } =
      createTestHarness({
        claimedMessages: [
          {
            msgId: '202',
            readCt: 1,
            enqueuedAt: new Date().toISOString(),
            vt: new Date().toISOString(),
            message: {
              job_id: jobId,
              workspace_id: wsId,
              actor_id: 'not-a-valid-uuid',
            },
          },
        ],
      });

    const processed = await runner.runOnce();
    expect(processed).toBe(1);

    expect(mockQueue.archive).toHaveBeenCalledWith('202', expect.any(Number));
    expect(mockQueue.ack).not.toHaveBeenCalled();
    expect(mockQueue.failOrphanedJob).not.toHaveBeenCalled();
    expect(mockJobWriter.transitionToProcessing).not.toHaveBeenCalled();
    expect(probeHandler.compute).not.toHaveBeenCalled();
    expect(probeHandler.persist).not.toHaveBeenCalled();
    expect(callLog).toEqual(['claim', 'archive:202']);
  });

  it('processes claimed messages concurrently within a batch, proving both start before either finishes', async () => {
    vi.useFakeTimers();
    try {
      const startLog: string[] = [];
      const finishLog: string[] = [];

      const jobId1 = '00000000-0000-0000-0000-000000000002';
      const jobId2 = '00000000-0000-0000-0000-000000000022';

      const messages: QueueMessage[] = [
        {
          msgId: '101',
          readCt: 1,
          enqueuedAt: new Date().toISOString(),
          vt: new Date().toISOString(),
          message: {
            job_id: jobId1,
            workspace_id: wsId,
            actor_id: actorId,
          },
        },
        {
          msgId: '102',
          readCt: 1,
          enqueuedAt: new Date().toISOString(),
          vt: new Date().toISOString(),
          message: {
            job_id: jobId2,
            workspace_id: wsId,
            actor_id: actorId,
          },
        },
      ];

      const { runner, probeHandler, mockQueue } = createTestHarness({
        claimedMessages: messages,
        config: new WorkerConfig(2, 300, 1000, 30),
      });

      probeHandler.compute = vi.fn(
        async (ctx: JobExecutionContext<{ value: number }>) => {
          startLog.push(`start:${ctx.jobId}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
          finishLog.push(`finish:${ctx.jobId}`);
          return { result: 84 };
        },
      );

      const runPromise = runner.runOnce();

      // Flush microtasks to allow synchronous start and transition of both jobs
      await vi.advanceTimersByTimeAsync(0);

      // Both jobs must have started before either finishes
      expect(startLog).toContain(`start:${jobId1}`);
      expect(startLog).toContain(`start:${jobId2}`);
      expect(finishLog).toHaveLength(0);

      // Advance clock past compute duration
      await vi.advanceTimersByTimeAsync(100);

      const processedCount = await runPromise;
      expect(processedCount).toBe(2);

      // Both jobs must have finished
      expect(finishLog).toContain(`finish:${jobId1}`);
      expect(finishLog).toContain(`finish:${jobId2}`);
      expect(mockQueue.ack).toHaveBeenCalledWith('101', expect.any(Number));
      expect(mockQueue.ack).toHaveBeenCalledWith('102', expect.any(Number));
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for pending claim when stop() is called and does not process the claimed messages', async () => {
    let resolveClaim!: (messages: QueueMessage[]) => void;
    const claimPending = new Promise<QueueMessage[]>((resolve) => {
      resolveClaim = resolve;
    });

    const messages: QueueMessage[] = [
      {
        msgId: '101',
        readCt: 1,
        enqueuedAt: new Date().toISOString(),
        vt: new Date().toISOString(),
        message: {
          job_id: jobId,
          workspace_id: wsId,
          actor_id: actorId,
        },
      },
    ];

    const { runner, mockQueue, probeHandler, mockJobWriter } =
      createTestHarness();
    mockQueue.claim = vi.fn().mockImplementation(() => claimPending);

    const runPromise = runner.runOnce();

    // Let microtasks tick so runOnce reaches queue.claim
    await new Promise((resolve) => setTimeout(resolve, 10));

    let stopFinished = false;
    const stopPromise = runner.stop().then(() => {
      stopFinished = true;
    });

    // Stop must NOT finish yet because claim is pending and counted as active
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopFinished).toBe(false);

    // Resolve the pending claim with messages
    resolveClaim(messages);

    const processedCount = await runPromise;
    await stopPromise;

    expect(processedCount).toBe(0);
    expect(stopFinished).toBe(true);

    // Claimed messages must NOT be processed or acked
    expect(mockJobWriter.transitionToProcessing).not.toHaveBeenCalled();
    expect(probeHandler.compute).not.toHaveBeenCalled();
    expect(probeHandler.persist).not.toHaveBeenCalled();
    expect(mockQueue.ack).not.toHaveBeenCalled();
  });

  it('processes completing message and continues loop when another message in the batch rejects', async () => {
    const jobId1 = '00000000-0000-0000-0000-000000000002';
    const jobId2 = '00000000-0000-0000-0000-000000000022';

    const messages: QueueMessage[] = [
      {
        msgId: '101',
        readCt: 1,
        enqueuedAt: new Date().toISOString(),
        vt: new Date().toISOString(),
        message: {
          job_id: jobId1,
          workspace_id: wsId,
          actor_id: actorId,
        },
      },
      {
        msgId: '102',
        readCt: 1,
        enqueuedAt: new Date().toISOString(),
        vt: new Date().toISOString(),
        message: {
          job_id: jobId2,
          workspace_id: wsId,
          actor_id: actorId,
        },
      },
    ];

    const { runner, mockQueue } = createTestHarness({
      claimedMessages: messages,
      config: new WorkerConfig(2, 300, 1000, 30),
    });

    const originalProcessMessage = runner.processMessage.bind(runner);
    vi.spyOn(runner, 'processMessage').mockImplementation(async (msg) => {
      if (msg.msgId === '101') {
        throw new Error('Unexpected processMessage rejection');
      }
      return originalProcessMessage(msg);
    });

    const processedCount = await runner.runOnce();
    expect(processedCount).toBe(1);

    expect(mockQueue.ack).toHaveBeenCalledWith('102', expect.any(Number));
    expect(mockQueue.ack).not.toHaveBeenCalledWith('101', expect.anything());
  });

  describe('Delivery deadline (S3 Round 3)', () => {
    interface RecordedCall {
      operation: string;
      timeout: number;
      remainingBefore: number;
    }

    function createRecordingTestHarness(options: {
      config?: WorkerConfig;
      jobRow?: Record<string, unknown>;
      computeThrows?: boolean;
      computeError?: unknown;
      persistThrows?: boolean;
      persistError?: unknown;
      readCt?: number;
      includeOnFailure?: boolean;
      reReadStatus?: string;
      reReadThrows?: unknown;
      exhaustWorkBeforeRecheck?: boolean;
    }) {
      let currentClock = 1_000;
      const clock = () => currentClock;
      const config = options.config ?? new WorkerConfig(1, 300, 1000, 30);
      const recordedCalls: RecordedCall[] = [];

      const expiresAt =
        1_000 + config.visibilityTimeoutSeconds * 1_000 - config.leaseSafetyMs;

      const getRemaining = () => {
        return Math.max(0, expiresAt - currentClock);
      };

      const recordAndAdvance = (operation: string, timeout: number) => {
        const remainingBefore = getRemaining();
        recordedCalls.push({ operation, timeout, remainingBefore });
        currentClock += timeout;
        if (currentClock >= expiresAt) {
          throw new DeliveryDeadlineExceededError();
        }
      };

      const recordingQueue: JobQueue = {
        claim: vi.fn().mockImplementation(async (_vt, _limit, timeoutMs) => {
          recordedCalls.push({
            operation: 'claim',
            timeout: timeoutMs ?? 0,
            remainingBefore: Number.POSITIVE_INFINITY,
          });
          return [
            {
              msgId: '101',
              readCt: options.readCt ?? 1,
              enqueuedAt: new Date().toISOString(),
              vt: new Date().toISOString(),
              message: {
                job_id: jobId,
                workspace_id: wsId,
                actor_id: actorId,
              },
            },
          ];
        }),
        ack: vi.fn().mockImplementation(async (_msgId, timeoutMs) => {
          recordAndAdvance('ack', timeoutMs ?? 0);
          return true;
        }),
        archive: vi.fn().mockImplementation(async (_msgId, timeoutMs) => {
          recordAndAdvance('archive', timeoutMs ?? 0);
          return true;
        }),
        defer: vi.fn().mockImplementation(async (_msgId, _delay, timeoutMs) => {
          recordAndAdvance('defer', timeoutMs ?? 0);
          return true;
        }),
        failOrphanedJob: vi
          .fn()
          .mockImplementation(async (_jId, _aId, timeoutMs) => {
            recordAndAdvance('failOrphanedJob', timeoutMs ?? 0);
            return true;
          }),
      };

      const activeJobRow = options.jobRow ?? {
        id: jobId,
        workspace_id: wsId,
        created_by: actorId,
        type: 'probe',
        status: 'queued',
        payload: { value: 42 },
        role: 'owner',
      };

      const recordingTransaction: Partial<PgTransaction> = {
        run: vi
          .fn()
          .mockImplementation(
            async (_subject, callback, context, phase, timeoutMs) => {
              const effectivePhase = phase ?? context?.phase ?? 'transition';
              recordAndAdvance(`run:${effectivePhase}`, timeoutMs ?? 0);
              const client: TransactionClient = {
                query: vi.fn().mockImplementation(async (sql: string) => {
                  if (sql.includes('from public.jobs')) {
                    return { rows: [activeJobRow] };
                  }
                  return { rows: [] };
                }),
              };
              return callback(client);
            },
          ),
        runRead: vi
          .fn()
          .mockImplementation(async (_subject, callback, optionsOrTimeout) => {
            const timeoutMs =
              typeof optionsOrTimeout === 'number'
                ? optionsOrTimeout
                : optionsOrTimeout?.timeoutMs;
            const alreadyComputed = recordedCalls.some(
              (call) => call.operation === 'runRead:compute',
            );
            const label = alreadyComputed
              ? 'runRead:status'
              : 'runRead:compute';
            if (label === 'runRead:status') {
              recordedCalls.push({
                operation: label,
                timeout: timeoutMs ?? 0,
                remainingBefore: getRemaining(),
              });
              currentClock += 1;
            } else {
              recordAndAdvance(label, timeoutMs ?? 0);
            }
            if (!alreadyComputed && options.computeThrows) {
              throw (
                options.computeError ??
                Object.assign(new Error('Compute error'), { code: '23505' })
              );
            }
            const client: TransactionClient = {
              query: vi.fn().mockResolvedValue({ rows: [] }),
            };
            return callback(client);
          }),
      };

      const recordingJobWriter: Partial<JobWriter> = {
        transitionToProcessing: vi.fn().mockResolvedValue({ id: jobId }),
        completeJob: vi.fn().mockResolvedValue({ id: jobId }),
        failJob: vi.fn().mockResolvedValue({ id: jobId }),
        deadLetter: vi.fn().mockResolvedValue({ id: jobId }),
        findJobById: vi.fn().mockImplementation(async () => {
          if (options.reReadThrows !== undefined) {
            throw options.reReadThrows;
          }
          return { status: options.reReadStatus ?? 'processing' };
        }),
      };

      const probeHandler: JobHandler<{ value: number }, { result: number }> = {
        jobType: 'probe',
        parsePayload: (raw: unknown) => raw as { value: number },
        compute: vi.fn(async () => {
          return { result: 84 };
        }),
        persist: vi.fn(async () => {
          if (options.persistThrows) {
            if (options.exhaustWorkBeforeRecheck) {
              currentClock = expiresAt;
            }
            throw (
              options.persistError ??
              Object.assign(new Error('Persist error'), { code: '23505' })
            );
          }
          return resultResourceId;
        }),
      };

      if (options.includeOnFailure) {
        probeHandler.onFailure = vi.fn(
          async (_ctx, _err, _client, timeoutMs) => {
            recordAndAdvance('onFailure', timeoutMs ?? 0);
          },
        );
      }

      const runner = new JobRunner(
        recordingQueue,
        recordingTransaction as PgTransaction,
        recordingJobWriter as JobWriter,
        config,
        [probeHandler],
        clock,
      );

      return {
        runner,
        recordingQueue,
        recordingTransaction,
        recordingJobWriter,
        probeHandler,
        recordedCalls,
        getClock: () => currentClock,
        advanceClock: (delta: number) => {
          currentClock += delta;
        },
      };
    }

    it('recording test — path 1: success path (transition -> compute -> persist -> ack)', async () => {
      const { runner, recordedCalls, getClock } = createRecordingTestHarness(
        {},
      );
      const processed = await runner.runOnce();
      expect(processed).toBe(1);

      expect(recordedCalls.map((c) => c.operation)).toEqual([
        'claim',
        'run:transition',
        'runRead:compute',
        'run:persist',
        'ack',
      ]);

      const deliveryCalls = recordedCalls.filter(
        (c) => c.operation !== 'claim',
      );
      expect(deliveryCalls).toHaveLength(4);

      for (const call of deliveryCalls) {
        expect(call.timeout).toBeGreaterThan(0);
        expect(call.timeout).toBeLessThanOrEqual(call.remainingBefore);
      }

      const expiresAt = 1_000 + 300_000 - 20_000;
      expect(getClock()).toBeLessThan(expiresAt);
    });

    it('recording test — path 2: permanent compute failure (transition -> compute -> onFailure -> failJob -> ack)', async () => {
      const { runner, recordedCalls, getClock } = createRecordingTestHarness({
        computeThrows: true,
        computeError: { code: '23505' }, // permanent
        includeOnFailure: true,
      });
      const processed = await runner.runOnce();
      expect(processed).toBe(1);

      expect(recordedCalls.map((c) => c.operation)).toEqual([
        'claim',
        'run:transition',
        'runRead:compute',
        'onFailure',
        'run:transition',
        'ack',
      ]);

      const deliveryCalls = recordedCalls.filter(
        (c) => c.operation !== 'claim',
      );
      expect(deliveryCalls).toHaveLength(5);

      for (const call of deliveryCalls) {
        expect(call.timeout).toBeGreaterThan(0);
        expect(call.timeout).toBeLessThanOrEqual(call.remainingBefore);
      }

      const expiresAt = 1_000 + 300_000 - 20_000;
      expect(getClock()).toBeLessThan(expiresAt);
    });

    it('recording test — path 3: transient compute failure at attempt limit (transition -> compute -> onFailure -> deadLetter -> archive)', async () => {
      const { runner, recordedCalls, getClock } = createRecordingTestHarness({
        computeThrows: true,
        computeError: { code: '40001' }, // transient
        readCt: 5, // maxAttempts
        includeOnFailure: true,
      });
      const processed = await runner.runOnce();
      expect(processed).toBe(1);

      expect(recordedCalls.map((c) => c.operation)).toEqual([
        'claim',
        'run:transition',
        'runRead:compute',
        'onFailure',
        'run:transition',
        'archive',
      ]);

      const deliveryCalls = recordedCalls.filter(
        (c) => c.operation !== 'claim',
      );
      expect(deliveryCalls).toHaveLength(5);

      for (const call of deliveryCalls) {
        expect(call.timeout).toBeGreaterThan(0);
        expect(call.timeout).toBeLessThanOrEqual(call.remainingBefore);
      }

      const expiresAt = 1_000 + 300_000 - 20_000;
      expect(getClock()).toBeLessThan(expiresAt);
    });

    it('recording test — path 4: persist failure followed by failure write (transition -> compute -> persist -> failJob -> ack)', async () => {
      const { runner, recordedCalls, getClock } = createRecordingTestHarness({
        persistThrows: true,
        persistError: { code: '23505' }, // permanent
      });
      const processed = await runner.runOnce();
      expect(processed).toBe(1);

      expect(recordedCalls.map((c) => c.operation)).toEqual([
        'claim',
        'run:transition',
        'runRead:compute',
        'run:persist',
        'run:transition',
        'ack',
      ]);

      const deliveryCalls = recordedCalls.filter(
        (c) => c.operation !== 'claim',
      );
      expect(deliveryCalls).toHaveLength(5);

      for (const call of deliveryCalls) {
        expect(call.timeout).toBeGreaterThan(0);
        expect(call.timeout).toBeLessThanOrEqual(call.remainingBefore);
      }

      const expiresAt = 1_000 + 300_000 - 20_000;
      expect(getClock()).toBeLessThan(expiresAt);
    });

    it('recording test — P0001 completeJob with re-read completed acks once and never failJob', async () => {
      const { runner, recordedCalls, recordingQueue, recordingJobWriter } =
        createRecordingTestHarness({
          reReadStatus: 'completed',
        });
      recordingJobWriter.completeJob = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('complete_job refused'), { code: 'P0001' }),
        );

      const processed = await runner.runOnce();
      expect(processed).toBe(1);
      expect(recordingQueue.ack).toHaveBeenCalledTimes(1);
      expect(recordingJobWriter.failJob).not.toHaveBeenCalled();
      expect(recordingJobWriter.deadLetter).not.toHaveBeenCalled();

      const statusRead = recordedCalls.find(
        (call) => call.operation === 'runRead:status',
      );
      expect(statusRead).toBeDefined();
      expect(statusRead!.timeout).toBeGreaterThan(0);
      expect(statusRead!.timeout).toBeLessThanOrEqual(
        statusRead!.remainingBefore,
      );
    });

    it('recording test — P0001 persist with re-read processing failJobs then acks; re-check timeout is bounded', async () => {
      const { runner, recordedCalls, recordingQueue, recordingJobWriter } =
        createRecordingTestHarness({
          persistThrows: true,
          persistError: Object.assign(new Error('Report generation failed'), {
            code: 'P0001',
          }),
          reReadStatus: 'processing',
        });

      const processed = await runner.runOnce();
      expect(processed).toBe(1);
      expect(recordingJobWriter.failJob).toHaveBeenCalledTimes(1);
      expect(recordingQueue.ack).toHaveBeenCalledTimes(1);
      expect(recordingJobWriter.deadLetter).not.toHaveBeenCalled();

      const statusRead = recordedCalls.find(
        (call) => call.operation === 'runRead:status',
      );
      expect(statusRead).toBeDefined();
      expect(statusRead!.timeout).toBeGreaterThan(0);
      expect(statusRead!.timeout).toBeLessThanOrEqual(
        statusRead!.remainingBefore,
      );
    });

    it('recording test — P0001 re-check is skipped with no ack when the deadline is exhausted', async () => {
      const { runner, recordedCalls, recordingQueue, recordingJobWriter } =
        createRecordingTestHarness({
          persistThrows: true,
          persistError: Object.assign(new Error('Report generation failed'), {
            code: 'P0001',
          }),
          reReadStatus: 'completed',
          exhaustWorkBeforeRecheck: true,
        });

      const processed = await runner.runOnce();
      expect(processed).toBe(1);
      expect(
        recordedCalls.some((call) => call.operation === 'runRead:status'),
      ).toBe(false);
      expect(recordingQueue.ack).not.toHaveBeenCalled();
      expect(recordingJobWriter.failJob).not.toHaveBeenCalled();
      expect(recordingJobWriter.deadLetter).not.toHaveBeenCalled();
    });

    it('recording test — P0001 persist with failing re-check defers and never failJob', async () => {
      const { runner, recordingQueue, recordingJobWriter } =
        createRecordingTestHarness({
          persistThrows: true,
          persistError: Object.assign(new Error('Report generation failed'), {
            code: 'P0001',
          }),
          reReadThrows: Object.assign(new Error('serialization failure'), {
            code: '40001',
          }),
        });

      const processed = await runner.runOnce();
      expect(processed).toBe(1);
      expect(recordingJobWriter.failJob).not.toHaveBeenCalled();
      expect(recordingQueue.ack).not.toHaveBeenCalled();
      expect(recordingQueue.defer).toHaveBeenCalledTimes(1);
      expect(recordingJobWriter.deadLetter).not.toHaveBeenCalled();
    });

    it('recording test — P0001 persist with failing re-check at attempt limit dead-letters and never failJob', async () => {
      const { runner, recordingQueue, recordingJobWriter } =
        createRecordingTestHarness({
          persistThrows: true,
          persistError: Object.assign(new Error('Report generation failed'), {
            code: 'P0001',
          }),
          reReadThrows: Object.assign(new Error('serialization failure'), {
            code: '40001',
          }),
          readCt: 5,
        });

      const processed = await runner.runOnce();
      expect(processed).toBe(1);
      expect(recordingJobWriter.failJob).not.toHaveBeenCalled();
      expect(recordingQueue.ack).not.toHaveBeenCalled();
      expect(recordingQueue.defer).not.toHaveBeenCalled();
      expect(recordingJobWriter.deadLetter).toHaveBeenCalledTimes(1);
      expect(recordingQueue.archive).toHaveBeenCalledTimes(1);
    });

    it('recording test — P0001 completeJob with failing re-check defers and never failJob', async () => {
      const { runner, recordingQueue, recordingJobWriter } =
        createRecordingTestHarness({
          reReadThrows: Object.assign(new Error('serialization failure'), {
            code: '40001',
          }),
        });
      recordingJobWriter.completeJob = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('complete_job refused'), { code: 'P0001' }),
        );

      const processed = await runner.runOnce();
      expect(processed).toBe(1);
      expect(recordingJobWriter.failJob).not.toHaveBeenCalled();
      expect(recordingQueue.ack).not.toHaveBeenCalled();
      expect(recordingQueue.defer).toHaveBeenCalledTimes(1);
      expect(recordingJobWriter.deadLetter).not.toHaveBeenCalled();
    });

    it('recording queue assertion — ack shrinks to remaining lease time when near expiration', async () => {
      let currentClock = 1_000;
      const clock = () => currentClock;
      const config = new WorkerConfig(1, 300, 1000, 30);
      const recordedCalls: RecordedCall[] = [];

      const getRemaining = () => {
        const expiresAt =
          1_000 +
          config.visibilityTimeoutSeconds * 1_000 -
          config.leaseSafetyMs;
        return Math.max(0, expiresAt - currentClock);
      };

      const recordAndAdvance = (operation: string, timeout: number) => {
        const remainingBefore = getRemaining();
        recordedCalls.push({ operation, timeout, remainingBefore });
        currentClock += timeout;
      };

      const recordingQueue: JobQueue = {
        claim: vi.fn().mockImplementation(async (_vt, _limit, timeoutMs) => {
          recordedCalls.push({
            operation: 'claim',
            timeout: timeoutMs ?? 0,
            remainingBefore: Number.POSITIVE_INFINITY,
          });
          return [
            {
              msgId: '101',
              readCt: 1,
              enqueuedAt: new Date().toISOString(),
              vt: new Date().toISOString(),
              message: { job_id: jobId, workspace_id: wsId, actor_id: actorId },
            },
          ];
        }),
        ack: vi.fn().mockImplementation(async (_msgId, timeoutMs) => {
          recordAndAdvance('ack', timeoutMs ?? 0);
          return true;
        }),
        archive: vi.fn().mockResolvedValue(true),
        defer: vi.fn().mockResolvedValue(true),
        failOrphanedJob: vi.fn().mockResolvedValue(true),
      };

      const recordingTransaction: Partial<PgTransaction> = {
        run: vi
          .fn()
          .mockImplementation(
            async (_subject, callback, context, phase, timeoutMs) => {
              const effectivePhase = phase ?? context?.phase ?? 'transition';
              recordAndAdvance(`run:${effectivePhase}`, timeoutMs ?? 0);
              const client: TransactionClient = {
                query: vi.fn().mockImplementation(async (sql: string) => {
                  if (sql.includes('from public.jobs')) {
                    return {
                      rows: [
                        {
                          id: jobId,
                          workspace_id: wsId,
                          created_by: actorId,
                          type: 'probe',
                          status: 'queued',
                          payload: { value: 42 },
                          role: 'owner',
                        },
                      ],
                    };
                  }
                  return { rows: [] };
                }),
              };
              return callback(client);
            },
          ),
        runRead: vi
          .fn()
          .mockImplementation(async (_subject, callback, optionsOrTimeout) => {
            const timeoutMs =
              typeof optionsOrTimeout === 'number'
                ? optionsOrTimeout
                : optionsOrTimeout?.timeoutMs;
            recordAndAdvance('runRead:compute', timeoutMs ?? 0);
            const client: TransactionClient = {
              query: vi.fn().mockResolvedValue({ rows: [] }),
            };
            return callback(client);
          }),
      };

      const recordingJobWriter: Partial<JobWriter> = {
        transitionToProcessing: vi.fn().mockResolvedValue({ id: jobId }),
        completeJob: vi.fn().mockResolvedValue({ id: jobId }),
      };

      const probeHandler: JobHandler<{ value: number }, { result: number }> = {
        jobType: 'probe',
        parsePayload: (raw: unknown) => raw as { value: number },
        compute: vi.fn().mockResolvedValue({ result: 84 }),
        persist: vi.fn(async () => {
          // Inside persist, advance clock so that remaining before ack is exactly 5_000ms.
          // expiresAt = 1000 + 300_000 - 20_000 = 281_000.
          // 281_000 - 5_000 = 276_000.
          currentClock = 276_000;
          return resultResourceId;
        }),
      };

      const runner = new JobRunner(
        recordingQueue,
        recordingTransaction as PgTransaction,
        recordingJobWriter as JobWriter,
        config,
        [probeHandler],
        clock,
      );

      const processed = await runner.runOnce();
      expect(processed).toBe(1);

      const ackCall = recordedCalls.find((c) => c.operation === 'ack');
      expect(ackCall).toBeDefined();
      expect(ackCall!.remainingBefore).toBe(5_000);
      expect(ackCall!.timeout).toBe(5_000);
      expect(ackCall!.timeout).toBeLessThanOrEqual(ackCall!.remainingBefore);
    });

    it('exhaustion — compute advances clock to within terminalReserveMs of expiresAt: no persist, no ack/archive/defer, no failure write, and log event emitted', async () => {
      let currentClock = 1_000;
      const clock = () => currentClock;
      const config = new WorkerConfig(1, 300, 1000, 30);
      // expiresAt = 1000 + 300_000 - 20_000 = 281_000.
      // terminalReserveMs = 10_000.

      const mockQueue: JobQueue = {
        claim: vi.fn().mockResolvedValue([
          {
            msgId: '101',
            readCt: 1,
            enqueuedAt: new Date().toISOString(),
            vt: new Date().toISOString(),
            message: { job_id: jobId, workspace_id: wsId, actor_id: actorId },
          },
        ]),
        ack: vi.fn().mockResolvedValue(true),
        archive: vi.fn().mockResolvedValue(true),
        defer: vi.fn().mockResolvedValue(true),
        failOrphanedJob: vi.fn().mockResolvedValue(true),
      };

      const mockJobWriter: Partial<JobWriter> = {
        transitionToProcessing: vi.fn().mockResolvedValue({ id: jobId }),
        completeJob: vi.fn().mockResolvedValue({ id: jobId }),
        failJob: vi.fn().mockResolvedValue({ id: jobId }),
        deadLetter: vi.fn().mockResolvedValue({ id: jobId }),
      };

      const mockTransaction: Partial<PgTransaction> = {
        run: vi.fn().mockImplementation(async (_subject, callback) => {
          const client: TransactionClient = {
            query: vi.fn().mockImplementation(async (sql: string) => {
              if (sql.includes('from public.jobs')) {
                return {
                  rows: [
                    {
                      id: jobId,
                      workspace_id: wsId,
                      created_by: actorId,
                      type: 'probe',
                      status: 'queued',
                      payload: { value: 42 },
                      role: 'owner',
                    },
                  ],
                };
              }
              return { rows: [] };
            }),
          };
          return callback(client);
        }),
        runRead: vi.fn().mockImplementation(async (_subject, callback) => {
          const client: TransactionClient = {
            query: vi.fn().mockResolvedValue({ rows: [] }),
          };
          return callback(client);
        }),
      };

      const probeHandler: JobHandler<{ value: number }, { result: number }> = {
        jobType: 'probe',
        parsePayload: (raw: unknown) => raw as { value: number },
        compute: vi.fn(async () => {
          // Advance clock so remaining is 5_000ms, which is < terminalReserveMs (10_000ms)
          // 281_000 - 5_000 = 276_000
          currentClock = 276_000;
          return { result: 84 };
        }),
        persist: vi.fn(async () => resultResourceId),
      };

      const runner = new JobRunner(
        mockQueue,
        mockTransaction as PgTransaction,
        mockJobWriter as JobWriter,
        config,
        [probeHandler],
        clock,
      );

      const warnSpy = vi.spyOn(
        (runner as unknown as { logger: Logger }).logger,
        'warn',
      );

      const processed = await runner.runOnce();
      expect(processed).toBe(1);

      // Persist was NOT called
      expect(probeHandler.persist).not.toHaveBeenCalled();
      expect(mockJobWriter.completeJob).not.toHaveBeenCalled();
      // No queue action
      expect(mockQueue.ack).not.toHaveBeenCalled();
      expect(mockQueue.archive).not.toHaveBeenCalled();
      expect(mockQueue.defer).not.toHaveBeenCalled();
      // No failure write
      expect(mockJobWriter.failJob).not.toHaveBeenCalled();
      expect(mockJobWriter.deadLetter).not.toHaveBeenCalled();

      // Log event emitted
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('delivery_deadline_exhausted'),
      );
    });

    it('exhaustion — DeliveryDeadlineExceededError thrown mid-persist: caught, no failure write, no queue action, and log event emitted', async () => {
      const currentClock = 1_000;
      const clock = () => currentClock;
      const config = new WorkerConfig(1, 300, 1000, 30);

      const mockQueue: JobQueue = {
        claim: vi.fn().mockResolvedValue([
          {
            msgId: '101',
            readCt: 1,
            enqueuedAt: new Date().toISOString(),
            vt: new Date().toISOString(),
            message: { job_id: jobId, workspace_id: wsId, actor_id: actorId },
          },
        ]),
        ack: vi.fn().mockResolvedValue(true),
        archive: vi.fn().mockResolvedValue(true),
        defer: vi.fn().mockResolvedValue(true),
        failOrphanedJob: vi.fn().mockResolvedValue(true),
      };

      const mockJobWriter: Partial<JobWriter> = {
        transitionToProcessing: vi.fn().mockResolvedValue({ id: jobId }),
        completeJob: vi.fn().mockResolvedValue({ id: jobId }),
        failJob: vi.fn().mockResolvedValue({ id: jobId }),
        deadLetter: vi.fn().mockResolvedValue({ id: jobId }),
      };

      let persistRan = false;
      const mockTransaction: Partial<PgTransaction> = {
        run: vi.fn().mockImplementation(async (_subject, callback, context) => {
          if (context?.phase === 'persist') {
            persistRan = true;
            throw new DeliveryDeadlineExceededError();
          }
          const client: TransactionClient = {
            query: vi.fn().mockImplementation(async (sql: string) => {
              if (sql.includes('from public.jobs')) {
                return {
                  rows: [
                    {
                      id: jobId,
                      workspace_id: wsId,
                      created_by: actorId,
                      type: 'probe',
                      status: 'queued',
                      payload: { value: 42 },
                      role: 'owner',
                    },
                  ],
                };
              }
              return { rows: [] };
            }),
          };
          return callback(client);
        }),
        runRead: vi.fn().mockImplementation(async (_subject, callback) => {
          const client: TransactionClient = {
            query: vi.fn().mockResolvedValue({ rows: [] }),
          };
          return callback(client);
        }),
      };

      const probeHandler: JobHandler<{ value: number }, { result: number }> = {
        jobType: 'probe',
        parsePayload: (raw: unknown) => raw as { value: number },
        compute: vi.fn().mockResolvedValue({ result: 84 }),
        persist: vi.fn().mockResolvedValue(resultResourceId),
      };

      const runner = new JobRunner(
        mockQueue,
        mockTransaction as PgTransaction,
        mockJobWriter as JobWriter,
        config,
        [probeHandler],
        clock,
      );

      const warnSpy = vi.spyOn(
        (runner as unknown as { logger: Logger }).logger,
        'warn',
      );

      const processed = await runner.runOnce();
      expect(processed).toBe(1);
      expect(persistRan).toBe(true);

      // No failure write and no queue action
      expect(mockJobWriter.failJob).not.toHaveBeenCalled();
      expect(mockJobWriter.deadLetter).not.toHaveBeenCalled();
      expect(mockQueue.ack).not.toHaveBeenCalled();
      expect(mockQueue.archive).not.toHaveBeenCalled();
      expect(mockQueue.defer).not.toHaveBeenCalled();

      // Log event emitted
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('delivery_deadline_exhausted'),
      );
    });

    it('onFailure bound — a hook that never resolves is abandoned at its timeout', async () => {
      vi.useFakeTimers();
      try {
        const config = new WorkerConfig(1, 300, 1000, 30);
        let failureHookStarted = false;

        const neverResolvingHandler: JobHandler<
          { value: number },
          { result: number }
        > = {
          jobType: 'probe',
          parsePayload: (raw: unknown) => raw as { value: number },
          compute: vi.fn(async () => {
            throw Object.assign(new Error('Permanent compute error'), {
              code: '23505',
            });
          }),
          persist: vi.fn().mockResolvedValue(resultResourceId),
          onFailure: vi.fn(async () => {
            failureHookStarted = true;
            return new Promise<void>(() => {}); // Never resolves
          }),
        };

        const { runner, mockQueue, mockJobWriter } = createTestHarness({
          config,
        });
        runner.registerHandler(neverResolvingHandler);

        const runPromise = runner.runOnce();

        // Let microtasks run so compute throws and reaches onFailure
        await vi.advanceTimersByTimeAsync(0);
        expect(failureHookStarted).toBe(true);

        // Advance timers past the onFailure timeout (transitionTimeoutMs = 15,000ms)
        await vi.advanceTimersByTimeAsync(16_000);

        await runPromise;

        // Proves onFailure was abandoned: failJob and ack were executed!
        expect(mockJobWriter.failJob).toHaveBeenCalled();
        expect(mockQueue.ack).toHaveBeenCalledWith('101', expect.any(Number));
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
