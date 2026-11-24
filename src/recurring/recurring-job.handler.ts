import type {
  JobExecutionContext,
  NonRenderingJobHandler,
} from '../platform/job-handler.port.js';
import { JOB_WRITER_TYPES } from '../platform/job-writer.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import type {
  DueOccurrence,
  RecurringMaterializer,
} from './recurring-materializer.js';

type Payload = Pick<DueOccurrence, 'ruleId' | 'scheduledAt' | 'asOf'>;

function utcTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(?:\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export class RecurringJobHandler
  implements NonRenderingJobHandler<Payload, void>
{
  public readonly jobType = JOB_WRITER_TYPES.RECURRING_MATERIALIZATION;

  public constructor(private readonly materializer: RecurringMaterializer) {}

  public parsePayload(raw: unknown): Payload {
    if (typeof raw !== 'object' || raw === null)
      throw new Error('Invalid recurring job payload.');
    const { ruleId, scheduledAt, asOf } = raw as Record<string, unknown>;
    if (
      typeof ruleId !== 'string' ||
      !UUID_PATTERN.test(ruleId) ||
      !utcTimestamp(scheduledAt) ||
      !utcTimestamp(asOf)
    ) {
      throw new Error('Invalid recurring job payload.');
    }
    return { ruleId, scheduledAt, asOf };
  }

  public compute(): Promise<void> {
    return Promise.resolve();
  }

  public persist(
    context: JobExecutionContext<Payload>,
    _computed: void,
    client: TransactionClient,
  ): Promise<string | null> {
    return this.materializer.materialize(client, {
      ...context.payload,
      workspaceId: context.workspaceId,
      subject: context.actorId,
    });
  }
}
