import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeliveryDeadlineExceededError } from '../../src/platform/delivery-deadline.js';
import {
  PdfRenderTimeoutError,
  PlaywrightPdfRenderer,
  RENDER_PHASES,
  type RenderPhase,
} from '../../src/platform/playwright-pdf-renderer.js';
import type { ReportGrid } from '../../src/reports/report-engine.js';
import { renderReportHtml } from '../../src/reports/report-html-template.js';
import {
  REPORT_DIMENSION,
  REPORT_MEASURE,
} from '../../src/reports/report.port.js';
import type { ArtifactStorage } from '../../src/platform/artifact-storage.port.js';
import type { PostgresReportAdapter } from '../../src/reports/postgres-report.adapter.js';
import { ReportJobHandler } from '../../src/reports/report-job.handler.js';

function makeGrid(rowCount: number): ReportGrid {
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    key: [`2026-${String((i % 12) + 1).padStart(2, '0')}`],
    cells: [
      {
        measure: REPORT_MEASURE.CONVERTED_VALUE,
        value: String(i * 100),
      },
      { measure: REPORT_MEASURE.COUNT, value: '1' },
    ],
  }));
  return {
    dimensions: [REPORT_DIMENSION.MONTH],
    measures: [REPORT_MEASURE.CONVERTED_VALUE, REPORT_MEASURE.COUNT],
    baseCurrency: 'USD',
    warnings: [],
    rows,
  };
}

const INERT_SCRIPT_HTML = `<!DOCTYPE html>
<html><head><title>Report</title></head>
<body>
<script>document.title = 'HACKED';</script>
<p id="marker">safe content</p>
</body></html>`;

function childPids(parentPid: number): number[] {
  const children: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const status = readFileSync(`/proc/${entry}/status`, 'utf8');
      const ppid = /^PPid:\t(\d+)/m.exec(status)?.[1];
      if (ppid === String(parentPid)) {
        children.push(Number(entry));
      }
    } catch {
      continue;
    }
  }
  return children;
}

function killChromiumDescendants(rootPid: number): void {
  const queue = [...childPids(rootPid)];
  const chromePids: number[] = [];
  while (queue.length > 0) {
    const pid = queue.pop();
    if (pid === undefined) {
      continue;
    }
    queue.push(...childPids(pid));
    try {
      const comm = readFileSync(`/proc/${String(pid)}/comm`, 'utf8').trim();
      if (/chrom|headless_shell/i.test(comm)) {
        chromePids.push(pid);
      }
    } catch {
      continue;
    }
  }
  for (const pid of chromePids) {
    process.kill(pid, 'SIGKILL');
  }
}

