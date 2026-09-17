import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  JobRecord,
  JobWriter,
} from '../../src/platform/job-writer.port.js';
import { JOB_WRITER_TYPES } from '../../src/platform/job-writer.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';

describe('JobWriter port and types', () => {
  it('JOB_WRITER_TYPES includes RECEIPT_OCR', () => {
    expect(JOB_WRITER_TYPES.RECEIPT_OCR).toBe('receipt_ocr');
  });

  it('createQueuedJob return type is Promise<JobRecord>', () => {
    type CreateQueuedJobReturn = ReturnType<JobWriter['createQueuedJob']>;
    expectTypeOf<CreateQueuedJobReturn>().toEqualTypeOf<Promise<JobRecord>>();
  });

  it('JobRecord guarantees typed id: string on queued job', async () => {
    const fakeWriter: Pick<JobWriter, 'createQueuedJob'> = {
      async createQueuedJob(
        _client: TransactionClient,
        _workspaceId: string,
        _subject: string,
        type: (typeof JOB_WRITER_TYPES)[keyof typeof JOB_WRITER_TYPES],
      ): Promise<JobRecord> {
        return {
          id: '00000000-0000-4000-8000-000000000123',
          type,
          status: 'queued',
          progressPercent: null,
          resultResourceId: null,
          error: null,
          createdAt: '2026-09-17T12:00:00.000Z',
          startedAt: null,
          completedAt: null,
        };
      },
    };

    const record = await fakeWriter.createQueuedJob(
      {} as TransactionClient,
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      JOB_WRITER_TYPES.RECEIPT_OCR,
    );

    expect(record.id).toBe('00000000-0000-4000-8000-000000000123');
    expectTypeOf(record.id).toEqualTypeOf<string>();
  });
});
