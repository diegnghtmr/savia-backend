import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyJobError } from '../../src/platform/job-retry-policy.js';
import {
  OCR_MEMORY_LIMIT_BOUNDS,
  OCR_STREAM_BOUNDS,
  parseOcrMemoryLimitBytes,
  ReceiptOcrEngineFailedError,
  SystemTesseractAdapter,
} from '../../src/platform/system-tesseract.adapter.js';
import {
  FakeChildProcess,
  FakeProcessKiller,
  FakeSpawner,
} from '../support/fake-spawner.js';

// Sample valid TSV output adhering to Tesseract 5.x specification
const SAMPLE_TSV = [
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
  '1\t1\t0\t0\t0\t0\t0\t0\t800\t600\t-1\t',
  '2\t1\t1\t0\t0\t0\t10\t20\t200\t50\t-1\t',
  '3\t1\t1\t1\t0\t0\t10\t20\t200\t50\t-1\t',
  '4\t1\t1\t1\t1\t0\t10\t20\t200\t50\t-1\t',
  '5\t1\t1\t1\t1\t1\t10\t20\t90\t20\t95\tSUPERMERCADO',
  '5\t1\t1\t1\t1\t2\t105\t20\t70\t20\t92\tCENTRAL',
  '4\t1\t1\t1\t2\t0\t10\t50\t150\t20\t-1\t',
  '5\t1\t1\t1\t2\t1\t10\t50\t50\t20\t96\tTOTAL',
  '5\t1\t1\t1\t2\t2\t65\t50\t80\t20\t94\t45000',
].join('\n');

