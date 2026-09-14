import { randomUUID } from 'node:crypto';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import type { JobExecutionContext, JobHandler } from './job-handler.port.js';
import {
  JOB_QUEUE,
  type JobQueue,
  type QueueMessage,
} from './job-queue.port.js';
import {
  calculateBackoffDelay,
  classifyJobError,
  JOB_ERROR_CLASSIFICATIONS,
} from './job-retry-policy.js';
import { JOB_WRITER, type JobWriter } from './job-writer.port.js';
import { ActorVerificationError, PgTransaction } from './pg-transaction.js';
import { UUID_PATTERN } from './uuid.js';
import { WorkerConfig } from './worker-config.js';

interface JobCheckRow extends Record<string, unknown> {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly payload: unknown;
  readonly workspace_id: string;
  readonly created_by: string;
  readonly role: string | null;
}

function toProblemDetails(
  error: unknown,
  fallback: {
    type: string;
    title: string;
    status: number;
    code: string;
    detail: string;
  },
): Record<string, unknown> {
  if (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    'title' in error &&
    'status' in error &&
    'code' in error &&
    typeof (error as Record<string, unknown>).type === 'string' &&
    typeof (error as Record<string, unknown>).title === 'string' &&
    typeof (error as Record<string, unknown>).status === 'number' &&
    typeof (error as Record<string, unknown>).code === 'string'
  ) {
    const errObj = error as Record<string, unknown>;
    return {
      type: errObj.type,
      title: errObj.title,
      status: errObj.status,
      code: errObj.code,
      detail:
        typeof errObj.detail === 'string' ? errObj.detail : fallback.detail,
      traceId:
        typeof errObj.traceId === 'string' && UUID_PATTERN.test(errObj.traceId)
          ? errObj.traceId
          : randomUUID(),
    };
  }

  return {
    ...fallback,
    traceId: randomUUID(),
  };
}

@Injectable()
export class JobRunner implements BeforeApplicationShutdown {
  private readonly logger = new Logger(JobRunner.name);
  private readonly handlerMap = new Map<string, JobHandler>();

  private isRunning = false;
  private isStopping = false;
  private pollTimer?: NodeJS.Timeout;
  private activeJobsCount = 0;

  public constructor(
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    private readonly transaction: PgTransaction,
    @Inject(JOB_WRITER) private readonly jobWriter: JobWriter,
    private readonly config: WorkerConfig,
    @Optional() handlers: readonly JobHandler[] = [],
  ) {
    for (const handler of handlers) {
      this.registerHandler(handler);
    }
  }

  public registerHandler(handler: JobHandler): void {
    this.handlerMap.set(handler.jobType, handler);
  }

  public async runOnce(): Promise<number> {
    this.activeJobsCount++;
    let messages: readonly QueueMessage[];
    try {
      messages = await this.queue.claim(
        this.config.visibilityTimeoutSeconds,
        this.config.batchSize,
      );

      if (this.isStopping) {
        this.logger.warn(
          `Runner is stopping; ${messages.length} claimed messages left unacknowledged for redelivery.`,
        );
        return 0;
      }
    } finally {
      this.activeJobsCount--;
    }

    const results = await Promise.allSettled(
      messages.map(async (message) => {
        this.activeJobsCount++;
        try {
          return await this.processMessage(message);
        } finally {
          this.activeJobsCount--;
        }
      }),
    );

    return results.filter((r) => r.status === 'fulfilled').length;
  }

  public async drainOnce(): Promise<number> {
    return this.runOnce();
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isStopping = false;

    const poll = async () => {
      if (!this.isRunning) return;
      try {
        await this.runOnce();
      } catch (error) {
        // Runner loop must not crash on transient unexpected errors
        void error;
      } finally {
        if (this.isRunning) {
          this.pollTimer = setTimeout(
            () => void poll(),
            this.config.pollIntervalMs,
          );
        }
      }
    };

    void poll();
  }

  public async stop(): Promise<void> {
    this.isStopping = true;
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }

