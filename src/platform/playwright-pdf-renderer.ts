import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { DeliveryDeadlineExceededError } from './delivery-deadline.js';
import {
  PdfRenderTimeoutError,
  type PdfRenderer,
  type PdfRenderOptions,
} from './pdf-renderer.port.js';

export { PdfRenderTimeoutError } from './pdf-renderer.port.js';

@Injectable()
export class PlaywrightPdfRenderer implements PdfRenderer, OnModuleDestroy {
  private browserPromise: Promise<Browser> | undefined;
  private closing = false;
  public lastAbortedRequestCount = 0;

  private launchBrowser(): Promise<Browser> {
    const promise = chromium.launch({ headless: true });
    void promise.then(
      (browser) => {
        browser.on('disconnected', () => {
          if (!this.closing && this.browserPromise === promise) {
            this.browserPromise = undefined;
          }
        });
      },
      () => {
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

  public async renderHtmlToPdf(
    html: string,
    options: PdfRenderOptions,
  ): Promise<Buffer> {
    this.lastAbortedRequestCount = 0;
    this.throwIfBudgetExhausted(options);

    const browser = await this.getBrowser();
    this.throwIfBudgetExhausted(options);

    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({ javaScriptEnabled: false });
      await context.route('**/*', (route) => {
        this.lastAbortedRequestCount += 1;
        return route.abort();
      });
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      const pdfBuffer = await this.pdfWithBudget(page, options);
      return Buffer.from(pdfBuffer);
    } finally {
      if (context !== undefined) {
        await context.close().catch(() => undefined);
      }
    }
  }

  private throwIfBudgetExhausted(options: PdfRenderOptions): void {
    if (options.timeoutMs <= 0 || options.signal?.aborted) {
      throw new DeliveryDeadlineExceededError(
        'PDF render aborted: budget exhausted before start.',
      );
    }
  }

  private async pdfWithBudget(
    page: Page,
    options: PdfRenderOptions,
  ): Promise<Uint8Array> {
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

    try {
      return await new Promise<Uint8Array>((resolve, reject) => {
        const settle = (error: unknown, value?: Uint8Array): void => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          if (error !== undefined) {
            reject(error);
            return;
          }
          if (value === undefined) {
            reject(new PdfRenderTimeoutError('PDF render produced no bytes.'));
            return;
          }
          resolve(value);
        };

        timer = setTimeout(() => {
          settle(new PdfRenderTimeoutError());
        }, options.timeoutMs);

        if (options.signal !== undefined) {
          abortListener = (): void => {
            settle(
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

        void page
          .pdf({
            format: 'A4',
            printBackground: true,
          })
          .then(
            (buffer) => {
              settle(undefined, buffer);
            },
            (error: unknown) => {
              const message =
                error instanceof Error ? error.message : String(error);
              if (/timeout/i.test(message)) {
                settle(new PdfRenderTimeoutError(undefined, { cause: error }));
                return;
              }
              settle(error);
            },
          );
      });
    } finally {
      cleanup();
    }
  }

  public async onModuleDestroy(): Promise<void> {
    this.closing = true;
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
