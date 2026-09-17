import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { DeliveryDeadlineExceededError } from './delivery-deadline.js';
import type { PdfRenderer, PdfRenderOptions } from './pdf-renderer.port.js';
import { PdfRenderTimeoutError } from './pdf-renderer.port.js';

export { PdfRenderTimeoutError } from './pdf-renderer.port.js';

export class PdfRenderAdmissionError extends Error {
  public constructor(
    message = 'Failed to acquire a healthy browser generation for PDF rendering.',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PdfRenderAdmissionError';
  }
}

export const MAX_ADMISSION_RETRIES = 5;

export const CONTEXT_CLOSE_CAP_MS = 2_000;

export const RENDER_PHASES = {
  SET_CONTENT_STARTED: 'set_content_started',
  SET_CONTENT_SETTLED: 'set_content_settled',
  PDF_STARTED: 'pdf_started',
  CONTEXT_CLOSED: 'context_closed',
  REQUEST_ABORTED: 'request_aborted',
} as const;

export type RenderPhase = (typeof RENDER_PHASES)[keyof typeof RENDER_PHASES];

export interface RenderObserverEvent {
  readonly invocationId: string;
  readonly phase: RenderPhase;
  readonly correlationId?: string;
}

export type RenderPhaseObserver = (event: RenderObserverEvent) => void;

interface BrowserGeneration {
  readonly id: number;
  readonly browser: Browser;
  activeContexts: number;
  unhealthy: boolean;
  drainTimer?: NodeJS.Timeout;
  closed?: boolean;
}

export interface PlaywrightPdfRendererOptions {
  readonly renderSettleTimeoutMs: number;
  readonly pdfRenderTimeoutMs?: number;
  readonly rendererLaunchTimeoutMs?: number;
  readonly observer?: RenderPhaseObserver;
  readonly browserLauncher?: () => Promise<Browser>;
  readonly logger?: Logger;
}

@Injectable()
export class PlaywrightPdfRenderer implements PdfRenderer, OnModuleDestroy {
  private currentGeneration: BrowserGeneration | undefined;
  private inFlightLaunchPromise: Promise<BrowserGeneration> | undefined;
  private readonly activeGenerations = new Set<BrowserGeneration>();
  private generationSequence = 0;
  private closing = false;
  private renderSequence = 0;
  public readonly renderSettleTimeoutMs: number;
  public readonly pdfRenderTimeoutMs: number;
  public readonly rendererLaunchTimeoutMs: number;
  private readonly observer?: RenderPhaseObserver;
  private readonly browserLauncher: () => Promise<Browser>;
  private readonly logger: Logger;

  public constructor(
    optionsOrTimeout: number | PlaywrightPdfRendererOptions,
    observer?: RenderPhaseObserver,
  ) {
    if (typeof optionsOrTimeout === 'number') {
      this.renderSettleTimeoutMs = optionsOrTimeout;
      this.pdfRenderTimeoutMs = 30_000;
      this.rendererLaunchTimeoutMs = 10_000;
      this.observer = observer;
      this.browserLauncher = () =>
        chromium.launch({
          headless: true,
          timeout: this.rendererLaunchTimeoutMs,
        });
      this.logger = new Logger(PlaywrightPdfRenderer.name);
    } else {
      if (
        optionsOrTimeout == null ||
        typeof optionsOrTimeout.renderSettleTimeoutMs !== 'number'
      ) {
        throw new TypeError(
          'renderSettleTimeoutMs is a required constructor input.',
        );
      }
      this.renderSettleTimeoutMs = optionsOrTimeout.renderSettleTimeoutMs;
      this.pdfRenderTimeoutMs = optionsOrTimeout.pdfRenderTimeoutMs ?? 30_000;
      this.rendererLaunchTimeoutMs =
        optionsOrTimeout.rendererLaunchTimeoutMs ?? 10_000;
      this.observer = optionsOrTimeout.observer ?? observer;
      this.browserLauncher =
        optionsOrTimeout.browserLauncher ??
        (() =>
          chromium.launch({
            headless: true,
            timeout: this.rendererLaunchTimeoutMs,
          }));
      this.logger =
        optionsOrTimeout.logger ?? new Logger(PlaywrightPdfRenderer.name);
    }
  }

