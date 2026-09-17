import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@nestjs/common';
import type { Browser, BrowserContext } from 'playwright-core';
import { DeliveryDeadlineExceededError } from '../../src/platform/delivery-deadline.js';
import {
  PdfRenderTimeoutError,
  PlaywrightPdfRenderer,
  RENDER_PHASES,
  type RenderObserverEvent,
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
    renderer = new PlaywrightPdfRenderer(2_000);
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
    const abortedEvents: RenderObserverEvent[] = [];
    const localRenderer = new PlaywrightPdfRenderer({
      renderSettleTimeoutMs: 2_000,
      observer: (event) => {
        if (event.phase === RENDER_PHASES.REQUEST_ABORTED) {
          abortedEvents.push(event);
        }
      },
    });

    try {
      const html = `<!DOCTYPE html>
<html><head></head><body>
<img src="http://127.0.0.1:${String(port)}/should-be-blocked.png" />
<link rel="stylesheet" href="http://127.0.0.1:${String(port)}/style.css" />
</body></html>`;

      await localRenderer.renderHtmlToPdf(html, {
        timeoutMs: 15_000,
        correlationId: 'block-req',
      });

      expect(abortedEvents.length).toBeGreaterThan(0);
      expect(abortedEvents.every((e) => e.correlationId === 'block-req')).toBe(
        true,
      );
      expect(requestCount.value).toBe(0);
    } finally {
      await localRenderer.onModuleDestroy();
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
    const isolated = new PlaywrightPdfRenderer(2_000);
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
      renderSettleTimeoutMs: 2_000,
      observer: (event) => {
        phases.push(event.phase);
        if (event.phase === RENDER_PHASES.SET_CONTENT_STARTED) {
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

  it('attributes render phases to distinct invocation ids for overlapping renders with the same caller correlation id', async () => {
    const events: RenderObserverEvent[] = [];
    const localRenderer = new PlaywrightPdfRenderer({
      renderSettleTimeoutMs: 2_000,
      observer: (event) => {
        events.push(event);
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
          correlationId: 'same-correlation-id',
        }),
        localRenderer.renderHtmlToPdf(html2, {
          timeoutMs: 10_000,
          correlationId: 'same-correlation-id',
        }),
      ]);

      expect(pdf1.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(pdf2.subarray(0, 5).toString('ascii')).toBe('%PDF-');

      const invocationIds = [...new Set(events.map((e) => e.invocationId))];
      expect(invocationIds).toHaveLength(2);
      const [id1, id2] = invocationIds;

      const render1Phases = events
        .filter((e) => e.invocationId === id1)
        .map((e) => e.phase);
      const render2Phases = events
        .filter((e) => e.invocationId === id2)
        .map((e) => e.phase);

      const expectedPhases = [
        RENDER_PHASES.SET_CONTENT_STARTED,
        RENDER_PHASES.SET_CONTENT_SETTLED,
        RENDER_PHASES.PDF_STARTED,
        RENDER_PHASES.CONTEXT_CLOSED,
      ];

      expect(render1Phases).toEqual(expectedPhases);
      expect(render2Phases).toEqual(expectedPhases);

      for (const event of events) {
        expect(event.correlationId).toBe('same-correlation-id');
      }
    } finally {
      await localRenderer.onModuleDestroy();
    }
  });

  it('continues rendering successfully and returns identical PDF bytes when observer throws at any phase', async () => {
    class CustomObserverError extends Error {
      public constructor(phase: string) {
        super(`Observer threw at phase ${phase}`);
        this.name = 'CustomObserverError';
      }
    }

    const testHtml =
      '<!DOCTYPE html><html><body><p>Observer resilience</p><img src="http://127.0.0.1:9999/test-img.png" /></body></html>';

    const baselineBytes = Buffer.from(
      '%PDF-1.4 fixed deterministic test pdf bytes',
    );

    const createDeterministicFakeBrowser = (): Browser => {
      let registeredRouteHandler:
        | ((route: { abort: () => Promise<void> }) => Promise<void>)
        | undefined;
      const fakeBrowser: Browser = {
        close: vi.fn(async () => {}),
        on: vi.fn(),
        newContext: vi.fn(async () => ({
          browser: () => fakeBrowser,
          route: vi.fn(
            async (
              _url: unknown,
              handler: (route: { abort: () => Promise<void> }) => Promise<void>,
            ) => {
              registeredRouteHandler = handler;
            },
          ),
          newPage: vi.fn(async () => ({
            setContent: vi.fn(async () => {
              if (registeredRouteHandler) {
                await registeredRouteHandler({ abort: vi.fn(async () => {}) });
              }
            }),
            pdf: vi.fn(async () => baselineBytes),
          })),
          close: vi.fn(async () => {}),
        })),
      } as unknown as Browser;
      return fakeBrowser;
    };

    for (const failingPhase of Object.values(RENDER_PHASES)) {
      const warnLogs: string[] = [];
      const mockLogger = {
        warn: (msg: string) => warnLogs.push(msg),
        log: () => {},
        error: () => {},
        debug: () => {},
        verbose: () => {},
      } as unknown as Logger;

      const throwingRenderer = new PlaywrightPdfRenderer({
        renderSettleTimeoutMs: 2_000,
        logger: mockLogger,
        browserLauncher: async () => createDeterministicFakeBrowser(),
        observer: (event) => {
          if (event.phase === failingPhase) {
            throw new CustomObserverError(failingPhase);
          }
        },
      });

      try {
        const pdf = await throwingRenderer.renderHtmlToPdf(testHtml, {
          timeoutMs: 15_000,
        });

        expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
        expect(Buffer.compare(pdf, baselineBytes)).toBe(0);

        expect(
          warnLogs.some(
            (msg) =>
              msg.includes(
                `Render observer failed at phase ${failingPhase}: CustomObserverError`,
              ) && !msg.includes('Observer threw at phase'),
          ),
        ).toBe(true);
      } finally {
        await throwingRenderer.onModuleDestroy();
      }
    }
  });

  it('handler-level render with tiny phase cap on 2000-row grid rejects with DeliveryDeadlineExceededError and 0 open contexts', async () => {
    const handler = new ReportJobHandler(
      {} as PostgresReportAdapter,
      {} as ArtifactStorage,
      renderer,
      undefined,
      2_000,
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

  it('quarantines browser and launches fresh browser on next render when context close rejects', async () => {
    let launchCount = 0;
    const warnLogs: string[] = [];

    const mockLogger = {
      warn: (msg: string) => warnLogs.push(msg),
      log: () => {},
      error: () => {},
      debug: () => {},
      verbose: () => {},
    } as unknown as Logger;

    const fakeBrowser1: Browser = {
      close: vi.fn(async () => {}),
      on: vi.fn(),
      newContext: vi.fn(async () => {
        return {
          browser: () => fakeBrowser1,
          route: vi.fn(async () => {}),
          newPage: vi.fn(async () => ({
            setContent: vi.fn(async () => {}),
            pdf: vi.fn(async () => Buffer.from('%PDF-1.4 test1')),
          })),
          close: vi.fn(async () => {
            throw new Error('Forced context close rejection');
          }),
        } as unknown as BrowserContext;
      }),
    } as unknown as Browser;

    const fakeBrowser2: Browser = {
      close: vi.fn(async () => {}),
      on: vi.fn(),
      newContext: vi.fn(async () => {
        return {
          browser: () => fakeBrowser2,
          route: vi.fn(async () => {}),
          newPage: vi.fn(async () => ({
            setContent: vi.fn(async () => {}),
            pdf: vi.fn(async () => Buffer.from('%PDF-1.4 test2')),
          })),
          close: vi.fn(async () => {}),
        } as unknown as BrowserContext;
      }),
    } as unknown as Browser;

    const localRenderer = new PlaywrightPdfRenderer({
      renderSettleTimeoutMs: 100,
      browserLauncher: async () => {
        launchCount += 1;
        return launchCount === 1 ? fakeBrowser1 : fakeBrowser2;
      },
      logger: mockLogger,
    });

    try {
      const start1 = performance.now();
      const pdf1 = await localRenderer.renderHtmlToPdf('<p>one</p>', {
        timeoutMs: 5_000,
      });
      const elapsed1 = performance.now() - start1;

      expect(pdf1.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(elapsed1).toBeLessThan(100);
      expect(launchCount).toBe(1);

      // Verify browser 1 was closed in background
      expect(fakeBrowser1.close).toHaveBeenCalled();

      // Verify warning logged with fixed text and error class name only (never error message)
      expect(
        warnLogs.some(
          (l) =>
            l.includes('Quarantining browser generation 1: Error') &&
            !l.includes('Forced context close rejection'),
        ),
      ).toBe(true);

      // Next render must use a fresh browser
      const pdf2 = await localRenderer.renderHtmlToPdf('<p>two</p>', {
        timeoutMs: 5_000,
      });

      expect(pdf2.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(launchCount).toBe(2);
      expect(fakeBrowser2.newContext).toHaveBeenCalled();
    } finally {
      await localRenderer.onModuleDestroy();
    }
  });

  it('quarantines browser and launches fresh browser on next render when context close never settles', async () => {
    let launchCount = 0;
    const warnLogs: string[] = [];

    const mockLogger = {
      warn: (msg: string) => warnLogs.push(msg),
      log: () => {},
      error: () => {},
      debug: () => {},
      verbose: () => {},
    } as unknown as Logger;

    const fakeBrowser1: Browser = {
      close: vi.fn(async () => {}),
      on: vi.fn(),
      newContext: vi.fn(async () => {
        return {
          browser: () => fakeBrowser1,
          route: vi.fn(async () => {}),
          newPage: vi.fn(async () => ({
            setContent: vi.fn(async () => {}),
            pdf: vi.fn(async () => Buffer.from('%PDF-1.4 test1')),
          })),
          close: vi.fn(async () => new Promise<void>(() => {})),
        } as unknown as BrowserContext;
      }),
    } as unknown as Browser;

    const fakeBrowser2: Browser = {
      close: vi.fn(async () => {}),
      on: vi.fn(),
      newContext: vi.fn(async () => {
        return {
          browser: () => fakeBrowser2,
          route: vi.fn(async () => {}),
          newPage: vi.fn(async () => ({
            setContent: vi.fn(async () => {}),
            pdf: vi.fn(async () => Buffer.from('%PDF-1.4 test2')),
          })),
          close: vi.fn(async () => {}),
        } as unknown as BrowserContext;
      }),
    } as unknown as Browser;

    const settleTimeoutMs = 60;
    const localRenderer = new PlaywrightPdfRenderer({
      renderSettleTimeoutMs: settleTimeoutMs,
      browserLauncher: async () => {
        launchCount += 1;
        return launchCount === 1 ? fakeBrowser1 : fakeBrowser2;
      },
      logger: mockLogger,
    });

    try {
      const start1 = performance.now();
      const pdf1 = await localRenderer.renderHtmlToPdf('<p>one</p>', {
        timeoutMs: 5_000,
      });
      const elapsed1 = performance.now() - start1;

      expect(pdf1.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(elapsed1).toBeGreaterThanOrEqual(settleTimeoutMs - 10);
      expect(elapsed1).toBeLessThan(settleTimeoutMs + 100);
      expect(launchCount).toBe(1);

      // Verify browser 1 close was called
      expect(fakeBrowser1.close).toHaveBeenCalled();

      // Verify warning logged with fixed text and error class name only
      expect(
        warnLogs.some((l) =>
          l.includes('Quarantining browser generation 1: TimeoutError'),
        ),
      ).toBe(true);

      // Next render must use a fresh browser
      const pdf2 = await localRenderer.renderHtmlToPdf('<p>two</p>', {
        timeoutMs: 5_000,
      });

      expect(pdf2.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(launchCount).toBe(2);
      expect(fakeBrowser2.newContext).toHaveBeenCalled();
    } finally {
      await localRenderer.onModuleDestroy();
    }
  });

  it('(a) overlapping renders: render A close fails while render B is still running on same generation -> B completes and browser closed only after B finishes', async () => {
    let bRenderDone = false;
    let oldBrowserClosedBeforeB = false;

    let bPdfRelease: () => void;
    const bPdfGate = new Promise<void>((resolve) => {
      bPdfRelease = resolve;
    });

    let bContextCreatedResolve: () => void;
    const bContextCreatedGate = new Promise<void>((resolve) => {
      bContextCreatedResolve = resolve;
    });

    const fakeBrowser1: Browser = {
      close: vi.fn(async () => {
        if (!bRenderDone) {
          oldBrowserClosedBeforeB = true;
        }
      }),
      on: vi.fn(),
      newContext: vi
        .fn()
        .mockImplementationOnce(async () => ({
          browser: () => fakeBrowser1,
          route: vi.fn(async () => {}),
          newPage: vi.fn(async () => ({
            setContent: vi.fn(async () => {}),
            pdf: vi.fn(async () => Buffer.from('%PDF-1.4 renderA')),
          })),
          close: vi.fn(async () => {
            await bContextCreatedGate;
            throw new Error('Forced context close failure for render A');
          }),
        }))
        .mockImplementationOnce(async () => {
          bContextCreatedResolve();
          return {
            browser: () => fakeBrowser1,
            route: vi.fn(async () => {}),
            newPage: vi.fn(async () => ({
              setContent: vi.fn(async () => {}),
              pdf: vi.fn(async () => {
                await bPdfGate;
                bRenderDone = true;
                return Buffer.from('%PDF-1.4 renderB');
              }),
            })),
            close: vi.fn(async () => {}),
          };
        }),
    } as unknown as Browser;

    const localRenderer = new PlaywrightPdfRenderer({
      renderSettleTimeoutMs: 100,
      browserLauncher: async () => fakeBrowser1,
    });

    try {
      const promiseA = localRenderer.renderHtmlToPdf('<p>A</p>', {
        timeoutMs: 5_000,
      });
      const promiseB = localRenderer.renderHtmlToPdf('<p>B</p>', {
        timeoutMs: 5_000,
      });

      const pdfA = await promiseA;
      expect(pdfA.subarray(0, 5).toString('ascii')).toBe('%PDF-');

      // Generation 1 is quarantined, but render B is still running!
      expect(fakeBrowser1.close).not.toHaveBeenCalled();
      expect(oldBrowserClosedBeforeB).toBe(false);

      // Now release render B's gate
      bPdfRelease!();
      const pdfB = await promiseB;

      expect(pdfB.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      await new Promise((r) => setTimeout(r, 20));
      expect(fakeBrowser1.close).toHaveBeenCalled();
      expect(oldBrowserClosedBeforeB).toBe(false);
    } finally {
      await localRenderer.onModuleDestroy();
    }
  });

  it('(b) generation 1 quarantined, generation 2 launched, then late close failure from generation 1 leaves generation 2 cached', async () => {
    let launchCount = 0;
    let lateCloseReject: (err: Error) => void;
    const lateClosePromise = new Promise<void>((_, reject) => {
      lateCloseReject = reject;
    });

    let render2ContextCreatedResolve: () => void;
    const render2ContextCreatedGate = new Promise<void>((resolve) => {
      render2ContextCreatedResolve = resolve;
    });

    const fakeBrowser1: Browser = {
      close: vi.fn(async () => {}),
      on: vi.fn(),
      newContext: vi
        .fn()
        .mockImplementationOnce(async () => ({
          browser: () => fakeBrowser1,
          route: vi.fn(async () => {}),
          newPage: vi.fn(async () => ({
            setContent: vi.fn(async () => {}),
            pdf: vi.fn(async () => Buffer.from('%PDF-1.4 gen1-render1')),
          })),
          close: vi.fn(async () => {
            await render2ContextCreatedGate;
            throw new Error('Immediate failure on context 1');
          }),
        }))
        .mockImplementationOnce(async () => {
          render2ContextCreatedResolve();
          return {
            browser: () => fakeBrowser1,
            route: vi.fn(async () => {}),
            newPage: vi.fn(async () => ({
              setContent: vi.fn(async () => {}),
              pdf: vi.fn(async () => Buffer.from('%PDF-1.4 gen1-render2')),
            })),
            close: vi.fn(async () => lateClosePromise),
          };
        }),
    } as unknown as Browser;

    const fakeBrowser2: Browser = {
      close: vi.fn(async () => {}),
      on: vi.fn(),
      newContext: vi.fn(async () => ({
        browser: () => fakeBrowser2,
        route: vi.fn(async () => {}),
        newPage: vi.fn(async () => ({
          setContent: vi.fn(async () => {}),
          pdf: vi.fn(async () => Buffer.from('%PDF-1.4 gen2-render')),
        })),
        close: vi.fn(async () => {}),
      })),
    } as unknown as Browser;

    const fakeBrowser3: Browser = {
      close: vi.fn(async () => {}),
      on: vi.fn(),
      newContext: vi.fn(async () => ({
        browser: () => fakeBrowser3,
        route: vi.fn(async () => {}),
        newPage: vi.fn(async () => ({
          setContent: vi.fn(async () => {}),
          pdf: vi.fn(async () => Buffer.from('%PDF-1.4 gen3-render')),
        })),
        close: vi.fn(async () => {}),
      })),
    } as unknown as Browser;

    const localRenderer = new PlaywrightPdfRenderer({
      renderSettleTimeoutMs: 100,
      browserLauncher: async () => {
        launchCount += 1;
        if (launchCount === 1) return fakeBrowser1;
        if (launchCount === 2) return fakeBrowser2;
        return fakeBrowser3;
      },
    });

    try {
      const promise1 = localRenderer.renderHtmlToPdf('<p>gen1-1</p>', {
        timeoutMs: 5_000,
      });
      const promise2 = localRenderer.renderHtmlToPdf('<p>gen1-2</p>', {
        timeoutMs: 5_000,
      });

      await promise1;
      expect(launchCount).toBe(1);

      // Gen 1 is quarantined, next render launches gen 2
      const pdf3 = await localRenderer.renderHtmlToPdf('<p>gen2-1</p>', {
        timeoutMs: 5_000,
      });
      expect(pdf3.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(launchCount).toBe(2);

      // Now late close failure from gen 1 context 2 occurs
      lateCloseReject!(new Error('Late failure from gen 1 context 2'));
      await promise2;

      // Render 4 starts -> must use cached gen 2, not launch browser 3
      const pdf4 = await localRenderer.renderHtmlToPdf('<p>gen2-2</p>', {
        timeoutMs: 5_000,
      });
      expect(pdf4.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(launchCount).toBe(2);
      expect(fakeBrowser3.newContext).not.toHaveBeenCalled();
    } finally {
      await localRenderer.onModuleDestroy();
    }
  });

  it('(c) drain cap elapses with a render still stuck -> old browser is closed in background', async () => {
    let browser1CloseCalled = false;
    let browser1ClosedResolve: () => void;
    const browser1ClosedPromise = new Promise<void>((resolve) => {
      browser1ClosedResolve = resolve;
    });

    let stuckContextCreatedResolve: () => void;
    const stuckContextCreatedGate = new Promise<void>((resolve) => {
      stuckContextCreatedResolve = resolve;
    });

    const fakeBrowser1: Browser = {
      close: vi.fn(async () => {
        browser1CloseCalled = true;
        browser1ClosedResolve();
      }),
      on: vi.fn(),
      newContext: vi
        .fn()
        .mockImplementationOnce(async () => {
          stuckContextCreatedResolve();
          return {
            browser: () => fakeBrowser1,
            route: vi.fn(async () => {}),
            newPage: vi.fn(async () => ({
              setContent: vi.fn(async () => {}),
              pdf: vi.fn(async () => new Promise<Buffer>(() => {})), // stuck render
            })),
            close: vi.fn(async () => {}),
          };
        })
        .mockImplementationOnce(async () => ({
          browser: () => fakeBrowser1,
          route: vi.fn(async () => {}),
          newPage: vi.fn(async () => ({
            setContent: vi.fn(async () => {}),
            pdf: vi.fn(async () => Buffer.from('%PDF-1.4 renderA')),
          })),
          close: vi.fn(async () => {
            throw new Error('Close failed immediately');
          }),
        })),
    } as unknown as Browser;

    const renderSettleTimeoutMs = 25;
    const pdfRenderTimeoutMs = 35; // drain cap = 60ms
    const localRenderer = new PlaywrightPdfRenderer({
      renderSettleTimeoutMs,
      pdfRenderTimeoutMs,
      browserLauncher: async () => fakeBrowser1,
    });

    const controller = new AbortController();

    try {
      const stuckPromise = localRenderer
        .renderHtmlToPdf('<p>stuck</p>', {
          timeoutMs: 5_000,
          signal: controller.signal,
        })
        .catch(() => {});

      // Wait until stuck render has created context on fakeBrowser1
      await stuckContextCreatedGate;

      // Render A runs and its context close fails immediately, quarantining fakeBrowser1
      await localRenderer.renderHtmlToPdf('<p>A</p>', { timeoutMs: 5_000 });

      // Stuck render is still active on fakeBrowser1, so fakeBrowser1 must not be closed yet
      expect(fakeBrowser1.close).not.toHaveBeenCalled();

      // Wait for drain cap (60ms) to trigger background browser close
      await Promise.race([
        browser1ClosedPromise,
        new Promise((r) => setTimeout(r, 500)),
      ]);

      expect(browser1CloseCalled).toBe(true);
      expect(fakeBrowser1.close).toHaveBeenCalled();

      controller.abort();
      await stuckPromise;
    } finally {
      controller.abort();
      await localRenderer.onModuleDestroy();
    }
  });

  it('revalidates generation admission after await: render A close rejects and render B starts immediately -> gen 1 gets 1 context, B runs on gen 2', async () => {
    let launchCount = 0;
    let triggerCloseReject!: () => void;
    const closePromise = new Promise<void>((_, reject) => {
      triggerCloseReject = () =>
        reject(new Error('Forced context close rejection for render A'));
    });

    let renderACloseStartedResolve!: () => void;
    const renderACloseStarted = new Promise<void>((resolve) => {
      renderACloseStartedResolve = resolve;
    });

    const fakeBrowser1: Browser = {
      close: vi.fn(async () => {}),
      on: vi.fn(),
      newContext: vi.fn(async () => ({
        browser: () => fakeBrowser1,
        route: vi.fn(async () => {}),
        newPage: vi.fn(async () => ({
          setContent: vi.fn(async () => {}),
          pdf: vi.fn(async () => Buffer.from('%PDF-1.4 renderA')),
        })),
        close: vi.fn(() => {
          renderACloseStartedResolve();
          return closePromise;
        }),
      })),
    } as unknown as Browser;

    const fakeBrowser2: Browser = {
      close: vi.fn(async () => {}),
      on: vi.fn(),
      newContext: vi.fn(async () => ({
        browser: () => fakeBrowser2,
        route: vi.fn(async () => {}),
        newPage: vi.fn(async () => ({
          setContent: vi.fn(async () => {}),
          pdf: vi.fn(async () => Buffer.from('%PDF-1.4 renderB')),
        })),
        close: vi.fn(async () => {}),
      })),
    } as unknown as Browser;

    const localRenderer = new PlaywrightPdfRenderer({
      renderSettleTimeoutMs: 100,
      browserLauncher: async () => {
        launchCount += 1;
        return launchCount === 1 ? fakeBrowser1 : fakeBrowser2;
      },
    });

    try {
      const promiseA = localRenderer.renderHtmlToPdf('<p>A</p>', {
        timeoutMs: 5_000,
      });
      await renderACloseStarted;

      // Reject render A's context close and immediately start render B before the rejection microtask drains
      triggerCloseReject();
      const promiseB = localRenderer.renderHtmlToPdf('<p>B</p>', {
        timeoutMs: 5_000,
      });

      const [pdfA, pdfB] = await Promise.all([promiseA, promiseB]);

      expect(pdfA.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(pdfB.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(fakeBrowser1.newContext).toHaveBeenCalledTimes(1);
      expect(fakeBrowser2.newContext).toHaveBeenCalledTimes(1);
      expect(launchCount).toBe(2);
    } finally {
      await localRenderer.onModuleDestroy();
    }
  });

  it('(a) destroy while a launch is pending -> destroy stays unsettled until launch resolves and browser is closed', async () => {
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });

    const fakeBrowser: Browser = {
      close: vi.fn(async () => {}),
      on: vi.fn(),
      newContext: vi.fn(async () => ({
        browser: () => fakeBrowser,
        route: vi.fn(async () => {}),
        newPage: vi.fn(async () => ({
          setContent: vi.fn(async () => {}),
          pdf: vi.fn(async () => Buffer.from('%PDF-1.4 test')),
        })),
        close: vi.fn(async () => {}),
      })),
    } as unknown as Browser;

    const rendererLaunchTimeoutMs = 500;
    const renderSettleTimeoutMs = 100;
    const localRenderer = new PlaywrightPdfRenderer({
      renderSettleTimeoutMs,
      rendererLaunchTimeoutMs,
      browserLauncher: async () => {
        await launchGate;
        return fakeBrowser;
      },
    });

    // Start a render to trigger launch; do NOT await it
    const renderPromise = localRenderer
      .renderHtmlToPdf('<p>pending</p>', { timeoutMs: 5_000 })
      .catch(() => {});

    // Allow render to enter getHealthyGeneration and invoke browserLauncher
    await new Promise((r) => setTimeout(r, 10));

    // Initiate destroy while launch is pending — do NOT await render first
    let destroySettled = false;
    const destroyPromise = localRenderer.onModuleDestroy().then(() => {
      destroySettled = true;
    });

    // Wait a tick — destroy must NOT have settled yet because launch is pending
    await new Promise((r) => setTimeout(r, 20));
    expect(destroySettled).toBe(false);

    // Release the launch
    releaseLaunch();

    // Wait for render to reject (closing check in getHealthyGeneration)
    await renderPromise;

    // Wait for destroy to settle
    await destroyPromise;

    expect(destroySettled).toBe(true);
    expect(fakeBrowser.newContext).not.toHaveBeenCalled();
    expect(fakeBrowser.close).toHaveBeenCalledTimes(1);
  });

  it('(b) a browser whose close() never settles -> onModuleDestroy settles within its bound', async () => {
    const fakeBrowser: Browser = {
      close: vi.fn(async () => new Promise<void>(() => {})), // never settles
      on: vi.fn(),
      newContext: vi.fn(async () => ({
        browser: () => fakeBrowser,
        route: vi.fn(async () => {}),
        newPage: vi.fn(async () => ({
          setContent: vi.fn(async () => {}),
          pdf: vi.fn(async () => Buffer.from('%PDF-1.4 test')),
        })),
        close: vi.fn(async () => {}),
      })),
    } as unknown as Browser;

    const renderSettleTimeoutMs = 30;
    const localRenderer = new PlaywrightPdfRenderer({
      renderSettleTimeoutMs,
      browserLauncher: async () => fakeBrowser,
    });

    await localRenderer.renderHtmlToPdf('<p>open</p>', { timeoutMs: 5_000 });

    const start = performance.now();
    const destroyRace = Promise.race([
      localRenderer.onModuleDestroy().then(() => 'settled'),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('hung'), renderSettleTimeoutMs * 4),
      ),
    ]);

    const result = await destroyRace;
    const elapsed = performance.now() - start;

    expect(result).toBe('settled');
    expect(elapsed).toBeGreaterThanOrEqual(renderSettleTimeoutMs - 5);
    expect(elapsed).toBeLessThan(renderSettleTimeoutMs * 3);
  });

  it('(c) no timer remains after destroy', async () => {
    vi.useFakeTimers();
    try {
      let stuckPageResolve!: () => void;
      const stuckPageGate = new Promise<void>((resolve) => {
        stuckPageResolve = resolve;
      });

      const fakeBrowser: Browser = {
        close: vi.fn(async () => {}),
        on: vi.fn(),
        newContext: vi.fn(async () => ({
          browser: () => fakeBrowser,
          route: vi.fn(async () => {}),
          newPage: vi.fn(async () => {
            stuckPageResolve();
            return {
              setContent: vi.fn(async () => {}),
              pdf: vi.fn(async () => new Promise<Buffer>(() => {})),
            };
          }),
          close: vi.fn(async () => {}),
        })),
      } as unknown as Browser;

      const localRenderer = new PlaywrightPdfRenderer({
        renderSettleTimeoutMs: 50,
        pdfRenderTimeoutMs: 100,
        browserLauncher: async () => fakeBrowser,
      });

      const renderPromise = localRenderer
        .renderHtmlToPdf('<p>stuck</p>', { timeoutMs: 5_000 })
        .catch(() => {});

      await stuckPageGate;

      // Destroy while active render / drain timers exist
      const destroyPromise = localRenderer.onModuleDestroy();
      await vi.runAllTimersAsync();
      await destroyPromise;
      await renderPromise;

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('(d) never-settling launcher with timeoutMs: 10 rejects with PdfRenderTimeoutError within tolerance', async () => {
    const localRenderer = new PlaywrightPdfRenderer({
      renderSettleTimeoutMs: 100,
      rendererLaunchTimeoutMs: 50,
      browserLauncher: async () => new Promise<Browser>(() => {}), // never settles
    });

    try {
      const start = performance.now();
      await expect(
        localRenderer.renderHtmlToPdf('<p>hung</p>', { timeoutMs: 10 }),
      ).rejects.toThrow(PdfRenderTimeoutError);
      const elapsed = performance.now() - start;

      // Must settle quickly (within budget + tolerance), not hang until launch timeout
      expect(elapsed).toBeLessThan(200);
    } finally {
      await localRenderer.onModuleDestroy();
    }
  });

  it('(e) abort during launch rejects with DeliveryDeadlineExceededError', async () => {
    const controller = new AbortController();

    const localRenderer = new PlaywrightPdfRenderer({
      renderSettleTimeoutMs: 100,
      rendererLaunchTimeoutMs: 50,
      browserLauncher: async () => new Promise<Browser>(() => {}), // never settles
    });

    try {
      const renderPromise = localRenderer.renderHtmlToPdf('<p>abort</p>', {
        timeoutMs: 5_000,
        signal: controller.signal,
      });

      // Abort after a small delay
      setTimeout(() => controller.abort(), 10);

      await expect(renderPromise).rejects.toThrow(
        DeliveryDeadlineExceededError,
      );
    } finally {
      await localRenderer.onModuleDestroy();
    }
  });

  it('(f) second render while first launch is still pending does not trigger a second launch', async () => {
    let launchCount = 0;
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });

    const fakeBrowser: Browser = {
      close: vi.fn(async () => {}),
      on: vi.fn(),
      newContext: vi.fn(async () => ({
        browser: () => fakeBrowser,
        route: vi.fn(async () => {}),
        newPage: vi.fn(async () => ({
          setContent: vi.fn(async () => {}),
          pdf: vi.fn(async () => Buffer.from('%PDF-1.4 test')),
        })),
        close: vi.fn(async () => {}),
      })),
    } as unknown as Browser;

    const localRenderer = new PlaywrightPdfRenderer({
      renderSettleTimeoutMs: 100,
      rendererLaunchTimeoutMs: 200,
      browserLauncher: async () => {
        launchCount += 1;
        await launchGate;
        return fakeBrowser;
      },
    });

    try {
      const render1 = localRenderer.renderHtmlToPdf('<p>one</p>', {
        timeoutMs: 5_000,
      });
      const render2 = localRenderer.renderHtmlToPdf('<p>two</p>', {
        timeoutMs: 5_000,
      });

      // Both renders are waiting on the same launch
      await new Promise((r) => setTimeout(r, 10));
      expect(launchCount).toBe(1);

      releaseLaunch();
      const [pdf1, pdf2] = await Promise.all([render1, render2]);

      expect(pdf1.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(pdf2.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(launchCount).toBe(1);
    } finally {
      await localRenderer.onModuleDestroy();
    }
  });

  it('(g) launch released after renderSettleTimeoutMs but before rendererLaunchTimeoutMs -> destroy waits for browser close', async () => {
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });

    const fakeBrowser: Browser = {
      close: vi.fn(async () => {}),
      on: vi.fn(),
      newContext: vi.fn(async () => ({
        browser: () => fakeBrowser,
        route: vi.fn(async () => {}),
        newPage: vi.fn(async () => ({
          setContent: vi.fn(async () => {}),
          pdf: vi.fn(async () => Buffer.from('%PDF-1.4 test')),
        })),
        close: vi.fn(async () => {}),
      })),
    } as unknown as Browser;

    const renderSettleTimeoutMs = 20;
    const rendererLaunchTimeoutMs = 200;
    const localRenderer = new PlaywrightPdfRenderer({
      renderSettleTimeoutMs,
      rendererLaunchTimeoutMs,
      browserLauncher: async () => {
        await launchGate;
        return fakeBrowser;
      },
    });

    // Start a render to trigger launch
    const renderPromise = localRenderer.renderHtmlToPdf('<p>g</p>', {
      timeoutMs: 5_000,
    });
    await new Promise((r) => setTimeout(r, 10));

    // Start destroy while launch is pending
    let destroySettled = false;
    const destroyPromise = localRenderer.onModuleDestroy().then(() => {
      destroySettled = true;
    });

    // Wait past renderSettleTimeoutMs but before rendererLaunchTimeoutMs
    await new Promise((r) => setTimeout(r, renderSettleTimeoutMs + 20));

    // Launch not released yet — destroy should not have settled
    expect(destroySettled).toBe(false);

    // Release the launch within rendererLaunchTimeoutMs
    releaseLaunch();
    await expect(renderPromise).rejects.toThrow();
    await destroyPromise;

    // Destroy settles after closing the launched browser
    expect(destroySettled).toBe(true);
    expect(fakeBrowser.close).toHaveBeenCalledTimes(1);
  });

  it('(h) never-settling launch -> onModuleDestroy settles within rendererLaunchTimeoutMs + renderSettleTimeoutMs bound', async () => {
    const rendererLaunchTimeoutMs = 30;
    const renderSettleTimeoutMs = 30;
    const totalBound = rendererLaunchTimeoutMs + renderSettleTimeoutMs;

    const localRenderer = new PlaywrightPdfRenderer({
      renderSettleTimeoutMs,
      rendererLaunchTimeoutMs,
      browserLauncher: async () => new Promise<Browser>(() => {}), // never settles
    });

    // Start a render to trigger the in-flight launch
    const renderPromise = localRenderer
      .renderHtmlToPdf('<p>stuck</p>', { timeoutMs: 5 })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    await renderPromise;

    const start = performance.now();
    const result = await Promise.race([
      localRenderer.onModuleDestroy().then(() => 'settled'),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('hung'), totalBound * 4),
      ),
    ]);
    const elapsed = performance.now() - start;

    expect(result).toBe('settled');
    expect(elapsed).toBeLessThan(totalBound * 3);
  });
});
