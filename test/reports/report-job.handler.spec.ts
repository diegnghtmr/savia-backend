import { describe, expect, it, vi } from 'vitest';
import type { ArtifactStorage } from '../../src/platform/artifact-storage.port.js';
import { DeliveryDeadlineExceededError } from '../../src/platform/delivery-deadline.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import type { ReportJobPayload } from '../../src/reports/report-job-payload.js';
import {
  ReportJobHandler,
  ReportWriteForbiddenError,
} from '../../src/reports/report-job.handler.js';
import { PostgresReportAdapter } from '../../src/reports/postgres-report.adapter.js';
import type { ReportGrid } from '../../src/reports/report-engine.js';
import * as serializers from '../../src/reports/report-serializers.js';
import { ReportPdfRowCapExceededError } from '../../src/reports/report.port.js';
import type {
  PdfRenderer,
  PdfRenderOptions,
} from '../../src/platform/pdf-renderer.port.js';
import { FakePdfRenderer } from '../support/fake-pdf-renderer.js';

const payload: ReportJobPayload = {
  version: 1,
  asOf: '2026-09-15T12:00:00.000Z',
  reportRunId: 'eeeeeeee-0000-4000-8000-000000000001',
  format: 'json',
  definitionId: null,
  preset: 'expenses',
  filters: { from: '2026-06-01', to: '2026-06-30' },
  periodStart: '2026-06-01',
  periodTo: '2026-06-30',
  shapeTypeFilter: 'expense',
  callerType: null,
  dimensions: ['category'],
  measures: ['converted_value', 'percentage'],
  objectKey:
    'aaaaaaaa-0000-4000-8000-000000000001/eeeeeeee-0000-4000-8000-000000000001.json',
  baseCurrency: 'USD',
};

const context = {
  jobId: 'aaaaaaaa-0000-4000-8000-000000000099',
  workspaceId: 'aaaaaaaa-0000-4000-8000-000000000001',
  actorId: '11111111-0000-4000-8000-000000000001',
  attemptCount: 1,
  payload,
};

const emptyGrid: ReportGrid = {
  dimensions: ['category'],
  measures: ['converted_value', 'percentage'],
  rows: [],
  warnings: [],
  baseCurrency: 'USD',
};

const pdfContext = {
  ...context,
  payload: {
    ...payload,
    format: 'pdf' as const,
    objectKey: payload.objectKey.replace(/\.json$/, '.pdf'),
  },
};

const csvContext = {
  ...context,
  payload: {
    ...payload,
    format: 'csv' as const,
    objectKey: payload.objectKey.replace(/\.json$/, '.csv'),
  },
};

function largePdfGrid(rowCount: number): ReportGrid {
  return {
    dimensions: ['category'],
    measures: ['converted_value'],
    warnings: [],
    baseCurrency: 'USD',
    rows: Array.from({ length: rowCount }, (_, index) => ({
      key: [`Category ${String(index).padStart(5, '0')} ${'n'.repeat(24)}`],
      cells: [{ measure: 'converted_value', value: String(1_000 + index) }],
    })),
  };
}

function createStorage(): ArtifactStorage & {
  uploaded: string[];
} {
  const uploaded: string[] = [];
  return {
    uploaded,
    upload: vi.fn(async (path: string) => {
      uploaded.push(path);
    }),
    sign: vi.fn(async (path: string, expiresAt: Date) => ({
      url: `https://storage.example.test/${path}`,
      expiresAt,
    })),
    remove: vi.fn(),
  };
}

class GatedSettleFakeRenderer implements PdfRenderer {
  public closeStarted = false;
  private resolveGate: (() => void) | undefined;
  private readonly gatePromise: Promise<void>;

  public constructor() {
    this.gatePromise = new Promise<void>((resolve) => {
      this.resolveGate = resolve;
    });
  }

  public releaseGate(): void {
    this.resolveGate?.();
  }

