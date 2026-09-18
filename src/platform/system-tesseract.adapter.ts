import { randomUUID } from 'node:crypto';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { DeliveryDeadlineExceededError } from './delivery-deadline.js';
import type {
  OcrEngineLine,
  OcrEngineOptions,
  OcrEnginePort,
  OcrEngineResult,
  OcrEngineToken,
} from './ocr-engine.port.js';

/**
 * Bounds for SAVIA_WORKER_OCR_MEMORY_LIMIT_BYTES.
 * - Minimum: 256 MiB (268,435,456 bytes). 64 MiB is proven to fail dynamic linker initialization.
 * - Default: 1 GiB (1,073,741,824 bytes). Provisional until S5 real peak calibration.
 * - Maximum: 4 GiB (4,294,967,296 bytes).
 */
export const OCR_MEMORY_LIMIT_BOUNDS = {
  MIN_BYTES: 256 * 1024 * 1024, // 268_435_456 bytes (256 MiB)
  DEFAULT_BYTES: 1 * 1024 * 1024 * 1024, // 1_073_741_824 bytes (1 GiB)
  MAX_BYTES: 4 * 1024 * 1024 * 1024, // 4_294_967_296 bytes (4 GiB)
} as const;

/**
 * Stream limit bounds.
 * - stdout: 10 MiB max.
 * - stderr: 64 KiB max.
 */
export const OCR_STREAM_BOUNDS = {
  MAX_STDOUT_BYTES: 10 * 1024 * 1024, // 10 MiB
  MAX_STDERR_BYTES: 64 * 1024, // 64 KiB
} as const;

export const OCR_TIMEOUT_DEFAULTS = {
  GRACE_WINDOW_MS: 1_000, // 1 s grace before SIGKILL escalation
  PREFLIGHT_TIMEOUT_MS: 2_000, // 2 s preflight timeout
} as const;

/**
 * Validates and parses SAVIA_WORKER_OCR_MEMORY_LIMIT_BYTES.
 */
export function parseOcrMemoryLimitBytes(
  value: string | number | undefined,
): number {
  if (
    value === undefined ||
    (typeof value === 'string' && value.trim() === '')
  ) {
    return OCR_MEMORY_LIMIT_BOUNDS.DEFAULT_BYTES;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || Number.isNaN(parsed)) {
    throw new Error(
      `SAVIA_WORKER_OCR_MEMORY_LIMIT_BYTES must be an integer between ${OCR_MEMORY_LIMIT_BOUNDS.MIN_BYTES} (256 MiB) and ${OCR_MEMORY_LIMIT_BOUNDS.MAX_BYTES} (4 GiB).`,
    );
  }

  if (
    parsed < OCR_MEMORY_LIMIT_BOUNDS.MIN_BYTES ||
    parsed > OCR_MEMORY_LIMIT_BOUNDS.MAX_BYTES
  ) {
    throw new Error(
      `SAVIA_WORKER_OCR_MEMORY_LIMIT_BYTES (${parsed} bytes) must be between ${OCR_MEMORY_LIMIT_BOUNDS.MIN_BYTES} (256 MiB) and ${OCR_MEMORY_LIMIT_BOUNDS.MAX_BYTES} (4 GiB).`,
    );
  }

  return parsed;
}

/**
 * Domain error for permanent OCR engine failure.
 * Mapped to PERMANENT classification by classifyJobError via isDomainError = true.
 */
export class ReceiptOcrEngineFailedError extends Error {
  public readonly isDomainError = true;
  public readonly type = 'https://savia.app/problems/receipt-ocr-engine-failed';
  public readonly title = 'Receipt OCR Engine Failed';
  public readonly status = 422;
  public readonly code = 'ocr_engine_failed';
  public readonly traceId: string;
  public readonly detail: string;

  public constructor(
    message: string,
    traceId?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ReceiptOcrEngineFailedError';
    this.traceId = traceId ?? randomUUID();
    this.detail = message;
  }
}