  private async getHealthyGeneration(): Promise<BrowserGeneration> {
    if (this.closing) {
      throw new DeliveryDeadlineExceededError('Renderer is closing.');
    }
    if (this.currentGeneration && !this.currentGeneration.unhealthy) {
      return this.currentGeneration;
    }
    if (this.inFlightLaunchPromise) {
      return await this.inFlightLaunchPromise;
    }
    const genId = ++this.generationSequence;
    const promise = (async () => {
      const browser = await this.browserLauncher();
      if (this.closing) {
        await this.closeBrowserBounded(browser, genId);
        throw new DeliveryDeadlineExceededError('Renderer is closing.');
      }
      const gen: BrowserGeneration = {
        id: genId,
        browser,
        activeContexts: 0,
        unhealthy: false,
      };
      this.activeGenerations.add(gen);
      this.currentGeneration = gen;
      browser.on('disconnected', () => {
        if (this.currentGeneration === gen) {
          this.currentGeneration = undefined;
        }
        this.activeGenerations.delete(gen);
      });
      return gen;
    })();
    this.inFlightLaunchPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.inFlightLaunchPromise === promise) {
        this.inFlightLaunchPromise = undefined;
      }
    }
  }

  /**
   * Races getHealthyGeneration() against the caller's remaining budget and
   * abort signal. The shared launch keeps running for lifecycle cleanup;
   * only the caller's wait is cancelled on timeout or abort.
   */
  private async raceAcquisition(
    remainingMs: number,
    signal?: AbortSignal,
  ): Promise<BrowserGeneration> {
    let timer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const TIMEOUT_SENTINEL = Symbol('acquisitionTimeout');
    const ABORT_SENTINEL = Symbol('acquisitionAbort');

    try {
      const result = await Promise.race([
        this.getHealthyGeneration(),
        new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
          timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), remainingMs);
        }),
        ...(signal
          ? [
              new Promise<typeof ABORT_SENTINEL>((resolve) => {
                if (signal.aborted) {
                  resolve(ABORT_SENTINEL);
                  return;
                }
                abortHandler = () => resolve(ABORT_SENTINEL);
                signal.addEventListener('abort', abortHandler, { once: true });
              }),
            ]
          : []),
      ]);

      if (result === TIMEOUT_SENTINEL) {
        throw new PdfRenderTimeoutError();
      }
      if (result === ABORT_SENTINEL) {
        throw new DeliveryDeadlineExceededError(
          'PDF render aborted: budget exhausted before start.',
        );
      }
      return result;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (abortHandler !== undefined && signal !== undefined) {
        signal.removeEventListener('abort', abortHandler);
      }
    }
  }

  public hasOpenBrowser(): boolean {
    if (this.closing) {
      return false;
    }
    return (
      (this.currentGeneration !== undefined &&
        !this.currentGeneration.unhealthy) ||
      this.inFlightLaunchPromise !== undefined
    );
  }

  public openContextCount(): number {
    let count = 0;
    for (const gen of this.activeGenerations) {
      try {
        count += gen.browser.contexts().length;
      } catch {
        // Browser may be closed.
      }
    }
    return count;
  }

  private notifyObserver(
    invocationId: string,
    phase: RenderPhase,
    correlationId?: string,
  ): void {
    if (!this.observer) {
      return;
    }
    try {
      this.observer({ invocationId, phase, correlationId });
    } catch (err: unknown) {
      const errorClassName = (err as object)?.constructor?.name || 'Error';
      this.logger.warn(
        `Render observer failed at phase ${phase}: ${errorClassName}`,
      );
    }
  }

  public async renderHtmlToPdf(
    html: string,
    options: PdfRenderOptions,
  ): Promise<Buffer> {
    const invocationId = `render-${++this.renderSequence}`;
    const correlationId = options.correlationId ?? options.renderId;
    const startMs = performance.now();
    this.throwIfBudgetExhausted(options);

    let generation: BrowserGeneration;
    let attempts = 0;
    while (true) {
      if (this.closing) {
        throw new DeliveryDeadlineExceededError('Renderer is closing.');
      }

      const remainingMs = options.timeoutMs - (performance.now() - startMs);
      if (remainingMs <= 0) {
        throw new PdfRenderTimeoutError();
      }
      if (options.signal?.aborted) {
        throw new DeliveryDeadlineExceededError(
          'PDF render aborted: budget exhausted before start.',
        );
      }

      generation = await this.raceAcquisition(remainingMs, options.signal);

      if (this.closing) {
        throw new DeliveryDeadlineExceededError('Renderer is closing.');
      }

      // In the same synchronous step (no await between check and increment):
      if (!generation.unhealthy && generation === this.currentGeneration) {
        generation.activeContexts += 1;
        break;
      }

      attempts += 1;
      if (options.signal?.aborted) {
        throw new DeliveryDeadlineExceededError(
          'PDF render aborted: budget exhausted before start.',
        );
      }
      if (performance.now() - startMs >= options.timeoutMs) {
        throw new PdfRenderTimeoutError();
      }
      if (attempts >= MAX_ADMISSION_RETRIES) {
        throw new PdfRenderAdmissionError(
          `Failed to acquire a healthy browser generation after ${attempts} attempts.`,
        );
      }
    }

    if (this.closing) {
      this.decrementActiveContexts(generation);
      throw new DeliveryDeadlineExceededError('Renderer is closing.');
    }

    let context: BrowserContext;
    try {
      context = await generation.browser.newContext({
        javaScriptEnabled: false,
      });
    } catch (error) {
      this.decrementActiveContexts(generation);
      throw error;
    }

    return await this.renderInContext(
      context,
      generation,
      html,
      options,
      invocationId,
      correlationId,
    );
  }

  private throwIfBudgetExhausted(options: PdfRenderOptions): void {
    if (options.timeoutMs <= 0 || options.signal?.aborted) {
      throw new DeliveryDeadlineExceededError(
        'PDF render aborted: budget exhausted before start.',
      );
    }
  }

  private async closeContextBounded(
    context: BrowserContext,
    generation: BrowserGeneration,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let didTimeout = false;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        didTimeout = true;
        resolve();
      }, this.renderSettleTimeoutMs);
    });
    try {
      await Promise.race([
        context.close().catch((err: unknown) => {
          const errorClassName = (err as object)?.constructor?.name || 'Error';
          this.quarantineGeneration(generation, errorClassName);
        }),
        timeoutPromise,
      ]);
      if (didTimeout) {
        this.quarantineGeneration(generation, 'TimeoutError');
      }
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private quarantineGeneration(
    generation: BrowserGeneration,
    errorClassName: string,
  ): void {
    generation.unhealthy = true;
    this.logger.warn(
      `Quarantining browser generation ${generation.id}: ${errorClassName}`,
    );

    if (this.currentGeneration === generation) {
      this.currentGeneration = undefined;
    }

    if (generation.activeContexts === 0) {
      this.triggerGenerationClose(generation);
      return;
    }

    if (generation.drainTimer === undefined && !generation.closed) {
      const drainCapMs = this.pdfRenderTimeoutMs + this.renderSettleTimeoutMs;
      generation.drainTimer = setTimeout(() => {
        this.triggerGenerationClose(generation);
      }, drainCapMs);
    }
  }

  private triggerGenerationClose(generation: BrowserGeneration): void {
    if (generation.closed) {
      return;
    }
    generation.closed = true;
    if (generation.drainTimer !== undefined) {
      clearTimeout(generation.drainTimer);
      generation.drainTimer = undefined;
    }
    void this.closeBrowserBounded(generation.browser, generation.id);
  }

  private decrementActiveContexts(generation: BrowserGeneration): void {
    generation.activeContexts = Math.max(0, generation.activeContexts - 1);
    if (generation.unhealthy && generation.activeContexts === 0) {
      this.triggerGenerationClose(generation);
    }
  }

  private async closeBrowserBounded(
    browser: Browser,
    generationId: number,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.renderSettleTimeoutMs);
    });
    try {
      await Promise.race([
        browser.close().catch((err: unknown) => {
          const errorClassName = (err as object)?.constructor?.name || 'Error';
          this.logger.warn(
            `Quarantined browser generation ${generationId} close rejected: ${errorClassName}`,
          );
        }),
        timeoutPromise,
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      for (const gen of this.activeGenerations) {
        if (gen.id === generationId) {
          this.activeGenerations.delete(gen);
          break;
        }
      }
    }
  }

  private async renderInContext(
    context: BrowserContext,
    generation: BrowserGeneration,
    html: string,
    options: PdfRenderOptions,
    invocationId: string,
    correlationId?: string,
  ): Promise<Buffer> {
    let closed = false;
    const closeOnce = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        await this.closeContextBounded(context, generation);
      } finally {
        this.decrementActiveContexts(generation);
        this.notifyObserver(
          invocationId,
          RENDER_PHASES.CONTEXT_CLOSED,
          correlationId,
        );
      }
    };

    try {
      if (options.signal?.aborted || options.timeoutMs <= 0) {
        await closeOnce();
        throw new DeliveryDeadlineExceededError(
          'PDF render aborted: budget exhausted before start.',
        );
      }

      await context.route('**/*', (route) => {
        this.notifyObserver(
          invocationId,
          RENDER_PHASES.REQUEST_ABORTED,
          correlationId,
        );
        return route.abort();
      });

      const page = await context.newPage();

      return await this.runRacedRender(
        page,
        html,
        options,
        closeOnce,
        invocationId,
        correlationId,
      );
    } catch (error) {
      await closeOnce();
      throw error;
    }
  }

  private async runRacedRender(
    page: Page,
    html: string,
    options: PdfRenderOptions,
    closeOnce: () => Promise<void>,
    invocationId: string,
    correlationId?: string,
  ): Promise<Buffer> {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (abortListener !== undefined && options.signal !== undefined) {
        options.signal.removeEventListener('abort', abortListener);
        abortListener = undefined;
      }
    };

    return await new Promise<Buffer>((resolve, reject) => {
      const handleSettle = async (
        error: unknown,
        result?: Buffer,
      ): Promise<void> => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        try {
          await closeOnce();
        } catch {
          // closeOnce handles errors internally
        }
        if (error !== undefined) {
          reject(error);
        } else if (result !== undefined) {
          resolve(result);
        } else {
          reject(new PdfRenderTimeoutError('PDF render produced no bytes.'));
        }
      };

      timer = setTimeout(() => {
        void handleSettle(new PdfRenderTimeoutError());
      }, options.timeoutMs);

      if (options.signal !== undefined) {
        abortListener = (): void => {
          void handleSettle(
            new DeliveryDeadlineExceededError(
              'PDF render aborted by delivery deadline.',
            ),
          );
        };
        if (options.signal.aborted) {
          abortListener();
          return;
        }
        options.signal.addEventListener('abort', abortListener, {
          once: true,
        });
      }

      void (async () => {
        try {
          this.notifyObserver(
            invocationId,
            RENDER_PHASES.SET_CONTENT_STARTED,
            correlationId,
          );
          await page.setContent(html, { waitUntil: 'domcontentloaded' });
          if (settled) return;
          this.notifyObserver(
            invocationId,
            RENDER_PHASES.SET_CONTENT_SETTLED,
            correlationId,
          );
          this.notifyObserver(
            invocationId,
            RENDER_PHASES.PDF_STARTED,
            correlationId,
          );
          const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
          });
          if (settled) return;
          await handleSettle(undefined, Buffer.from(pdfBuffer));
        } catch (error: unknown) {
          if (settled) return;
          const message =
            error instanceof Error ? error.message : String(error);
          if (/timeout/i.test(message)) {
            await handleSettle(
              new PdfRenderTimeoutError(undefined, { cause: error }),
            );
            return;
          }
          await handleSettle(error);
        }
      })();
    });
  }

  /**
   * Shuts down the renderer: aborts further renders, clears all drain timers,
   * waits boundedly (up to rendererLaunchTimeoutMs) for any in-flight browser
   * launch, then closes every browser — including one that launch produced —
   * through closeBrowserBounded (up to renderSettleTimeoutMs).
   *
   * Total shutdown time is bounded by at most
   * rendererLaunchTimeoutMs + renderSettleTimeoutMs.
   */
  public async onModuleDestroy(): Promise<void> {
    this.closing = true;
    this.currentGeneration = undefined;

    for (const gen of this.activeGenerations) {
      if (gen.drainTimer !== undefined) {
        clearTimeout(gen.drainTimer);
        gen.drainTimer = undefined;
      }
    }

    if (this.inFlightLaunchPromise !== undefined) {
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.rendererLaunchTimeoutMs);
      });
      try {
        await Promise.race([
          this.inFlightLaunchPromise.catch(() => {}),
          timeoutPromise,
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    }

    const gens = [...this.activeGenerations];
    this.activeGenerations.clear();
    await Promise.all(
      gens.map((gen) => this.closeBrowserBounded(gen.browser, gen.id)),
    );
  }
}
