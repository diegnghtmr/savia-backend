import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { DeliveryDeadlineExceededError } from './delivery-deadline.js';
import type { PdfRenderer, PdfRenderOptions } from './pdf-renderer.port.js';
import { PdfRenderTimeoutError } from './pdf-renderer.port.js';

export { PdfRenderTimeoutError } from './pdf-renderer.port.js';

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
  readonly observer?: RenderPhaseObserver;
  readonly browserLauncher?: () => Promise<Browser>;
  readonly logger?: Logger;
}

@Injectable()
export class PlaywrightPdfRenderer implements PdfRenderer, OnModuleDestroy {
  private currentGeneration: BrowserGeneration | undefined;
  private currentGenerationPromise: Promise<BrowserGeneration> | undefined;
  private readonly activeGenerations = new Set<BrowserGeneration>();
  private generationSequence = 0;
  private closing = false;
  private renderSequence = 0;
  public readonly renderSettleTimeoutMs: number;
  public readonly pdfRenderTimeoutMs: number;
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
      this.observer = observer;
      this.browserLauncher = () => chromium.launch({ headless: true });
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
      this.observer = optionsOrTimeout.observer ?? observer;
      this.browserLauncher =
        optionsOrTimeout.browserLauncher ??
        (() => chromium.launch({ headless: true }));
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
    if (this.currentGenerationPromise) {
      return await this.currentGenerationPromise;
    }
    const genId = ++this.generationSequence;
    let promise: Promise<BrowserGeneration> | undefined;
    promise = (async () => {
      try {
        const browser = await this.browserLauncher();
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
            this.currentGenerationPromise = undefined;
          }
          this.activeGenerations.delete(gen);
        });
        return gen;
      } finally {
        if (this.currentGenerationPromise === promise) {
          this.currentGenerationPromise = undefined;
        }
      }
    })();
    this.currentGenerationPromise = promise;
    return await promise;
  }

  public hasOpenBrowser(): boolean {
    return (
      (this.currentGeneration !== undefined &&
        !this.currentGeneration.unhealthy) ||
      this.currentGenerationPromise !== undefined
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
    this.throwIfBudgetExhausted(options);

    const generation = await this.getHealthyGeneration();
    this.throwIfBudgetExhausted(options);

    generation.activeContexts += 1;
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
    let didReject = false;
    let closeError: unknown;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        didTimeout = true;
        resolve();
      }, this.renderSettleTimeoutMs);
    });
    try {
      await Promise.race([
        context.close().catch((err: unknown) => {
          didReject = true;
          closeError = err;
        }),
        timeoutPromise,
      ]);
      if (didTimeout) {
        this.quarantineGeneration(generation, 'TimeoutError');
      } else if (didReject) {
        const errorClassName =
          (closeError as object)?.constructor?.name || 'Error';
        this.quarantineGeneration(generation, errorClassName);
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
      this.currentGenerationPromise = undefined;
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

  public async onModuleDestroy(): Promise<void> {
    this.closing = true;
    this.currentGeneration = undefined;
    this.currentGenerationPromise = undefined;
    const gens = [...this.activeGenerations];
    this.activeGenerations.clear();
    for (const gen of gens) {
      if (gen.drainTimer !== undefined) {
        clearTimeout(gen.drainTimer);
        gen.drainTimer = undefined;
      }
      try {
        await gen.browser.close();
      } catch {
        // Browser may have already disconnected.
      }
    }
  }
}
