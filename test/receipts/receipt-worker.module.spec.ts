import { Test } from '@nestjs/testing';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OCR_ENGINE,
  type OcrEnginePort,
} from '../../src/platform/ocr-engine.port.js';
import * as tesseractAdapter from '../../src/platform/system-tesseract.adapter.js';
import { ReceiptWorkerModule } from '../../src/receipts/receipt-worker.module.js';
import { FakeChildProcess } from '../support/fake-spawner.js';

// Minimal valid TSV so parseTsvTokensInternal returns a usable (if empty) result.
const MINIMAL_TSV = [
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
  '5\t1\t1\t1\t1\t1\t10\t20\t90\t20\t95\tSAMPLE',
].join('\n');

// Node's own `spawn` is mocked at the module boundary so we can observe the
// exact argv SystemTesseractAdapter passes to prlimit, without touching the
// real OS process.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

describe('ReceiptWorkerModule OCR memory limit wiring', () => {
  const originalEnv = { ...process.env };
  const CONFIGURED_MEMORY_LIMIT_BYTES = 2_147_483_648; // 2 GiB, distinct from the 1 GiB default

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('constructs SystemTesseractAdapter with the configured ocrMemoryLimitBytes and passes it to the OCR startup preflight', async () => {
    process.env.DATABASE_URL =
      'postgresql://postgres:postgres@127.0.0.1:5432/test';
    process.env.SAVIA_WORKER_OCR_MEMORY_LIMIT_BYTES = String(
      CONFIGURED_MEMORY_LIMIT_BYTES,
    );

    const preflightSpy = vi
      .spyOn(tesseractAdapter, 'runOcrStartupPreflight')
      .mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      imports: [ReceiptWorkerModule],
    }).compile();
    await moduleRef.init();

    expect(preflightSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryLimitBytes: CONFIGURED_MEMORY_LIMIT_BYTES,
      }),
    );

    const mockSpawn = vi.mocked(spawn);
    mockSpawn.mockImplementation((): ChildProcess => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        child.stdout.write(MINIMAL_TSV);
        child.stdout.end();
        child.simulateClose(0, null);
      });
      return child as unknown as ChildProcess;
    });

    const engine = moduleRef.get<OcrEnginePort>(OCR_ENGINE);
    await engine.recognize(Buffer.from('fake-image-bytes'), {
      timeoutMs: 10_000,
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, spawnArgs] = mockSpawn.mock.calls[0]!;
    expect(spawnArgs).toContain(`--as=${CONFIGURED_MEMORY_LIMIT_BYTES}`);

    await moduleRef.close();
  });
});