    const drainDeadline = Date.now() + this.config.drainTimeoutSeconds * 1_000;
    while (this.activeJobsCount > 0 && Date.now() < drainDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  public async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  public async processMessage(message: QueueMessage): Promise<boolean> {
    const envelope = message.message;
    if (!envelope || typeof envelope !== 'object') {
      this.logger.error(
        `Claimed message ${message.msgId} is malformed: missing envelope or not an object`,
      );
      await this.queue.archive(message.msgId);
      return false;
    }

    const {
      job_id: jobId,
      workspace_id: workspaceId,
      actor_id: actorId,
    } = envelope;

    if (
      !actorId ||
      typeof actorId !== 'string' ||
      !UUID_PATTERN.test(actorId)
    ) {
      this.logger.error(
        `Claimed message ${message.msgId} is malformed: actor_id is missing or not a valid UUID`,
      );
      await this.queue.archive(message.msgId);
      return false;
    }

    if (
      !jobId ||
      typeof jobId !== 'string' ||
      !UUID_PATTERN.test(jobId) ||
      !workspaceId ||
      typeof workspaceId !== 'string' ||
      !UUID_PATTERN.test(workspaceId)
    ) {
      if (typeof jobId === 'string' && UUID_PATTERN.test(jobId)) {
        await this.queue.failOrphanedJob(jobId, actorId);
      }
      await this.queue.ack(message.msgId);
      return false;
    }

    let jobType: string | undefined;
    let jobPayload: unknown;
    let isTerminal = false;
    let isExhaustedAtClaim = false;

    // T1: Transition to processing under actor context
    try {
      await this.transaction.run(
        actorId,
        async (client) => {
          const checkRes = await client.query<JobCheckRow>(
            `select j.id::text,
                    j.type,
                    j.status,
                    j.payload,
                    j.workspace_id::text as workspace_id,
                    j.created_by::text as created_by,
                    public.workspace_actor_active_role(j.workspace_id) as role
               from public.jobs j
              where j.id = $1::uuid`,
            [jobId],
          );
          const row = checkRes.rows[0];
          if (
            !row ||
            row.workspace_id !== workspaceId ||
            row.created_by !== actorId.toLowerCase() ||
            !['owner', 'administrator', 'editor'].includes(row.role ?? '')
          ) {
            throw new ActorVerificationError(
              `Actor ${actorId} lacks active write role in workspace ${workspaceId} or job not owned by actor.`,
            );
          }

          if (
            ['completed', 'failed', 'cancelled', 'dead_letter'].includes(
              row.status,
            )
          ) {
            isTerminal = true;
            return;
          }

          // Check if message read_ct exceeded maxAttempts at claim time
          if (message.readCt > this.config.maxAttempts) {
            await this.jobWriter.deadLetter(client, workspaceId, jobId, {
              type: 'https://savia.app/problems/job-exhausted',
              title: 'Job Retries Exhausted',
              status: 500,
              code: 'job_retries_exhausted',
              detail: `Job exceeded maximum attempts (${this.config.maxAttempts}).`,
              traceId: randomUUID(),
            });
            isExhaustedAtClaim = true;
            return;
          }

          await this.jobWriter.transitionToProcessing(
            client,
            workspaceId,
            jobId,
            message.readCt,
          );
          jobType = row.type;
          jobPayload = row.payload;
        },
        { workspaceId, jobId },
      );
    } catch (error) {
      if (error instanceof ActorVerificationError) {
        await this.queue.failOrphanedJob(jobId, actorId);
        await this.queue.ack(message.msgId);
        return false;
      }
      return false;
    }

    if (isTerminal) {
      await this.queue.ack(message.msgId);
      return true;
    }

    if (isExhaustedAtClaim) {
      await this.queue.archive(message.msgId);
      return false;
    }

    const handler = jobType ? this.handlerMap.get(jobType) : undefined;
    if (!handler) {
      return false;
    }

    let parsedPayload: unknown;
    try {
      parsedPayload = handler.parsePayload(jobPayload);
    } catch (parseError) {
      await this.transaction.run(
        actorId,
        async (client) => {
          await this.jobWriter.failJob(client, workspaceId, jobId, {
            type: 'https://savia.app/problems/invalid-payload',
            title: 'Invalid Payload',
            status: 400,
            code: 'invalid_payload',
            detail:
              parseError instanceof Error
                ? parseError.message
                : 'Invalid payload',
            traceId: randomUUID(),
          });
        },
        { workspaceId, jobId },
      );
      await this.queue.ack(message.msgId);
      return false;
    }

    const context: JobExecutionContext<unknown> = {
      jobId,
      workspaceId,
      actorId,
      attemptCount: message.readCt,
      payload: parsedPayload,
    };

    // Compute phase (read-only tx)
    let computedResult: unknown;
    try {
      computedResult = await this.transaction.runRead(
        actorId,
        async (readClient) => handler.compute(context, readClient),
      );
    } catch (computeError) {
      if (handler.onFailure) {
        await handler.onFailure(context, computeError).catch(() => undefined);
      }

      const classification = classifyJobError(computeError);
      if (classification === JOB_ERROR_CLASSIFICATIONS.TRANSIENT) {
        if (message.readCt >= this.config.maxAttempts) {
          await this.transaction.run(
            actorId,
            async (writeClient) => {
              await this.jobWriter.deadLetter(
                writeClient,
                workspaceId,
                jobId,
                toProblemDetails(computeError, {
                  type: 'https://savia.app/problems/job-exhausted',
                  title: 'Job Retries Exhausted',
                  status: 500,
                  code: 'job_retries_exhausted',
                  detail:
                    computeError instanceof Error
                      ? computeError.message
                      : 'Job exceeded maximum retry attempts.',
                }),
              );
            },
            { workspaceId, jobId },
          );
          await this.queue.archive(message.msgId);
          return false;
        }

        const delay = calculateBackoffDelay(message.readCt);
        await this.queue.defer(message.msgId, Math.round(delay));
        return false;
      }

      // Permanent error moves job to failed and acks message
      await this.transaction.run(
        actorId,
        async (writeClient) => {
          await this.jobWriter.failJob(
            writeClient,
            workspaceId,
            jobId,
            toProblemDetails(computeError, {
              type: 'https://savia.app/problems/job-failed',
              title: 'Job Failed',
              status: 500,
              code: 'job_failed',
              detail:
                computeError instanceof Error
                  ? computeError.message
                  : 'Permanent job execution failure.',
            }),
          );
        },
        { workspaceId, jobId },
      );
      await this.queue.ack(message.msgId);
      return false;
    }

    // T2: Persist phase + mark completed
    try {
      await this.transaction.run(
        actorId,
        async (writeClient) => {
          const resultResourceId = await handler.persist(
            context,
            computedResult,
            writeClient,
          );
          await this.jobWriter.completeJob(
            writeClient,
            workspaceId,
            jobId,
            typeof resultResourceId === 'string' ? resultResourceId : null,
          );
        },
        { workspaceId, jobId },
      );
    } catch (persistError) {
      if (persistError instanceof ActorVerificationError) {
        await this.queue.failOrphanedJob(jobId, actorId);
        await this.queue.ack(message.msgId);
        return false;
      }

      const classification = classifyJobError(persistError);
      if (classification === JOB_ERROR_CLASSIFICATIONS.TRANSIENT) {
        if (message.readCt >= this.config.maxAttempts) {
          await this.transaction.run(
            actorId,
            async (writeClient) => {
              await this.jobWriter.deadLetter(
                writeClient,
                workspaceId,
                jobId,
                toProblemDetails(persistError, {
                  type: 'https://savia.app/problems/job-exhausted',
                  title: 'Job Retries Exhausted',
                  status: 500,
                  code: 'job_retries_exhausted',
                  detail:
                    persistError instanceof Error
                      ? persistError.message
                      : 'Job exceeded maximum retry attempts.',
                }),
              );
            },
            { workspaceId, jobId },
          );
          await this.queue.archive(message.msgId);
          return false;
        }

        const delay = calculateBackoffDelay(message.readCt);
        await this.queue.defer(message.msgId, Math.round(delay));
        return false;
      }

      await this.transaction.run(
        actorId,
        async (writeClient) => {
          await this.jobWriter.failJob(
            writeClient,
            workspaceId,
            jobId,
            toProblemDetails(persistError, {
              type: 'https://savia.app/problems/job-failed',
              title: 'Job Failed',
              status: 500,
              code: 'job_failed',
              detail:
                persistError instanceof Error
                  ? persistError.message
                  : 'Permanent job persist failure.',
            }),
          );
        },
        { workspaceId, jobId },
      );
      await this.queue.ack(message.msgId);
      return false;
    }

    // Ack after successful persist + completed commit
    await this.queue.ack(message.msgId);
    return true;
  }
}
