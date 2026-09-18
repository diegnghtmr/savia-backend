import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMBEDDED_PREFLIGHT_FIXTURE_PNG,
  OcrPreflightError,
  runOcrStartupPreflight,
} from '../../src/platform/system-tesseract.adapter.js';
import { FakeProcessKiller, FakeSpawner } from '../support/fake-spawner.js';

const VALID_PREFLIGHT_TSV =
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n1\t1\t0\t0\t0\t0\t0\t0\t1\t1\t-1\t\n';

describe('runOcrStartupPreflight', () => {
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

  it('succeeds when prlimit, tesseract, eng, and spa are available with valid cap', async () => {
    fakeSpawner.nextChildHandler = ({ child }) => {
      queueMicrotask(() => {
        child.stdout.write(VALID_PREFLIGHT_TSV);
        child.stdout.end();
        child.simulateClose(0, null);
      });
    };

    await expect(
      runOcrStartupPreflight({
        spawner: fakeSpawner.spawn,
        processKiller: fakeKiller.kill,
        platform: 'linux',
        memoryLimitBytes: 1_073_741_824,
      }),
    ).resolves.toBeUndefined();

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
    expect(call.options.env?.OMP_THREAD_LIMIT).toBe('1');
    expect(call.child.stdinData).toEqual(EMBEDDED_PREFLIGHT_FIXTURE_PNG);
  });

  it('fails fast on non-Linux operating system', async () => {
    for (const nonLinuxPlatform of ['darwin', 'win32', 'freebsd'] as const) {
      await expect(
        runOcrStartupPreflight({
          spawner: fakeSpawner.spawn,
          processKiller: fakeKiller.kill,
          platform: nonLinuxPlatform,
        }),
      ).rejects.toThrow(OcrPreflightError);

      await expect(
        runOcrStartupPreflight({
          spawner: fakeSpawner.spawn,
          processKiller: fakeKiller.kill,
          platform: nonLinuxPlatform,
        }),
      ).rejects.toThrow(/unsupported operating system/i);
    }

    // No subprocess was spawned on non-Linux
    expect(fakeSpawner.calls).toHaveLength(0);
  });

  it('fails fast when prlimit binary is missing (ENOENT)', async () => {
    fakeSpawner.nextChildHandler = ({ child }) => {
      queueMicrotask(() => {
        const err = Object.assign(new Error('spawn /usr/bin/prlimit ENOENT'), {
          code: 'ENOENT',
        });
        child.simulateError(err);
      });
    };

    await expect(
      runOcrStartupPreflight({
        spawner: fakeSpawner.spawn,
        processKiller: fakeKiller.kill,
        platform: 'linux',
      }),
    ).rejects.toThrow(OcrPreflightError);

    fakeSpawner.reset();
    fakeSpawner.nextChildHandler = ({ child }) => {
      queueMicrotask(() => {
        const err = Object.assign(new Error('spawn /usr/bin/prlimit ENOENT'), {
          code: 'ENOENT',
        });
        child.simulateError(err);
      });
    };

    await expect(
      runOcrStartupPreflight({
        spawner: fakeSpawner.spawn,
        processKiller: fakeKiller.kill,
        platform: 'linux',
      }),
    ).rejects.toThrow(/prlimit binary not found/i);
  });

  it('fails fast when spa language pack is missing from tesseract', async () => {
    fakeSpawner.nextChildHandler = ({ child }) => {
      queueMicrotask(() => {
        child.stderr.write(
          "Error opening data file /usr/share/tessdata/spa.traineddata\nPlease make sure the TESSDATA_PREFIX environment variable is set to your \"tessdata\" directory.\nFailed loading language 'spa'\nTesseract couldn't load any languages!\nCould not initialize tesseract.\n",
        );
        child.stderr.end();
        child.simulateClose(1, null);
      });
    };

    let caughtError: unknown;
    try {
      await runOcrStartupPreflight({
        spawner: fakeSpawner.spawn,
        processKiller: fakeKiller.kill,
        platform: 'linux',
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(OcrPreflightError);
    expect((caughtError as OcrPreflightError).message).toMatch(
      /required language pack missing \(eng\+spa\)/i,
    );
  });

  it('fails fast when eng language pack is missing from tesseract', async () => {
    fakeSpawner.nextChildHandler = ({ child }) => {
      queueMicrotask(() => {
        child.stderr.write(
          "Error opening data file /usr/share/tessdata/eng.traineddata\nFailed loading language 'eng'\n",
        );
        child.stderr.end();
        child.simulateClose(1, null);
      });
    };

    await expect(
      runOcrStartupPreflight({
        spawner: fakeSpawner.spawn,
        processKiller: fakeKiller.kill,
        platform: 'linux',
      }),
    ).rejects.toThrow(OcrPreflightError);
  });

  it('fails fast when configured memory cap is unusable by dynamic loader (exit code 127)', async () => {
    fakeSpawner.nextChildHandler = ({ child }) => {
      queueMicrotask(() => {
        child.stderr.write(
          'tesseract: error while loading shared libraries: libicudata.so.78: failed to map segment from shared object\n',
        );
        child.stderr.end();
        child.simulateClose(127, null);
      });
    };

    let caughtError: unknown;
    try {
      await runOcrStartupPreflight({
        spawner: fakeSpawner.spawn,
        processKiller: fakeKiller.kill,
        platform: 'linux',
        memoryLimitBytes: 268_435_456,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(OcrPreflightError);
    expect((caughtError as OcrPreflightError).message).toMatch(
      /unusable memory limit cap \(exit code 127\)/i,
    );
  });

  it('fails fast when preflight produces empty or malformed TSV output', async () => {
    fakeSpawner.nextChildHandler = ({ child }) => {
      queueMicrotask(() => {
        child.stdout.write('   \n');
        child.stdout.end();
        child.simulateClose(0, null);
      });
    };

    await expect(
      runOcrStartupPreflight({
        spawner: fakeSpawner.spawn,
        processKiller: fakeKiller.kill,
        platform: 'linux',
      }),
    ).rejects.toThrow(OcrPreflightError);
  });
});