/**
 * Error thrown when an OCR subprocess execution times out.
 * Transient: does not set isDomainError.
 */
export class OcrEngineTimeoutError extends Error {
  public constructor(
    message = 'OCR engine execution timed out.',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'OcrEngineTimeoutError';
  }
}

/**
 * Error thrown when worker startup preflight fails.
 */
export class OcrPreflightError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OcrPreflightError';
  }
}

export type SubprocessSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type ProcessKiller = (pid: number, signal: NodeJS.Signals) => void;

export interface SystemTesseractOptions {
  readonly memoryLimitBytes?: number;
  readonly spawner?: SubprocessSpawner;
  readonly processKiller?: ProcessKiller;
  readonly tesseractPath?: string;
  readonly prlimitPath?: string;
  readonly platform?: NodeJS.Platform;
}

/**
 * Sends a signal to the process group of the target pid (using negative pid).
 */
export function killProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  killer: ProcessKiller = (p, s) => {
    process.kill(p, s);
  },
): void {
  try {
    killer(-pid, signal);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') {
      throw err;
    }
  }
}

/**
 * Internal parser for TSV tokens and lines, ensuring src/platform never imports
 * from feature modules (satisfying platform-to-feature-isolation).
 * Adheres to tesseract(1) TSV specification:
 * Columns: level, page_num, block_num, par_num, line_num, word_num, left, top, width, height, conf, text
 */
export function parseTsvTokensInternal(tsv: string): OcrEngineToken[] {
  if (!tsv || typeof tsv !== 'string') return [];

  const rawLines = tsv.split(/\r?\n/);
  const tokens: OcrEngineToken[] = [];

  for (const rawLine of rawLines) {
    const cols = rawLine.split('\t');
    if (cols.length < 11) continue;

    const level = Number(cols[0]);
    if (level !== 5) continue; // Level 5 is word token

    const text = cols.slice(11).join('\t').trim();
    if (!text) continue;

    const rawConf = Number(cols[10]);
    if (Number.isNaN(rawConf) || rawConf < 0) continue;

    tokens.push({
      level: 5,
      pageNum: Number(cols[1]) || 1,
      blockNum: Number(cols[2]) || 1,
      parNum: Number(cols[3]) || 1,
      lineNum: Number(cols[4]) || 1,
      wordNum: Number(cols[5]) || 1,
      left: Number(cols[6]) || 0,
      top: Number(cols[7]) || 0,
      width: Number(cols[8]) || 0,
      height: Number(cols[9]) || 0,
      confidence: Math.max(0, Math.min(1, rawConf / 100)),
      text,
    });
  }

  return tokens;
}

export function groupTokensIntoLinesInternal(
  tokens: readonly OcrEngineToken[],
): OcrEngineLine[] {
  const lineMap = new Map<string, OcrEngineToken[]>();

  for (const token of tokens) {
    const key = `${token.pageNum}_${token.blockNum}_${token.parNum}_${token.lineNum}`;
    const existing = lineMap.get(key);
    if (existing) {
      existing.push(token);
    } else {
      lineMap.set(key, [token]);
    }
  }

  const lines: OcrEngineLine[] = [];

  for (const lineTokens of lineMap.values()) {
    if (lineTokens.length === 0) continue;

    lineTokens.sort((a, b) => a.left - b.left);
    const first = lineTokens[0]!;
    const text = lineTokens.map((t) => t.text).join(' ');
    const confidence =
      lineTokens.reduce((sum, t) => sum + t.confidence, 0) / lineTokens.length;

    lines.push({
      pageNum: first.pageNum,
      blockNum: first.blockNum,
      parNum: first.parNum,
      lineNum: first.lineNum,
      text,
      confidence,
      tokens: lineTokens,
    });
  }

  lines.sort((a, b) => {
    const aFirst = a.tokens[0];
    const bFirst = b.tokens[0];
    return (aFirst?.top ?? 0) - (bFirst?.top ?? 0);
  });

  return lines;
}

