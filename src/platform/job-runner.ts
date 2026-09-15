import { randomUUID } from 'node:crypto';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  DeliveryDeadline,
  DeliveryDeadlineExceededError,
} from './delivery-deadline.js';
import type { JobExecutionContext, JobHandler } from './job-handler.port.js';
import {
  JOB_QUEUE,
  type JobQueue,
  type QueueMessage,
} from './job-queue.port.js';
import {
  calculateBackoffDelay,
  classifyJobError,
  errorHasSqlstate,
  JOB_ERROR_CLASSIFICATIONS,
} from './job-retry-policy.js';
import { JOB_WRITER, type JobWriter } from './job-writer.port.js';
import { ActorVerificationError, PgTransaction } from './pg-transaction.js';
import { UUID_PATTERN } from './uuid.js';
import { WorkerConfig } from './worker-config.js';

const TERMINAL_JOB_STATUSES = {
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  DEAD_LETTER: 'dead_letter',
} as const;

type TerminalJobStatus =
  (typeof TERMINAL_JOB_STATUSES)[keyof typeof TERMINAL_JOB_STATUSES];

const WRITE_REFUSAL_OUTCOMES = {
  ACKED: 'acked',
  CONTINUE: 'continue',
  EXHAUSTED: 'exhausted',
  RECHECK_FAILED: 'recheck_failed',
} as const;

type WriteRefusalOutcome =
  (typeof WRITE_REFUSAL_OUTCOMES)[keyof typeof WRITE_REFUSAL_OUTCOMES];

interface WriteRefusalResult {
  readonly outcome: WriteRefusalOutcome;
  readonly error: unknown;
}

