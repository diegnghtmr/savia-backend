import { DeliveryDeadlineExceededError } from '../../src/platform/delivery-deadline.js';
import type {
  OcrEnginePort,
  OcrEngineOptions,
  OcrEngineResult,
} from '../../src/platform/ocr-engine.port.js';

/**
 * In-memory test double for OcrEnginePort.
 * Production code carries no test doubles and no test-only state.
 */
export class FakeOcrEngine implements OcrEnginePort {
  public calls: Array<{ image: Buffer; options: OcrEngineOptions }> = [];
  public result: OcrEngineResult = {
    lines: [],
    tokens: [],
    rawTsv: '',
  };
  public error: Error | undefined;
  public hang: boolean = false;

  public async recognize(
    image: Buffer,
    options: OcrEngineOptions,
  ): Promise<OcrEngineResult> {
    this.calls.push({ image, options });
    if (options.timeoutMs <= 0 || options.signal?.aborted) {
      throw new DeliveryDeadlineExceededError(
        'OCR execution aborted: budget exhausted before start.',
      );
    }
    if (this.error) {
      throw this.error;
    }
    if (this.hang) {
      return new Promise<OcrEngineResult>(() => undefined);
    }
    return this.result;
  }

  public reset(): void {
    this.calls = [];
    this.result = {
      lines: [],
      tokens: [],
      rawTsv: '',
    };
    this.error = undefined;
    this.hang = false;
  }
}
