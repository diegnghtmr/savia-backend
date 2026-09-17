import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { DeliveryDeadlineExceededError } from './delivery-deadline.js';
import {
  PdfRenderTimeoutError,
  type PdfRenderer,
  type PdfRenderOptions,
} from './pdf-renderer.port.js';

export { PdfRenderTimeoutError } from './pdf-renderer.port.js';

export const CONTEXT_CLOSE_CAP_MS = 2_000;

export const RENDER_PHASES = {
  SET_CONTENT_STARTED: 'set_content_started',
  SET_CONTENT_SETTLED: 'set_content_settled',
  PDF_STARTED: 'pdf_started',
  CONTEXT_CLOSED: 'context_closed',
} as const;

export type RenderPhase = (typeof RENDER_PHASES)[keyof typeof RENDER_PHASES];

export type RenderPhaseObserver = (
  renderId: string,
  phase: RenderPhase,
) => void;

export interface PlaywrightPdfRendererOptions {
  readonly renderSettleTimeoutMs?: number;
  readonly observer?: RenderPhaseObserver;
  readonly browserLauncher?: () => Promise<Browser>;
  readonly logger?: Logger;
}

@Injectable()
export class PlaywrightPdfRenderer implements PdfRenderer, OnModuleDestroy {
  private browserPromise: Promise<Browser> | undefined;
  private browser: Browser | undefined;
  private closing = false;
  private renderSequence = 0;
  public lastAbortedRequestCount = 0;
  private readonly renderSettleTimeoutMs: number;
  private readonly observer?: RenderPhaseObserver;
  private readonly browserLauncher: () => Promise<Browser>;
  private readonly logger: Logger;

  public constructor(
    optionsOrTimeout?: number | PlaywrightPdfRendererOptions,
    observer?: RenderPhaseObserver,
  ) {
    if (typeof optionsOrTimeout === 'number') {
      this.renderSettleTimeoutMs = optionsOrTimeout;
      this.observer = observer;
      this.browserLauncher = () => chromium.launch({ headless: true });
      this.logger = new Logger(PlaywrightPdfRenderer.name);
    } else {
      this.renderSettleTimeoutMs =
        optionsOrTimeout?.renderSettleTimeoutMs ?? 2_000;
      this.observer = optionsOrTimeout?.observer ?? observer;
      this.browserLauncher =
        optionsOrTimeout?.browserLauncher ??
        (() => chromium.launch({ headless: true }));
      this.logger =
        optionsOrTimeout?.logger ?? new Logger(PlaywrightPdfRenderer.name);
    }
  }

  private launchBrowser(): Promise<Browser> {
    const promise = this.browserLauncher();
    void promise.then(
      (browser) => {
        this.browser = browser;
        browser.on('disconnected', () => {
          this.browser = undefined;
          if (!this.closing && this.browserPromise === promise) {
            this.browserPromise = undefined;
          }
        });
      },
      () => {
        this.browser = undefined;
        if (this.browserPromise === promise) {
          this.browserPromise = undefined;
        }
      },
    );
    return promise;
  }

  private getBrowser(): Promise<Browser> {
    if (this.browserPromise === undefined) {
      this.browserPromise = this.launchBrowser();
    }
    return this.browserPromise;
  }

  public hasOpenBrowser(): boolean {
    return this.browserPromise !== undefined;
  }

  public openContextCount(): number {
    return this.browser ? this.browser.contexts().length : 0;
  }

  public async renderHtmlToPdf(
    html: string,
    options: PdfRenderOptions,
  ): Promise<Buffer> {
    const renderId = options.renderId ?? `render-${++this.renderSequence}`;
    this.lastAbortedRequestCount = 0;
    this.throwIfBudgetExhausted(options);

    const browser = await this.getBrowser();
    this.throwIfBudgetExhausted(options);

    const context = await browser.newContext({ javaScriptEnabled: false });
    return await this.renderInContext(context, html, options, renderId);
  }

  private throwIfBudgetExhausted(options: PdfRenderOptions): void {
    if (options.timeoutMs <= 0 || options.signal?.aborted) {
      throw new DeliveryDeadlineExceededError(
        'PDF render aborted: budget exhausted before start.',
      );
    }
  }

  private async closeContextBounded(context: BrowserContext): Promise<void> {
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
        this.quarantineBrowser(
          context,
          `Browser context close exceeded ${String(this.renderSettleTimeoutMs)}ms cap.`,
        );
      } else if (didReject) {
        const message =
          closeError instanceof Error ? closeError.message : String(closeError);
        this.quarantineBrowser(
          context,
          `Browser context close rejected: ${message}`,
        );
      }
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private quarantineBrowser(context: BrowserContext, reason: string): void {
    const contextBrowser =
      typeof context.browser === 'function' ? context.browser() : null;
    const oldBrowser = contextBrowser ?? this.browser;
    this.browser = undefined;
    this.browserPromise = undefined;
    this.logger.warn(`Quarantining browser: ${reason}`);
    if (oldBrowser != null) {
      void this.closeBrowserBounded(oldBrowser);
    }
  }

  private async closeBrowserBounded(browser: Browser): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.renderSettleTimeoutMs);
    });
    try {
      await Promise.race([
        browser.close().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Quarantined browser close rejected: ${message}`);
        }),
        timeoutPromise,
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private async renderInContext(
    context: BrowserContext,
    html: string,
    options: PdfRenderOptions,
    renderId: string,
  ): Promise<Buffer> {
    let closed = false;
    const closeOnce = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        await this.closeContextBounded(context);
      } finally {
        this.observer?.(renderId, RENDER_PHASES.CONTEXT_CLOSED);
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
        this.lastAbortedRequestCount += 1;
        return route.abort();
      });

      const page = await context.newPage();

      return await this.runRacedRender(
        page,
        html,
        options,
        closeOnce,
        renderId,
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
    renderId: string,
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
          this.observer?.(renderId, RENDER_PHASES.SET_CONTENT_STARTED);
          await page.setContent(html, { waitUntil: 'domcontentloaded' });
          if (settled) return;
          this.observer?.(renderId, RENDER_PHASES.SET_CONTENT_SETTLED);
          this.observer?.(renderId, RENDER_PHASES.PDF_STARTED);
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
    this.browser = undefined;
    if (this.browserPromise !== undefined) {
      const promise = this.browserPromise;
      this.browserPromise = undefined;
      try {
        const browser = await promise;
        await browser.close();
      } catch {
        // Browser may have already disconnected.
      }
    }
  }
}
