import { DeliveryDeadlineExceededError } from '../../src/platform/delivery-deadline.js';
import type {
  PdfRenderer,
  PdfRenderOptions,
} from '../../src/platform/pdf-renderer.port.js';

/**
 * In-memory test double for PdfRenderer.
 * Returns a minimal valid PDF header by default.
 */
export class FakePdfRenderer implements PdfRenderer {
  public calls: Array<{ html: string; options: PdfRenderOptions }> = [];
  public result: Buffer = Buffer.from('%PDF-1.4 fake');
  public error: Error | undefined;
  public hang: boolean = false;

  public async renderHtmlToPdf(
    html: string,
    options: PdfRenderOptions,
  ): Promise<Buffer> {
    this.calls.push({ html, options });
    if (options.timeoutMs <= 0 || options.signal?.aborted) {
      throw new DeliveryDeadlineExceededError(
        'PDF render aborted: budget exhausted before start.',
      );
    }
    if (this.error) {
      throw this.error;
    }
    if (this.hang) {
      return new Promise<Buffer>(() => undefined);
    }
    return this.result;
  }

  public reset(): void {
    this.calls = [];
    this.result = Buffer.from('%PDF-1.4 fake');
    this.error = undefined;
    this.hang = false;
  }
}
