import { expect, it, vi } from 'vitest';
import { JobRunner } from '../../src/platform/job-runner.js';
import { WorkerConfig } from '../../src/platform/worker-config.js';

it('S6 keeps ordinary claims on cadence while all three sweeps are in flight', async () => {
  vi.useFakeTimers();
  const blocks = Array.from({ length: 3 }, () =>
    Promise.withResolvers<number>(),
  );
  const sweeps = blocks.map((block, i) => ({
    intervalMs: [1000, 60_000, 300_000][i],
    sweep: vi.fn().mockReturnValue(block.promise),
  }));
  const claim = vi.fn().mockResolvedValue([]);
  const runner = Reflect.construct(JobRunner, [
    { claim },
    {},
    {},
    new WorkerConfig(1, 300, 1000, 1),
    undefined,
    undefined,
    sweeps,
  ]) as JobRunner;
  try {
    await runner.start();
    await vi.advanceTimersByTimeAsync(301_000);
    expect(claim).toHaveBeenCalledTimes(302);
    expect(sweeps.map(({ sweep }) => sweep.mock.calls.length)).toEqual([
      1, 1, 1,
    ]);
    expect(runner.activeJobsCount).toBe(3);
  } finally {
    const stopped = runner.stop();
    blocks.forEach((block) => block.resolve(0));
    await vi.advanceTimersByTimeAsync(50);
    await stopped;
    vi.useRealTimers();
  }
  expect(runner.activeJobsCount).toBe(0);
});