/**
 * Minimal embedded 1x1 PNG image fixture for startup preflight verification.
 * 68 bytes valid PNG header and chunks (IHDR 1x1, IDAT, IEND).
 */
export const EMBEDDED_PREFLIGHT_FIXTURE_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

/**
 * Production implementation of OcrEnginePort utilizing the system tesseract binary
 * bounded by prlimit --as=<bytes> and isolated in its own process group.
 *
 * Manual Citations:
 * - prlimit(1) (util-linux):
 *     --as=<limit>: Address space limit (virtual memory in bytes). Enforces hard cap.
 *     --: Delimits prlimit options from the command and arguments.
 * - tesseract(1) (Tesseract 5.x):
 *     stdin: Reads image from standard input stream (no temp files).
 *     stdout: Writes output to standard output stream (no temp files).
 *     -l eng+spa: Combined English and Spanish LSTM models.
 *     --psm 3: Fully automatic page segmentation without orientation and script detection (OSD).
 *     --oem 1: Neural nets LSTM engine only.
 *     tsv: Standard configfile name producing structured tab-separated values output.
 * - OpenMP specification:
 *     OMP_THREAD_LIMIT=1: Restricts OpenMP thread pool to 1 thread to prevent memory amplification.
 */
export class SystemTesseractAdapter implements OcrEnginePort {
  private readonly memoryLimitBytes: number;
  private readonly spawner: SubprocessSpawner;
  private readonly processKiller: ProcessKiller;
  private readonly tesseractPath: string;
  private readonly prlimitPath: string;
  private readonly platform: NodeJS.Platform;

  public constructor(options?: SystemTesseractOptions) {
    this.memoryLimitBytes = parseOcrMemoryLimitBytes(options?.memoryLimitBytes);
    this.spawner = options?.spawner ?? spawn;
    this.processKiller =
      options?.processKiller ??
      ((p, s) => {
        process.kill(p, s);
      });
    this.tesseractPath = options?.tesseractPath ?? '/usr/bin/tesseract';
    this.prlimitPath = options?.prlimitPath ?? '/usr/bin/prlimit';
    this.platform = options?.platform ?? process.platform;
  }