async function listenLocal(): Promise<{
  server: Server;
  port: number;
  requestCount: { value: number };
}> {
  const requestCount = { value: 0 };
  const server: Server = await new Promise((resolve) => {
    const created = createServer((_req, res) => {
      requestCount.value += 1;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('should not reach');
    });
    created.listen(0, '127.0.0.1', () => {
      resolve(created);
    });
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('Failed to get server address');
  }
  return { server, port: address.port, requestCount };
}

describe('PDF renderer integration (no DB)', () => {
  let renderer: PlaywrightPdfRenderer;

  beforeAll(() => {
    renderer = new PlaywrightPdfRenderer();
  });

  afterAll(async () => {
    await renderer.onModuleDestroy();
  });

  it('produces output starting with %PDF-', async () => {
    const html = renderReportHtml(makeGrid(5));
    const pdf = await renderer.renderHtmlToPdf(html, { timeoutMs: 15_000 });

    expect(pdf).toBeInstanceOf(Buffer);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('injected <script> stays inert (does not execute JS)', async () => {
    const pdf = await renderer.renderHtmlToPdf(INERT_SCRIPT_HTML, {
      timeoutMs: 15_000,
    });

    const pdfText = pdf.toString('latin1');
    expect(pdfText).toContain('/Title (Report)');
    expect(pdfText).not.toContain('HACKED');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('blocks page resource requests to external URLs', async () => {
    const { server, port, requestCount } = await listenLocal();
    try {
      const html = `<!DOCTYPE html>
<html><head></head><body>
<img src="http://127.0.0.1:${String(port)}/should-be-blocked.png" />
<link rel="stylesheet" href="http://127.0.0.1:${String(port)}/style.css" />
</body></html>`;

      await renderer.renderHtmlToPdf(html, { timeoutMs: 15_000 });

      expect(renderer.lastAbortedRequestCount).toBeGreaterThan(0);
      expect(requestCount.value).toBe(0);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it('throws a typed error when render exceeds the hard timeout', async () => {
    const html = renderReportHtml(makeGrid(500));

    await expect(
      renderer.renderHtmlToPdf(html, { timeoutMs: 1 }),
    ).rejects.toThrow(PdfRenderTimeoutError);
  });

  it('throws DeliveryDeadlineExceededError for an already-exhausted budget without launching', async () => {
    const isolated = new PlaywrightPdfRenderer();
    try {
      await expect(
        isolated.renderHtmlToPdf('<html></html>', { timeoutMs: 0 }),
      ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
      expect(isolated.hasOpenBrowser()).toBe(false);
    } finally {
      await isolated.onModuleDestroy();
    }
  });

  it('throws DeliveryDeadlineExceededError when the budget elapses mid-render', async () => {
    const controller = new AbortController();
    const html = renderReportHtml(makeGrid(2000));
    const pending = renderer.renderHtmlToPdf(html, {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 5);
    await expect(pending).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
  });

  it('relaunches Chromium after browser process crash and next render succeeds', async () => {
    const html1 = renderReportHtml(makeGrid(1));
    const pdf1 = await renderer.renderHtmlToPdf(html1, { timeoutMs: 15_000 });
    expect(pdf1.subarray(0, 5).toString()).toBe('%PDF-');

    killChromiumDescendants(process.pid);
    const waitStart = performance.now();
    while (renderer.hasOpenBrowser() && performance.now() - waitStart < 5_000) {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
    expect(renderer.hasOpenBrowser()).toBe(false);

    const html2 = renderReportHtml(makeGrid(2));
    const pdf2 = await renderer.renderHtmlToPdf(html2, { timeoutMs: 15_000 });
    expect(pdf2.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('renders 2000 rows within the budget', async () => {
    const grid = makeGrid(2000);
    const html = renderReportHtml(grid);

    const start = performance.now();
    const pdf = await renderer.renderHtmlToPdf(html, { timeoutMs: 30_000 });
    const elapsed = performance.now() - start;

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(elapsed).toBeLessThan(30_000);
    console.log(
      `2000-row render completed in ${String(Math.round(elapsed))}ms`,
    );
  });

  it('closes browser context before renderer hard timeout rejects', async () => {
    const html = renderReportHtml(makeGrid(500));

    let error: unknown;
    try {
      await renderer.renderHtmlToPdf(html, { timeoutMs: 1 });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(PdfRenderTimeoutError);
    expect(renderer.openContextCount()).toBe(0);
  });

  it('closes browser context before rejecting an abort that lands during setContent', async () => {
    const phases: RenderPhase[] = [];
    const controller = new AbortController();
    let abortTime = 0;
    const localRenderer = new PlaywrightPdfRenderer({
      observer: (_renderId, phase) => {
        phases.push(phase);
        if (phase === RENDER_PHASES.SET_CONTENT_STARTED) {
          abortTime = performance.now();
          controller.abort();
        }
      },
    });

    try {
      const rows = Array.from(
        { length: 10_000 },
        (_, i) => `<tr><td>row ${String(i)}</td></tr>`,
      ).join('');
      const html = `<!DOCTYPE html><html><body><table>${rows}</table></body></html>`;
      const pending = localRenderer.renderHtmlToPdf(html, {
        timeoutMs: 30_000,
        signal: controller.signal,
      });

      let error: unknown;
      try {
        await pending;
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(DeliveryDeadlineExceededError);
      expect(localRenderer.openContextCount()).toBe(0);
      expect(phases).toContain(RENDER_PHASES.SET_CONTENT_STARTED);
      expect(phases).toContain(RENDER_PHASES.CONTEXT_CLOSED);
      expect(phases).not.toContain(RENDER_PHASES.SET_CONTENT_SETTLED);
      expect(phases).not.toContain(RENDER_PHASES.PDF_STARTED);
      expect(performance.now() - abortTime).toBeLessThan(45);
    } finally {
      await localRenderer.onModuleDestroy();
    }
  });

  it('attributes render phases to the correct per-render id for overlapping renders', async () => {
    const events: Array<{ renderId: string; phase: RenderPhase }> = [];
    const localRenderer = new PlaywrightPdfRenderer({
      observer: (renderId, phase) => {
        events.push({ renderId, phase });
      },
    });

    try {
      const html1 =
        '<!DOCTYPE html><html><body><h1>Render 1</h1></body></html>';
      const html2 =
        '<!DOCTYPE html><html><body><h1>Render 2</h1></body></html>';

      const [pdf1, pdf2] = await Promise.all([
        localRenderer.renderHtmlToPdf(html1, {
          timeoutMs: 10_000,
          renderId: 'render-a',
        }),
        localRenderer.renderHtmlToPdf(html2, {
          timeoutMs: 10_000,
          renderId: 'render-b',
        }),
      ]);

      expect(pdf1.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(pdf2.subarray(0, 5).toString('ascii')).toBe('%PDF-');

      const renderAPhases = events
        .filter((e) => e.renderId === 'render-a')
        .map((e) => e.phase);
      const renderBPhases = events
        .filter((e) => e.renderId === 'render-b')
        .map((e) => e.phase);

      expect(renderAPhases).toEqual([
        RENDER_PHASES.SET_CONTENT_STARTED,
        RENDER_PHASES.SET_CONTENT_SETTLED,
        RENDER_PHASES.PDF_STARTED,
        RENDER_PHASES.CONTEXT_CLOSED,
      ]);
      expect(renderBPhases).toEqual([
        RENDER_PHASES.SET_CONTENT_STARTED,
        RENDER_PHASES.SET_CONTENT_SETTLED,
        RENDER_PHASES.PDF_STARTED,
        RENDER_PHASES.CONTEXT_CLOSED,
      ]);
    } finally {
      await localRenderer.onModuleDestroy();
    }
  });

  it('handler-level render with tiny phase cap on 2000-row grid rejects with DeliveryDeadlineExceededError and 0 open contexts', async () => {
    const handler = new ReportJobHandler(
      {} as PostgresReportAdapter,
      {} as ArtifactStorage,
      renderer,
    );
    const grid = makeGrid(2000);
    const jobContext = {
      jobId: '11111111-1111-4111-8111-111111111111',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      actorId: '33333333-3333-4333-8333-333333333333',
      attemptCount: 1,
      payload: {
        version: 1 as const,
        asOf: '2026-09-15T12:00:00.000Z',
        reportRunId: '44444444-4444-4444-8444-444444444444',
        format: 'pdf' as const,
        definitionId: null,
        preset: 'expenses' as const,
        filters: { from: '2026-06-01', to: '2026-06-30' },
        periodStart: '2026-06-01',
        periodTo: '2026-06-30',
        shapeTypeFilter: 'expense' as const,
        callerType: null,
        dimensions: [REPORT_DIMENSION.MONTH],
        measures: [REPORT_MEASURE.CONVERTED_VALUE, REPORT_MEASURE.COUNT],
        objectKey: 'workspace/report.pdf',
        baseCurrency: 'USD',
      },
    };

    let error: unknown;
    try {
      await handler.render(jobContext, grid, 12);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(DeliveryDeadlineExceededError);
    expect(renderer.openContextCount()).toBe(0);
  });
});