describe('SystemTesseractAdapter', () => {
  let fakeSpawner: FakeSpawner;
  let fakeKiller: FakeProcessKiller;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeSpawner = new FakeSpawner();
    fakeKiller = new FakeProcessKiller();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pins exact production spawn argv (tesseract 5.x manual citation)', async () => {
    fakeSpawner.nextChildHandler = ({ child }) => {
      queueMicrotask(() => {
        child.stdout.write(SAMPLE_TSV);
        child.stdout.end();
        child.simulateClose(0, null);
      });
    };

    const adapter = new SystemTesseractAdapter({
      spawner: fakeSpawner.spawn,
      processKiller: fakeKiller.kill,
      platform: 'linux',
      memoryLimitBytes: 1_073_741_824, // 1 GiB default
    });

    const dummyImage = Buffer.from('fake-image-bytes');
    await adapter.recognize(dummyImage, { timeoutMs: 10_000 });

    expect(fakeSpawner.calls).toHaveLength(1);
    const call = fakeSpawner.calls[0]!;

    expect(call.command).toBe('/usr/bin/prlimit');
    expect(call.args).toEqual([
      '--as=1073741824',
      '--',
      '/usr/bin/tesseract',
      'stdin',
      'stdout',
      '-l',
      'eng+spa',
      '--psm',
      '3',
      '--oem',
      '1',
      'tsv',
    ]);
  });

  it('pins OMP_THREAD_LIMIT=1 in child process environment', async () => {
    fakeSpawner.nextChildHandler = ({ child }) => {
      queueMicrotask(() => {
        child.stdout.write(SAMPLE_TSV);
        child.stdout.end();
        child.simulateClose(0, null);
      });
    };

    const adapter = new SystemTesseractAdapter({
      spawner: fakeSpawner.spawn,
      processKiller: fakeKiller.kill,
      platform: 'linux',
    });

    await adapter.recognize(Buffer.from('test-image'), { timeoutMs: 5_000 });

    const call = fakeSpawner.calls[0]!;
    expect(call.options.env).toBeDefined();
    expect(call.options.env?.OMP_THREAD_LIMIT).toBe('1');
    expect(call.options.shell).toBe(false);
    expect(call.options.detached).toBe(true);
  });

  it('pipes buffer to stdin and parses TSV from stdout with zero disk temp files', async () => {
    const inputBuffer = Buffer.from('uncompressed-image-data-stream');

    fakeSpawner.nextChildHandler = ({ child }) => {
      queueMicrotask(() => {
        child.stdout.write(SAMPLE_TSV);
        child.stdout.end();
        child.simulateClose(0, null);
      });
    };

    const adapter = new SystemTesseractAdapter({
      spawner: fakeSpawner.spawn,
      processKiller: fakeKiller.kill,
      platform: 'linux',
    });

    const result = await adapter.recognize(inputBuffer, { timeoutMs: 5_000 });

    const call = fakeSpawner.calls[0]!;
    expect(call.child.stdinData).toEqual(inputBuffer);
    expect(result.rawTsv).toBe(SAMPLE_TSV);
    expect(result.tokens).toHaveLength(4);
    expect(result.tokens[0]?.text).toBe('SUPERMERCADO');
    expect(result.tokens[1]?.text).toBe('CENTRAL');
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]?.text).toBe('SUPERMERCADO CENTRAL');
    expect(result.lines[1]?.text).toBe('TOTAL 45000');
  });

  it('escalates termination to child process group with negative pid', async () => {
    let capturedChild: FakeChildProcess | undefined;
    fakeSpawner.nextChildHandler = ({ child }) => {
      capturedChild = child;
      // Does not close on its own; ignores initial SIGTERM
    };

    const adapter = new SystemTesseractAdapter({
      spawner: fakeSpawner.spawn,
      processKiller: fakeKiller.kill,
      platform: 'linux',
    });

    const controller = new AbortController();
    const promise = adapter.recognize(Buffer.from('hang-image'), {
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    // Trigger abort
    controller.abort();

    // Verification 1: SIGTERM sent to process group (-child.pid)
    expect(fakeKiller.killed).toEqual([
      { pid: -(capturedChild?.pid ?? 0), signal: 'SIGTERM' },
    ]);

    // Advance timers by 1,000 ms grace window
    await vi.advanceTimersByTimeAsync(1_000);

    // Verification 2: SIGKILL escalated to process group (-child.pid)
    expect(fakeKiller.killed).toEqual([
      { pid: -(capturedChild?.pid ?? 0), signal: 'SIGTERM' },
      { pid: -(capturedChild?.pid ?? 0), signal: 'SIGKILL' },
    ]);

    // Child finally closes after SIGKILL
    capturedChild?.simulateClose(null, 'SIGKILL');

    await expect(promise).rejects.toThrow();
  });

  it('settles returned promise only after close event fires, never on SIGTERM alone', async () => {
    let capturedChild: FakeChildProcess | undefined;
    fakeSpawner.nextChildHandler = ({ child }) => {
      capturedChild = child;
    };

    const adapter = new SystemTesseractAdapter({
      spawner: fakeSpawner.spawn,
      processKiller: fakeKiller.kill,
      platform: 'linux',
    });

    const controller = new AbortController();
    let settled = false;

    const promise = adapter
      .recognize(Buffer.from('data'), {
        timeoutMs: 5_000,
        signal: controller.signal,
      })
      .finally(() => {
        settled = true;
      });

    // Abort triggers SIGTERM
    controller.abort();
    expect(fakeKiller.killed).toHaveLength(1);
    expect(fakeKiller.killed[0]?.signal).toBe('SIGTERM');

    // The promise MUST NOT settle on SIGTERM alone
    await Promise.resolve(); // flush microtasks
    expect(settled).toBe(false);

    // Advance partial grace window (500 ms)
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);

    // Advance past grace window to trigger SIGKILL
    await vi.advanceTimersByTimeAsync(500);
    expect(fakeKiller.killed).toHaveLength(2);
    expect(fakeKiller.killed[1]?.signal).toBe('SIGKILL');

    // Still must NOT settle until 'close' event fires
    await Promise.resolve();
    expect(settled).toBe(false);

    // Simulate OS close event
    capturedChild?.simulateClose(null, 'SIGKILL');

    // Now it must settle
    await expect(promise).rejects.toThrow();
    expect(settled).toBe(true);

    // Ensure no active timers remain
    expect(vi.getTimerCount()).toBe(0);
  });

  it('maps unidentifiable nonzero exit and allocator errors to permanent ReceiptOcrEngineFailedError', async () => {
    // 1. Generic exit code 1
    fakeSpawner.nextChildHandler = ({ child }) => {
      queueMicrotask(() => {
        child.stderr.write('Something failed in native code\n');
        child.stderr.end();
        child.simulateClose(1, null);
      });
    };

    const adapter = new SystemTesseractAdapter({
      spawner: fakeSpawner.spawn,
      processKiller: fakeKiller.kill,
      platform: 'linux',
    });

    let caughtError: unknown;
    try {
      await adapter.recognize(Buffer.from('image'), { timeoutMs: 5_000 });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ReceiptOcrEngineFailedError);
    const engineError = caughtError as ReceiptOcrEngineFailedError;
    expect(engineError.code).toBe('ocr_engine_failed');
    expect(engineError.isDomainError).toBe(true);
    expect(classifyJobError(engineError)).toBe('permanent');

    // 2. Allocator strings in stderr (must remain diagnostic only, mapped to ocr_engine_failed)
    for (const allocStderr of [
      'std::bad_alloc\n',
      'tesseract: cannot allocate memory for pix\n',
      'out of memory in leptonica allocate\n',
    ]) {
      fakeSpawner.nextChildHandler = ({ child }) => {
        queueMicrotask(() => {
          child.stderr.write(allocStderr);
          child.stderr.end();
          child.simulateClose(139, null);
        });
      };

      let allocError: unknown;
      try {
        await adapter.recognize(Buffer.from('image'), { timeoutMs: 5_000 });
      } catch (err) {
        allocError = err;
      }

      expect(allocError).toBeInstanceOf(ReceiptOcrEngineFailedError);
      const typed = allocError as ReceiptOcrEngineFailedError;
      expect(typed.code).toBe('ocr_engine_failed');
      expect(typed.code).not.toBe('ocr_resource_limit');
      expect(classifyJobError(typed)).toBe('permanent');
    }
  });

  it('enforces stdout stream cap of 10 MiB, terminating process group on overrun', async () => {
    let capturedChild: FakeChildProcess | undefined;
    fakeSpawner.nextChildHandler = ({ child }) => {
      capturedChild = child;
      queueMicrotask(() => {
        // Exceed 10 MiB limit
        const chunk = Buffer.alloc(OCR_STREAM_BOUNDS.MAX_STDOUT_BYTES + 1024);
        child.stdout.write(chunk);
        // Simulate close triggered by termination
        child.simulateClose(1, 'SIGTERM');
      });
    };

    const adapter = new SystemTesseractAdapter({
      spawner: fakeSpawner.spawn,
      processKiller: fakeKiller.kill,
      platform: 'linux',
    });

    let error: unknown;
    try {
      await adapter.recognize(Buffer.from('image'), { timeoutMs: 5_000 });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ReceiptOcrEngineFailedError);
    expect((error as ReceiptOcrEngineFailedError).code).toBe(
      'ocr_engine_failed',
    );
    expect(classifyJobError(error)).toBe('permanent');
    // Process group was killed on stream cap overrun
    expect(fakeKiller.killed).toContainEqual({
      pid: -(capturedChild?.pid ?? 0),
      signal: 'SIGTERM',
    });
  });

  it('enforces stderr stream cap of 64 KiB, terminating process group on overrun', async () => {
    let capturedChild: FakeChildProcess | undefined;
    fakeSpawner.nextChildHandler = ({ child }) => {
      capturedChild = child;
      queueMicrotask(() => {
        // Exceed 64 KiB limit
        const chunk = Buffer.alloc(OCR_STREAM_BOUNDS.MAX_STDERR_BYTES + 512);
        child.stderr.write(chunk);
        child.simulateClose(1, 'SIGTERM');
      });
    };

    const adapter = new SystemTesseractAdapter({
      spawner: fakeSpawner.spawn,
      processKiller: fakeKiller.kill,
      platform: 'linux',
    });

    let error: unknown;
    try {
      await adapter.recognize(Buffer.from('image'), { timeoutMs: 5_000 });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ReceiptOcrEngineFailedError);
    expect((error as ReceiptOcrEngineFailedError).code).toBe(
      'ocr_engine_failed',
    );
    expect(classifyJobError(error)).toBe('permanent');
    expect(fakeKiller.killed).toContainEqual({
      pid: -(capturedChild?.pid ?? 0),
      signal: 'SIGTERM',
    });
  });

  it('rejects memory cap below 256 MiB minimum bound (e.g. 64 MiB)', () => {
    const sixtyFourMib = 64 * 1024 * 1024;
    expect(() => parseOcrMemoryLimitBytes(sixtyFourMib)).toThrow(
      /must be between 268435456 \(256 MiB\) and 4294967296 \(4 GiB\)/,
    );

    expect(
      () =>
        new SystemTesseractAdapter({
          memoryLimitBytes: sixtyFourMib,
        }),
    ).toThrow(/must be between 268435456 \(256 MiB\) and 4294967296 \(4 GiB\)/);
  });

  it('accepts memory cap within bounds [256 MiB, 4 GiB] and defaults to 1 GiB', () => {
    expect(parseOcrMemoryLimitBytes(undefined)).toBe(
      OCR_MEMORY_LIMIT_BOUNDS.DEFAULT_BYTES,
    );
    expect(parseOcrMemoryLimitBytes(OCR_MEMORY_LIMIT_BOUNDS.MIN_BYTES)).toBe(
      268_435_456,
    );
    expect(
      parseOcrMemoryLimitBytes(OCR_MEMORY_LIMIT_BOUNDS.DEFAULT_BYTES),
    ).toBe(1_073_741_824);
    expect(parseOcrMemoryLimitBytes(OCR_MEMORY_LIMIT_BOUNDS.MAX_BYTES)).toBe(
      4_294_967_296,
    );

    // Over 4 GiB throws
    expect(() =>
      parseOcrMemoryLimitBytes(OCR_MEMORY_LIMIT_BOUNDS.MAX_BYTES + 1),
    ).toThrow(/must be between/);
  });
});