  public async renderHtmlToPdf(
    _html: string,
    options: PdfRenderOptions,
  ): Promise<Buffer> {
    return new Promise<Buffer>((_resolve, reject) => {
      const onAbort = (): void => {
        this.closeStarted = true;
        void this.gatePromise.then(() => {
          reject(
            new DeliveryDeadlineExceededError(
              'PDF render aborted by delivery deadline.',
            ),
          );
        });
      };
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function createHandler<R extends PdfRenderer = FakePdfRenderer>(
  store: ReturnType<typeof createStore> = createStore(),
  storage: ReturnType<typeof createStorage> = createStorage(),
  clock?: () => Date,
  pdfRenderer: R = new FakePdfRenderer() as unknown as R,
  renderSettleTimeoutMs = 2_000,
): {
  handler: ReportJobHandler;
  pdfRenderer: R;
  store: ReturnType<typeof createStore>;
  storage: ReturnType<typeof createStorage>;
} {
  const handler = new ReportJobHandler(
    store as unknown as PostgresReportAdapter,
    storage,
    pdfRenderer,
    clock ?? (() => new Date()),
    renderSettleTimeoutMs,
  );
  return { handler, pdfRenderer, store, storage };
}

function createStore(role = 'editor') {
  const processing: string[] = [];
  const completed: string[] = [];
  const sourceRowAsOf: Date[] = [];
  return {
    role,
    processing,
    completed,
    sourceRowAsOf,
    readActiveRole: async () => role,
    readReportSourceRows: async (
      _client: TransactionClient,
      _workspaceId: string,
      _from: string,
      _to: string,
      asOf: Date,
    ) => {
      sourceRowAsOf.push(asOf);
      return [];
    },
    readBudgetedMinorByBucket: async () => new Map(),
    readReportRunBinding: async () => ({
      jobId: 'aaaaaaaa-0000-4000-8000-000000000099',
      status: 'queued',
    }),
    beginProcessingReportRun: async (
      _client: TransactionClient,
      _workspaceId: string,
      reportRunId: string,
    ) => {
      processing.push(reportRunId);
    },
    completeProcessingReportRun: async (
      _client: TransactionClient,
      _workspaceId: string,
      reportRunId: string,
    ) => {
      completed.push(reportRunId);
    },
  };
}

describe('ReportJobHandler', () => {
  it('rejects an invalid frozen payload', () => {
    const { handler } = createHandler();
    expect(() => handler.parsePayload({ nope: true })).toThrow(
      /unknown or missing fields/,
    );
  });

  it('rejects a payload whose object key carries a foreign workspace prefix', () => {
    const { handler } = createHandler();
    expect(() =>
      handler.parsePayload(payload, {
        workspaceId: 'bbbbbbbb-0000-4000-8000-000000000001',
      }),
    ).toThrow(/objectKey must match the job workspace/);
  });

  it('refuses compute when the run is bound to a different job', async () => {
    const store = createStore();
    store.readReportRunBinding = async () => ({
      jobId: 'aaaaaaaa-0000-4000-8000-000000000098',
      status: 'queued',
    });
    const { handler } = createHandler(store);
    await expect(
      handler.compute(context, {} as TransactionClient),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(store.sourceRowAsOf).toEqual([]);
  });

  it('refuses compute when the run is not queued or processing', async () => {
    const store = createStore();
    store.readReportRunBinding = async () => ({
      jobId: context.jobId,
      status: 'completed',
    });
    const { handler } = createHandler(store);
    await expect(
      handler.compute(context, {} as TransactionClient),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(store.sourceRowAsOf).toEqual([]);
  });

  it('passes the frozen as-of instant into source-row selection', async () => {
    const store = createStore();
    const { handler } = createHandler(store);
    await handler.compute(context, {} as TransactionClient);
    expect(store.sourceRowAsOf).toEqual([new Date(payload.asOf)]);
  });

  it('uploads to the reserved object key rather than a per-attempt key', async () => {
    const storage = createStorage();
    const { handler } = createHandler(
      createStore(),
      storage,
      () => new Date('2026-09-15T12:00:00.000Z'),
    );
    const first = await handler.render(context, emptyGrid, 5_000);
    await handler.store(context, first, 5_000);
    expect(storage.uploaded).toEqual([payload.objectKey]);
    const second = await handler.render(
      { ...context, attemptCount: 2 },
      emptyGrid,
      5_000,
    );
    await handler.store({ ...context, attemptCount: 2 }, second, 5_000);
    expect(storage.uploaded).toEqual([payload.objectKey, payload.objectKey]);
  });

  it('fails PDF render permanently when the grid exceeds REPORT_PDF_ROW_CAP', async () => {
    const { handler, pdfRenderer } = createHandler(
      createStore(),
      createStorage(),
      () => new Date('2026-09-15T12:00:00.000Z'),
    );
    await expect(
      handler.render(pdfContext, largePdfGrid(2_001), 5_000),
    ).rejects.toBeInstanceOf(ReportPdfRowCapExceededError);
    expect(pdfRenderer.calls).toHaveLength(0);
  });

  it('rejects a PDF render when its phase cap elapses without calling the renderer', async () => {
    const { handler, pdfRenderer } = createHandler(
      createStore(),
      createStorage(),
      () => new Date('2026-09-15T12:00:00.000Z'),
    );
    const started = performance.now();
    await expect(
      handler.render(pdfContext, emptyGrid, 0),
    ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(pdfRenderer.calls).toHaveLength(0);
  }, 10_000);

  it('renders a normal-size PDF under a normal cap', async () => {
    const { handler, pdfRenderer } = createHandler(
      createStore(),
      createStorage(),
      () => new Date('2026-09-15T12:00:00.000Z'),
    );
    const rendered = await handler.render(pdfContext, emptyGrid, 5_000);
    expect(rendered.contentType).toBe('application/pdf');
    expect(rendered.content.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdfRenderer.calls).toHaveLength(1);
  });

  it('rejects a large JSON render when its phase cap elapses', async () => {
    const { handler } = createHandler(
      createStore(),
      createStorage(),
      () => new Date('2026-09-15T12:00:00.000Z'),
    );
    const started = performance.now();
    await expect(
      handler.render(context, largePdfGrid(50_000), 5),
    ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
    expect(performance.now() - started).toBeLessThan(2_000);
  }, 10_000);

  it('rejects a large CSV render when its phase cap elapses', async () => {
    const { handler } = createHandler(
      createStore(),
      createStorage(),
      () => new Date('2026-09-15T12:00:00.000Z'),
    );
    const started = performance.now();
    await expect(
      handler.render(csvContext, largePdfGrid(50_000), 5),
    ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
    expect(performance.now() - started).toBeLessThan(2_000);
  }, 10_000);

  it('fails the render phase when it exceeds its own cap without uploading', async () => {
    const storage = createStorage();
    const { handler } = createHandler(
      createStore(),
      storage,
      () => new Date('2026-09-15T12:00:00.000Z'),
    );
    vi.spyOn(serializers, 'serializeReport').mockImplementation(
      () => new Promise(() => undefined),
    );
    try {
      await expect(
        handler.render(context, emptyGrid, 20),
      ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
      expect(storage.uploaded).toEqual([]);
      expect(storage.upload).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('fails the storage phase immediately when it exceeds its own cap without settle grace', async () => {
    const storage = createStorage();
    storage.upload = vi.fn(async () => new Promise<void>(() => undefined));
    const { handler } = createHandler(
      createStore(),
      storage,
      () => new Date('2026-09-15T12:00:00.000Z'),
    );
    const rendered = await handler.render(context, emptyGrid, 5_000);
    const start = performance.now();
    await expect(handler.store(context, rendered, 20)).rejects.toBeInstanceOf(
      DeliveryDeadlineExceededError,
    );
    const elapsed = performance.now() - start;
    // Must reject promptly at timeout (20ms), never waiting for the 2,000ms render settle tail
    expect(elapsed).toBeLessThan(100);
  });

  it('handler waits for renderer settlement before rejecting with DeliveryDeadlineExceededError', async () => {
    const fakeRenderer = new GatedSettleFakeRenderer();
    const { handler } = createHandler(
      createStore(),
      createStorage(),
      undefined,
      fakeRenderer,
      1_000,
    );

    const renderPromise = handler.render(pdfContext, emptyGrid, 20);
    let settled = false;
    renderPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.waitFor(() => {
      expect(fakeRenderer.closeStarted).toBe(true);
    });
    // Yield a tick: if runBounded rejected immediately without waiting, settled would be true here
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(settled).toBe(false);

    fakeRenderer.releaseGate();
    await expect(renderPromise).rejects.toBeInstanceOf(
      DeliveryDeadlineExceededError,
    );
    expect(settled).toBe(true);
  });

  it('handler rejects with DeliveryDeadlineExceededError after the settle cap if gate is never released', async () => {
    const fakeRenderer = new GatedSettleFakeRenderer();
    const { handler } = createHandler(
      createStore(),
      createStorage(),
      undefined,
      fakeRenderer,
      200,
    );

    const renderPromise = handler.render(pdfContext, emptyGrid, 20);
    let settled = false;
    renderPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.waitFor(() => {
      expect(fakeRenderer.closeStarted).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    // Wait past the 40ms settle cap
    await expect(renderPromise).rejects.toBeInstanceOf(
      DeliveryDeadlineExceededError,
    );
    expect(settled).toBe(true);
  });

  it('refuses persist when the actor no longer has a write role', async () => {
    const store = createStore('viewer');
    const { handler } = createHandler(store);
    await expect(
      handler.persist(
        context,
        {
          downloadUrl: 'https://storage.example.test/report.json',
          expiresAt: new Date('2026-09-22T12:00:00.000Z'),
          completedAt: new Date('2026-09-15T12:00:00.000Z'),
        },
        {} as TransactionClient,
      ),
    ).rejects.toBeInstanceOf(ReportWriteForbiddenError);
    expect(store.processing).toHaveLength(0);
    expect(store.completed).toHaveLength(0);
  });

  it('marks the run processing then completed after re-checking the write role', async () => {
    const store = createStore('editor');
    const { handler } = createHandler(store);
    const id = await handler.persist(
      context,
      {
        downloadUrl: 'https://storage.example.test/report.json',
        expiresAt: new Date('2026-09-22T12:00:00.000Z'),
        completedAt: new Date('2026-09-15T12:00:00.000Z'),
      },
      {} as TransactionClient,
    );
    expect(id).toBe(payload.reportRunId);
    expect(store.processing).toEqual([payload.reportRunId]);
    expect(store.completed).toEqual([payload.reportRunId]);
  });
});
