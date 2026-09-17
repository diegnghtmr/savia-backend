export const PDF_RENDERER = Symbol('PDF_RENDERER');

export interface PdfRenderOptions {
  /** Hard timeout for the page.pdf() call in milliseconds. */
  readonly timeoutMs: number;
  /** AbortSignal from the delivery deadline. */
  readonly signal?: AbortSignal;
}

/**
 * Thrown only when the renderer’s own hard timeout elapses.
 * classifyJobError treats this as transient (no isDomainError).
 * Abort/exhausted budget throws DeliveryDeadlineExceededError instead.
 */
export class PdfRenderTimeoutError extends Error {
  public constructor(
    message = 'PDF render timed out.',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PdfRenderTimeoutError';
  }
}

export interface PdfRenderer {
  /**
   * Renders an HTML string to a PDF buffer.
   * Implementations must enforce the timeout and respect the abort signal.
   */
  renderHtmlToPdf(html: string, options: PdfRenderOptions): Promise<Buffer>;
}