  public async recognize(
    image: Buffer,
    options: OcrEngineOptions,
  ): Promise<OcrEngineResult> {
    if (options.timeoutMs <= 0 || options.signal?.aborted) {
      throw (
        options.signal?.reason ??
        new DeliveryDeadlineExceededError(
          'OCR execution aborted: budget exhausted before start.',
        )
      );
    }

    if (this.platform !== 'linux') {
      throw new ReceiptOcrEngineFailedError(
        `SystemTesseractAdapter requires Linux with prlimit (detected platform: "${this.platform}").`,
      );
    }

    /**
     * Exact argv pinned per tesseract 5.x manual and prlimit(1) citation:
     * prlimit --as=<bytes> -- /usr/bin/tesseract stdin stdout -l eng+spa --psm 3 --oem 1 tsv
     */
    const spawnCommand = this.prlimitPath;
    const spawnArgs: readonly string[] = [
      `--as=${this.memoryLimitBytes}`,
      '--',
      this.tesseractPath,
      'stdin',
      'stdout',
      '-l',
      'eng+spa',
      '--psm',
      '3',
      '--oem',
      '1',
      'tsv',
    ];

    const spawnOptions: SpawnOptions = {
      shell: false,
      detached: true,
      env: {
        ...process.env,
        OMP_THREAD_LIMIT: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    return await new Promise<OcrEngineResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawner(spawnCommand, spawnArgs, spawnOptions);
      } catch (err) {
        reject(
          new ReceiptOcrEngineFailedError(
            `Failed to spawn OCR process: ${err instanceof Error ? err.message : String(err)}`,
            undefined,
            { cause: err },
          ),
        );
        return;
      }

      let settled = false;
      let closed = false;
      let termSent = false;
      let timedOut = false;
      let aborted = false;

      let timeoutTimer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;
      let abortListener: (() => void) | undefined;

      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let streamCapError: ReceiptOcrEngineFailedError | undefined;

      const cleanupTimersAndListeners = (): void => {
        if (timeoutTimer !== undefined) {
          clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
        if (graceTimer !== undefined) {
          clearTimeout(graceTimer);
          graceTimer = undefined;
        }
        if (abortListener !== undefined && options.signal !== undefined) {
          options.signal.removeEventListener('abort', abortListener);
          abortListener = undefined;
        }
      };

      const terminateChild = (
        initialSignal: NodeJS.Signals = 'SIGTERM',
      ): void => {
        if (closed || child.pid === undefined) return;
        if (!termSent) {
          termSent = true;
          killProcessGroup(child.pid, initialSignal, this.processKiller);

          // Escalate to SIGKILL after grace window if child ignores SIGTERM
          graceTimer = setTimeout(() => {
            if (!closed && child.pid !== undefined) {
              killProcessGroup(child.pid, 'SIGKILL', this.processKiller);
            }
          }, OCR_TIMEOUT_DEFAULTS.GRACE_WINDOW_MS);
        }
      };

      // Set up deadline timeout timer
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminateChild('SIGTERM');
      }, options.timeoutMs);

      // Set up abort signal listener
      if (options.signal !== undefined) {
        abortListener = (): void => {
          aborted = true;
          terminateChild('SIGTERM');
        };
        if (options.signal.aborted) {
          abortListener();
        } else {
          options.signal.addEventListener('abort', abortListener, {
            once: true,
          });
        }
      }

      // Stream image directly into stdin
      if (child.stdin) {
        child.stdin.on('error', () => {
          // Swallow EPIPE if child terminates early
        });
        child.stdin.end(image);
      }

      // Bounded stdout collection
      if (child.stdout) {
        child.stdout.on('data', (chunk: Buffer) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > OCR_STREAM_BOUNDS.MAX_STDOUT_BYTES) {
            if (!streamCapError) {
              streamCapError = new ReceiptOcrEngineFailedError(
                `OCR stdout stream exceeded cap of ${OCR_STREAM_BOUNDS.MAX_STDOUT_BYTES} bytes (10 MiB).`,
              );
              terminateChild('SIGTERM');
            }
            return;
          }
          stdoutChunks.push(chunk);
        });
      }

      // Bounded stderr collection
      if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer) => {
          stderrBytes += chunk.length;
          if (stderrBytes > OCR_STREAM_BOUNDS.MAX_STDERR_BYTES) {
            if (!streamCapError) {
              streamCapError = new ReceiptOcrEngineFailedError(
                `OCR stderr stream exceeded cap of ${OCR_STREAM_BOUNDS.MAX_STDERR_BYTES} bytes (64 KiB).`,
              );
              terminateChild('SIGTERM');
            }
            return;
          }
          stderrChunks.push(chunk);
        });
      }

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        closed = true;
        cleanupTimersAndListeners();
        reject(
          new ReceiptOcrEngineFailedError(
            `OCR subprocess error: ${err.message}`,
            undefined,
            { cause: err },
          ),
        );
      });

      child.on(
        'close',
        (code: number | null, signal: NodeJS.Signals | null) => {
          if (settled) return;
          settled = true;
          closed = true;
          cleanupTimersAndListeners();

          if (streamCapError !== undefined) {
            reject(streamCapError);
            return;
          }

          if (timedOut) {
            reject(
              new OcrEngineTimeoutError(
                `OCR engine execution timed out after ${options.timeoutMs}ms.`,
              ),
            );
            return;
          }

          if (aborted) {
            reject(
              options.signal?.reason ??
                new DeliveryDeadlineExceededError(
                  'OCR execution aborted by delivery deadline.',
                ),
            );
            return;
          }

          const stderrText = Buffer.concat(stderrChunks).toString('utf-8');

          // Check for missing language packs (eng or spa).
          // Tesseract exits 0 with TSV header even when a language fails to load,
          // which would silently degrade recognition to English-only without this check.
          if (
            stderrText.includes('spa.traineddata') ||
            stderrText.includes("Failed loading language 'spa'") ||
            stderrText.includes('eng.traineddata') ||
            stderrText.includes("Failed loading language 'eng'") ||
            stderrText.includes('Could not initialize tesseract')
          ) {
            reject(
              new ReceiptOcrEngineFailedError(
                `OCR engine failed: required language pack missing (eng+spa). Stderr: ${stderrText.slice(0, 1024)}`,
              ),
            );
            return;
          }

          if (code !== 0) {
            // Map all otherwise-unidentifiable nonzero exits (including allocator diagnostics)
            // to generic permanent ReceiptOcrEngineFailedError
            reject(
              new ReceiptOcrEngineFailedError(
                `OCR engine failed with exit code ${code}${signal ? ` (signal: ${signal})` : ''}. Stderr: ${stderrText.slice(0, 1024)}`,
              ),
            );
            return;
          }

          const rawTsv = Buffer.concat(stdoutChunks).toString('utf-8');
          const tokens = parseTsvTokensInternal(rawTsv);
          const lines = groupTokensIntoLinesInternal(tokens);

          resolve({
            lines,
            tokens,
            rawTsv,
          });
        },
      );
    });
  }
}