function isTerminalJobStatus(status: string): status is TerminalJobStatus {
  return (Object.values(TERMINAL_JOB_STATUSES) as string[]).includes(status);
}

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
  private readonly clock: () => number;

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
    @Optional() clock?: () => number,
  ) {
    this.clock = clock ?? (() => performance.now());
    for (const handler of handlers) {
      this.registerHandler(handler);
    }
  }

  public registerHandler(handler: JobHandler): void {
    this.handlerMap.set(handler.jobType, handler);
  }

  public createDeadline(claimedAt?: number): DeliveryDeadline {
    return new DeliveryDeadline({
      visibilityTimeoutSeconds: this.config.visibilityTimeoutSeconds,
      leaseSafetyMs: this.config.leaseSafetyMs,
      terminalReserveMs: this.config.terminalReserveMs,
      minOperationMs: this.config.minOperationMs,
      claimedAt,
      clock: this.clock,
    });
  }

  public async runOnce(): Promise<number> {
    this.activeJobsCount++;
    let messages: readonly QueueMessage[];
    let claimedAt: number;
    try {
      messages = await this.queue.claim(
        this.config.visibilityTimeoutSeconds,
        this.config.batchSize,
        this.config.queueTimeoutMs,
      );
      claimedAt = this.clock();

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
          const deadline = this.createDeadline(claimedAt);
          return await this.processMessage(message, deadline);
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

  public async processMessage(
    message: QueueMessage,
    deliveryDeadline?: DeliveryDeadline,
  ): Promise<boolean> {
    const deadline = deliveryDeadline ?? this.createDeadline();
    const envelope = message.message;
    if (!envelope || typeof envelope !== 'object') {
      this.logger.error(
        `Claimed message ${message.msgId} is malformed: missing envelope or not an object`,
      );
      await this.safeArchive(message.msgId, deadline);
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
      await this.safeArchive(message.msgId, deadline);
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
        if (deadline.isTerminalExhausted()) {
          this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
          return false;
        }
        const orphaned = await this.safeFailOrphanedJob(
          jobId,
          actorId,
          deadline,
        );
        if (!orphaned && deadline.isTerminalExhausted()) {
          return false;
        }
      }
      await this.safeAck(message.msgId, deadline, jobId);
      return false;
    }

    let jobType: string | undefined;
    let jobPayload: unknown;
    let isTerminal = false;
    let isExhaustedAtClaim = false;

    // T1: Transition to processing under actor context
    if (deadline.isWorkExhausted()) {
      this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
      return false;
    }

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
        { workspaceId, jobId, phase: 'transition' },
        'transition',
        deadline.forWork(this.config.transitionTimeoutMs),
      );
    } catch (error) {
      if (error instanceof DeliveryDeadlineExceededError) {
        this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
        return false;
      }
      const t1Terminality = await this.resolveP0001WriteRefusal(
        error,
        actorId,
        workspaceId,
        jobId,
        message.msgId,
        deadline,
      );
      if (t1Terminality.outcome === WRITE_REFUSAL_OUTCOMES.EXHAUSTED) {
        return false;
      }
      if (t1Terminality.outcome === WRITE_REFUSAL_OUTCOMES.ACKED) {
        return true;
      }
      if (t1Terminality.error instanceof ActorVerificationError) {
        if (deadline.isTerminalExhausted()) {
          this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
          return false;
        }
        const orphaned = await this.safeFailOrphanedJob(
          jobId,
          actorId,
          deadline,
        );
        if (orphaned) {
          await this.safeAck(message.msgId, deadline, jobId);
        }
        return false;
      }
      return false;
    }

    if (isTerminal) {
      await this.safeAck(message.msgId, deadline, jobId);
      return true;
    }

    if (isExhaustedAtClaim) {
      await this.safeArchive(message.msgId, deadline, jobId);
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
      if (deadline.isWorkExhausted()) {
        this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
        return false;
      }
      try {
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
          { workspaceId, jobId, phase: 'transition' },
          'transition',
          deadline.forWork(this.config.transitionTimeoutMs),
        );
      } catch (error) {
        if (error instanceof DeliveryDeadlineExceededError) {
          this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
          return false;
        }
        const invalidPayloadTerminality = await this.resolveP0001WriteRefusal(
          error,
          actorId,
          workspaceId,
          jobId,
          message.msgId,
          deadline,
        );
        if (
          invalidPayloadTerminality.outcome === WRITE_REFUSAL_OUTCOMES.EXHAUSTED
        ) {
          return false;
        }
        if (
          invalidPayloadTerminality.outcome === WRITE_REFUSAL_OUTCOMES.ACKED
        ) {
          return true;
        }
        return false;
      }
      await this.safeAck(message.msgId, deadline, jobId);
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
    if (deadline.isWorkExhausted()) {
      this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
      return false;
    }

    let computedResult: unknown;
    try {
      computedResult = await this.transaction.runRead(
        actorId,
        async (readClient) => handler.compute(context, readClient),
        deadline.forWork(this.config.computeTimeoutMs),
      );
    } catch (computeError) {
      if (computeError instanceof DeliveryDeadlineExceededError) {
        this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
        return false;
      }

      if (handler.onFailure && !deadline.isWorkExhausted()) {
        const failureTimeoutMs = deadline.forWork(
          this.config.transitionTimeoutMs,
        );
        if (failureTimeoutMs >= this.config.minOperationMs) {
          let timer: NodeJS.Timeout | undefined;
          const timeoutPromise = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, failureTimeoutMs);
          });
          try {
            await Promise.race([
              handler.onFailure(
                context,
                computeError,
                undefined,
                failureTimeoutMs,
              ),
              timeoutPromise,
            ]);
          } catch {
            // onFailure errors are swallowed
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      }

      const classification = classifyJobError(computeError);
      if (classification === JOB_ERROR_CLASSIFICATIONS.TRANSIENT) {
        if (message.readCt >= this.config.maxAttempts) {
          if (deadline.isWorkExhausted()) {
            this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
            return false;
          }
          try {
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
              { workspaceId, jobId, phase: 'transition' },
              'transition',
              deadline.forWork(this.config.transitionTimeoutMs),
            );
          } catch (writeError) {
            if (writeError instanceof DeliveryDeadlineExceededError) {
              this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
              return false;
            }
            const computeDeadLetterTerminality =
              await this.resolveP0001WriteRefusal(
                writeError,
                actorId,
                workspaceId,
                jobId,
                message.msgId,
                deadline,
              );
            if (
              computeDeadLetterTerminality.outcome ===
              WRITE_REFUSAL_OUTCOMES.EXHAUSTED
            ) {
              return false;
            }
            if (
              computeDeadLetterTerminality.outcome ===
              WRITE_REFUSAL_OUTCOMES.ACKED
            ) {
              return true;
            }
            return false;
          }
          await this.safeArchive(message.msgId, deadline, jobId);
          return false;
        }

        const delay = calculateBackoffDelay(message.readCt);
        await this.safeDefer(message.msgId, Math.round(delay), deadline, jobId);
        return false;
      }

      // Permanent error moves job to failed and acks message
      if (deadline.isWorkExhausted()) {
        this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
        return false;
      }
      try {
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
          { workspaceId, jobId, phase: 'transition' },
          'transition',
          deadline.forWork(this.config.transitionTimeoutMs),
        );
      } catch (writeError) {
        if (writeError instanceof DeliveryDeadlineExceededError) {
          this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
          return false;
        }
        const computeFailTerminality = await this.resolveP0001WriteRefusal(
          writeError,
          actorId,
          workspaceId,
          jobId,
          message.msgId,
          deadline,
        );
        if (
          computeFailTerminality.outcome === WRITE_REFUSAL_OUTCOMES.EXHAUSTED
        ) {
          return false;
        }
        if (computeFailTerminality.outcome === WRITE_REFUSAL_OUTCOMES.ACKED) {
          return true;
        }
        return false;
      }
      await this.safeAck(message.msgId, deadline, jobId);
      return false;
    }

    // T2: Persist phase + mark completed
    if (deadline.isWorkExhausted()) {
      this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
      return false;
    }

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
        { workspaceId, jobId, phase: 'persist' },
        'persist',
        deadline.forWork(this.config.persistTimeoutMs),
      );
    } catch (persistError) {
      if (persistError instanceof DeliveryDeadlineExceededError) {
        this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
        return false;
      }

      const persistTerminality = await this.resolveP0001WriteRefusal(
        persistError,
        actorId,
        workspaceId,
        jobId,
        message.msgId,
        deadline,
      );
      if (persistTerminality.outcome === WRITE_REFUSAL_OUTCOMES.EXHAUSTED) {
        return false;
      }
      if (persistTerminality.outcome === WRITE_REFUSAL_OUTCOMES.ACKED) {
        return true;
      }

      const persistHandledError = persistTerminality.error;

      if (persistHandledError instanceof ActorVerificationError) {
        if (deadline.isTerminalExhausted()) {
          this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
          return false;
        }
        const orphaned = await this.safeFailOrphanedJob(
          jobId,
          actorId,
          deadline,
        );
        if (orphaned) {
          await this.safeAck(message.msgId, deadline, jobId);
        }
        return false;
      }

      const classification = classifyJobError(persistHandledError);
      if (classification === JOB_ERROR_CLASSIFICATIONS.TRANSIENT) {
        if (message.readCt >= this.config.maxAttempts) {
          if (deadline.isWorkExhausted()) {
            this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
            return false;
          }
          try {
            await this.transaction.run(
              actorId,
              async (writeClient) => {
                await this.jobWriter.deadLetter(
                  writeClient,
                  workspaceId,
                  jobId,
                  toProblemDetails(persistHandledError, {
                    type: 'https://savia.app/problems/job-exhausted',
                    title: 'Job Retries Exhausted',
                    status: 500,
                    code: 'job_retries_exhausted',
                    detail:
                      persistHandledError instanceof Error
                        ? persistHandledError.message
                        : 'Job exceeded maximum retry attempts.',
                  }),
                );
              },
              { workspaceId, jobId, phase: 'transition' },
              'transition',
              deadline.forWork(this.config.transitionTimeoutMs),
            );
          } catch (writeError) {
            if (writeError instanceof DeliveryDeadlineExceededError) {
              this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
              return false;
            }
            const persistDeadLetterTerminality =
              await this.resolveP0001WriteRefusal(
                writeError,
                actorId,
                workspaceId,
                jobId,
                message.msgId,
                deadline,
              );
            if (
              persistDeadLetterTerminality.outcome ===
              WRITE_REFUSAL_OUTCOMES.EXHAUSTED
            ) {
              return false;
            }
            if (
              persistDeadLetterTerminality.outcome ===
              WRITE_REFUSAL_OUTCOMES.ACKED
            ) {
              return true;
            }
            return false;
          }
          await this.safeArchive(message.msgId, deadline, jobId);
          return false;
        }

        const delay = calculateBackoffDelay(message.readCt);
        await this.safeDefer(message.msgId, Math.round(delay), deadline, jobId);
        return false;
      }

      if (deadline.isWorkExhausted()) {
        this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
        return false;
      }
      try {
        await this.transaction.run(
          actorId,
          async (writeClient) => {
            await this.jobWriter.failJob(
              writeClient,
              workspaceId,
              jobId,
              toProblemDetails(persistHandledError, {
                type: 'https://savia.app/problems/job-failed',
                title: 'Job Failed',
                status: 500,
                code: 'job_failed',
                detail:
                  persistHandledError instanceof Error
                    ? persistHandledError.message
                    : 'Permanent job persist failure.',
              }),
            );
          },
          { workspaceId, jobId, phase: 'transition' },
          'transition',
          deadline.forWork(this.config.transitionTimeoutMs),
        );
      } catch (writeError) {
        if (writeError instanceof DeliveryDeadlineExceededError) {
          this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
          return false;
        }
        const persistFailTerminality = await this.resolveP0001WriteRefusal(
          writeError,
          actorId,
          workspaceId,
          jobId,
          message.msgId,
          deadline,
        );
        if (
          persistFailTerminality.outcome === WRITE_REFUSAL_OUTCOMES.EXHAUSTED
        ) {
          return false;
        }
        if (persistFailTerminality.outcome === WRITE_REFUSAL_OUTCOMES.ACKED) {
          return true;
        }
        return false;
      }
      await this.safeAck(message.msgId, deadline, jobId);
      return false;
    }

    // Ack after successful persist + completed commit
    return await this.safeAck(message.msgId, deadline, jobId);
  }

  private async resolveP0001WriteRefusal(
    error: unknown,
    actorId: string,
    workspaceId: string,
    jobId: string,
    msgId: string | number,
    deadline: DeliveryDeadline,
  ): Promise<WriteRefusalResult> {
    if (!errorHasSqlstate(error, 'P0001')) {
      return { outcome: WRITE_REFUSAL_OUTCOMES.CONTINUE, error };
    }
    if (deadline.isWorkExhausted()) {
      this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
      return { outcome: WRITE_REFUSAL_OUTCOMES.EXHAUSTED, error };
    }
    let job: { readonly status: string } | undefined;
    try {
      job = await this.transaction.runRead(
        actorId,
        (client) => this.jobWriter.findJobById(client, workspaceId, jobId),
        deadline.forWork(this.config.transitionTimeoutMs),
      );
    } catch (recheckError) {
      if (recheckError instanceof DeliveryDeadlineExceededError) {
        this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
        return {
          outcome: WRITE_REFUSAL_OUTCOMES.EXHAUSTED,
          error: recheckError,
        };
      }
      return {
        outcome: WRITE_REFUSAL_OUTCOMES.RECHECK_FAILED,
        error: recheckError,
      };
    }
    if (job && isTerminalJobStatus(job.status)) {
      await this.safeAck(msgId, deadline, jobId);
      return { outcome: WRITE_REFUSAL_OUTCOMES.ACKED, error };
    }
    return { outcome: WRITE_REFUSAL_OUTCOMES.CONTINUE, error };
  }

  private async safeAck(
    msgId: string | number,
    deadline: DeliveryDeadline,
    jobId?: string,
  ): Promise<boolean> {
    if (deadline.isTerminalExhausted()) {
      this.logger.warn(`delivery_deadline_exhausted: job ${jobId ?? msgId}`);
      return false;
    }
    try {
      return await this.queue.ack(
        msgId,
        deadline.forTerminal(this.config.queueTimeoutMs),
      );
    } catch (error) {
      if (error instanceof DeliveryDeadlineExceededError) {
        this.logger.warn(`delivery_deadline_exhausted: job ${jobId ?? msgId}`);
        return false;
      }
      throw error;
    }
  }

  private async safeArchive(
    msgId: string | number,
    deadline: DeliveryDeadline,
    jobId?: string,
  ): Promise<boolean> {
    if (deadline.isTerminalExhausted()) {
      this.logger.warn(`delivery_deadline_exhausted: job ${jobId ?? msgId}`);
      return false;
    }
    try {
      return await this.queue.archive(
        msgId,
        deadline.forTerminal(this.config.queueTimeoutMs),
      );
    } catch (error) {
      if (error instanceof DeliveryDeadlineExceededError) {
        this.logger.warn(`delivery_deadline_exhausted: job ${jobId ?? msgId}`);
        return false;
      }
      throw error;
    }
  }

  private async safeDefer(
    msgId: string | number,
    delaySeconds: number,
    deadline: DeliveryDeadline,
    jobId?: string,
  ): Promise<boolean> {
    if (deadline.isTerminalExhausted()) {
      this.logger.warn(`delivery_deadline_exhausted: job ${jobId ?? msgId}`);
      return false;
    }
    try {
      return await this.queue.defer(
        msgId,
        delaySeconds,
        deadline.forTerminal(this.config.queueTimeoutMs),
      );
    } catch (error) {
      if (error instanceof DeliveryDeadlineExceededError) {
        this.logger.warn(`delivery_deadline_exhausted: job ${jobId ?? msgId}`);
        return false;
      }
      throw error;
    }
  }

  private async safeFailOrphanedJob(
    jobId: string,
    actorId: string,
    deadline: DeliveryDeadline,
  ): Promise<boolean> {
    if (deadline.isTerminalExhausted()) {
      this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
      return false;
    }
    try {
      return await this.queue.failOrphanedJob(
        jobId,
        actorId,
        deadline.forTerminal(this.config.queueTimeoutMs),
      );
    } catch (error) {
      if (error instanceof DeliveryDeadlineExceededError) {
        this.logger.warn(`delivery_deadline_exhausted: job ${jobId}`);
        return false;
      }
      throw error;
    }
  }
}
