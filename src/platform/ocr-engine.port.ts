export const OCR_ENGINE = Symbol('OCR_ENGINE');

export interface OcrEngineOptions {
  /** Hard timeout for the OCR engine execution in milliseconds. */
  readonly timeoutMs: number;
  /** AbortSignal from the delivery deadline. */
  readonly signal?: AbortSignal;
}

export interface OcrEngineToken {
  readonly level: number;
  readonly pageNum: number;
  readonly blockNum: number;
  readonly parNum: number;
  readonly lineNum: number;
  readonly wordNum: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** Normalized confidence score in the range [0, 1]. */
  readonly confidence: number;
  readonly text: string;
}

export interface OcrEngineLine {
  readonly pageNum: number;
  readonly blockNum: number;
  readonly parNum: number;
  readonly lineNum: number;
  readonly text: string;
  /** Normalized confidence score in the range [0, 1]. */
  readonly confidence: number;
  readonly tokens: readonly OcrEngineToken[];
}

export interface OcrEngineResult {
  readonly lines: readonly OcrEngineLine[];
  readonly tokens: readonly OcrEngineToken[];
  readonly rawTsv: string;
}

export interface OcrEnginePort {
  /**
   * Recognizes text from an image buffer and returns structured lines, tokens, and raw TSV.
   * Implementations must enforce timeoutMs and respect the abort signal.
   */
  recognize(image: Buffer, options: OcrEngineOptions): Promise<OcrEngineResult>;
}