export interface OcrPreflightOptions {
  readonly memoryLimitBytes?: number;
  readonly spawner?: SubprocessSpawner;
  readonly processKiller?: ProcessKiller;
  readonly tesseractPath?: string;
  readonly prlimitPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
}

/**
 * Startup preflight oracle for the OCR engine.
 * Executes the exact production command path through prlimit with the configured cap,
 * eng+spa languages, --psm 3, --oem 1, stdin, and TSV on a tiny embedded fixture.
 *
 * Fails fast with an actionable OcrPreflightError on:
 * - Non-Linux OS.
 * - Missing prlimit binary.
 * - Missing language packs (eng or spa).
 * - Unusable memory cap (exit code 127 from dynamic loader).
 * - Non-zero exit code or malformed/empty TSV output.
 *
 * Manual citations:
 * - prlimit(1): --as=<bytes> -- COMMAND
 * - tesseract(1): stdin stdout -l eng+spa --psm 3 --oem 1 tsv
 * - OpenMP: OMP_THREAD_LIMIT=1
 */
export async function runOcrStartupPreflight(
  options?: OcrPreflightOptions,
): Promise<void> {
  const platform = options?.platform ?? process.platform;
  if (platform !== 'linux') {
    throw new OcrPreflightError(
      `OCR startup preflight failed: unsupported operating system "${platform}". Linux with prlimit is required.`,
    );
  }

  const memoryLimitBytes = parseOcrMemoryLimitBytes(options?.memoryLimitBytes);
  const spawner = options?.spawner ?? spawn;
  const tesseractPath = options?.tesseractPath ?? '/usr/bin/tesseract';
  const prlimitPath = options?.prlimitPath ?? '/usr/bin/prlimit';
  const timeoutMs =
    options?.timeoutMs ?? OCR_TIMEOUT_DEFAULTS.PREFLIGHT_TIMEOUT_MS;
  const processKiller =
    options?.processKiller ??
    ((p, s) => {
      process.kill(p, s);
    });

  const spawnArgs: readonly string[] = [
    `--as=${memoryLimitBytes}`,
    '--',
    tesseractPath,
    'stdin',
    'stdout',
    '-l',
    'eng+spa',
    '--psm',
    '3',
    '--oem',
    '1',
    'tsv',
  ];

  const spawnOptions: SpawnOptions = {
    shell: false,
    detached: true,
    env: {
      ...process.env,
      OMP_THREAD_LIMIT: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  };

  return await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawner(prlimitPath, spawnArgs, spawnOptions);
    } catch (err: unknown) {
      reject(
        new OcrPreflightError(
          `OCR startup preflight failed: failed to spawn prlimit: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        ),
      );
      return;
    }

    let settled = false;
    let closed = false;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let terminated = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let streamCapError: OcrPreflightError | undefined;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
    };

    const terminateChild = (sig: NodeJS.Signals): void => {
      if (!child.pid || terminated) return;
      terminated = true;
      killProcessGroup(child.pid, sig, processKiller);

      // Schedule SIGKILL escalation after grace window
      graceTimer = setTimeout(() => {
        if (!closed && child.pid) {
          killProcessGroup(child.pid, 'SIGKILL', processKiller);
        }
      }, OCR_TIMEOUT_DEFAULTS.GRACE_WINDOW_MS);
    };

    timer = setTimeout(() => {
      if (!closed && child.pid !== undefined) {
        killProcessGroup(child.pid, 'SIGKILL', processKiller);
      }
    }, timeoutMs);

    if (child.stdin) {
      child.stdin.on('error', () => {
        // Swallow EPIPE on early child termination
      });
      child.stdin.end(EMBEDDED_PREFLIGHT_FIXTURE_PNG);
    }

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > OCR_STREAM_BOUNDS.MAX_STDOUT_BYTES) {
          if (!streamCapError) {
            streamCapError = new OcrPreflightError(
              `OCR startup preflight failed: stdout stream exceeded cap of ${OCR_STREAM_BOUNDS.MAX_STDOUT_BYTES} bytes (10 MiB).`,
            );
            terminateChild('SIGTERM');
          }
          return;
        }
        stdoutChunks.push(chunk);
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > OCR_STREAM_BOUNDS.MAX_STDERR_BYTES) {
          if (!streamCapError) {
            streamCapError = new OcrPreflightError(
              `OCR startup preflight failed: stderr stream exceeded cap of ${OCR_STREAM_BOUNDS.MAX_STDERR_BYTES} bytes (64 KiB).`,
            );
            terminateChild('SIGTERM');
          }
          return;
        }
        stderrChunks.push(chunk);
      });
    }

    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      closed = true;
      cleanup();
      const errCode = (err as NodeJS.ErrnoException).code;
      if (errCode === 'ENOENT' || err.message.includes('ENOENT')) {
        reject(
          new OcrPreflightError(
            `OCR startup preflight failed: prlimit binary not found at ${prlimitPath}.`,
            { cause: err },
          ),
        );
        return;
      }
      reject(
        new OcrPreflightError(`OCR startup preflight failed: ${err.message}`, {
          cause: err,
        }),
      );
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      closed = true;
      cleanup();

      if (streamCapError !== undefined) {
        reject(streamCapError);
        return;
      }

      const stderrText = Buffer.concat(stderrChunks).toString('utf-8');

      // Check for missing languages
      if (
        stderrText.includes('spa.traineddata') ||
        stderrText.includes("Failed loading language 'spa'") ||
        stderrText.includes('eng.traineddata') ||
        stderrText.includes("Failed loading language 'eng'") ||
        stderrText.includes('Could not initialize tesseract')
      ) {
        reject(
          new OcrPreflightError(
            `OCR startup preflight failed: required language pack missing (eng+spa). Stderr: ${stderrText.trim()}`,
          ),
        );
        return;
      }

      // Check for dynamic loader / memory cap failure (exit code 127)
      if (
        code === 127 ||
        stderrText.includes('failed to map segment from shared object') ||
        stderrText.includes('error while loading shared libraries')
      ) {
        reject(
          new OcrPreflightError(
            `OCR startup preflight failed: unusable memory limit cap (exit code 127). Stderr: ${stderrText.trim()}`,
          ),
        );
        return;
      }

      if (code !== 0) {
        reject(
          new OcrPreflightError(
            `OCR startup preflight failed with exit code ${code}${signal ? ` (signal: ${signal})` : ''}. Stderr: ${stderrText.trim()}`,
          ),
        );
        return;
      }

      const stdoutText = Buffer.concat(stdoutChunks).toString('utf-8').trim();
      if (!stdoutText || !stdoutText.includes('level\t')) {
        reject(
          new OcrPreflightError(
            `OCR startup preflight failed: unexpected empty TSV output.`,
          ),
        );
        return;
      }

      resolve();
    });
  });
}
