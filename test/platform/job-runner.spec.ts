import { describe, expect, it, vi } from 'vitest';
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
      config?: WorkerConfig;
      batchSize?: number;
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
            throw new Error('Compute explosion');
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
          return resultResourceId;
        },
      ),
      onFailure: vi.fn(async () => {
        callLog.push('onFailure');
      }),
    };

    const config =
      options.config ?? new WorkerConfig(options.batchSize ?? 1, 300, 1000, 30);
    const runner = new JobRunner(
      mockQueue,
      mockTransaction as PgTransaction,
      mockJobWriter as JobWriter,
      config,
      [probeHandler],
    );

    return {
      runner,
      mockQueue,
      mockTransaction,
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

    expect(mockQueue.claim).toHaveBeenCalledWith(300, 1);
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
    expect(mockQueue.ack).toHaveBeenCalledWith('101');

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
    expect(mockQueue.ack).toHaveBeenCalledWith('101');

    expect(callLog).toEqual(['claim', `run:${actorId}`, 'ack:101']);
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

    expect(mockQueue.failOrphanedJob).toHaveBeenCalledWith(jobId, actorId);
    expect(mockQueue.ack).toHaveBeenCalledWith('101');
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

    expect(mockQueue.failOrphanedJob).toHaveBeenCalledWith(jobId, actorId);
    expect(mockQueue.ack).toHaveBeenCalledWith('101');
    expect(probeHandler.compute).not.toHaveBeenCalled();
  });

  it('leaves the message unacked when compute throws an error, and does not crash the loop', async () => {
    const { runner, mockQueue, probeHandler, callLog } = createTestHarness({
      computeThrows: true,
    });

    await expect(runner.runOnce()).resolves.toBe(1);

    expect(probeHandler.compute).toHaveBeenCalled();
    expect(probeHandler.persist).not.toHaveBeenCalled();
    // Message MUST NOT be acked
    expect(mockQueue.ack).not.toHaveBeenCalled();

    expect(callLog).toContain('compute');
    expect(callLog).toContain('onFailure');
    expect(callLog).not.toContain('ack:101');
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

    expect(mockQueue.archive).toHaveBeenCalledWith('201');
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

    expect(mockQueue.archive).toHaveBeenCalledWith('202');
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
      expect(mockQueue.ack).toHaveBeenCalledWith('101');
      expect(mockQueue.ack).toHaveBeenCalledWith('102');
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

    expect(mockQueue.ack).toHaveBeenCalledWith('102');
    expect(mockQueue.ack).not.toHaveBeenCalledWith('101');
  });
});
