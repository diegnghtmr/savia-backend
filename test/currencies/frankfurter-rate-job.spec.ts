import { expect, it, vi } from 'vitest';
import { FrankfurterRateJob } from '../../src/currencies/frankfurter-rate-job.js';

it('runs immediately, polls once per day without overlap, and stops polling on shutdown', async () => {
  vi.useFakeTimers();
  const day = 24 * 60 * 60 * 1_000;
  let finish = () => {};
  const first = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const job = new FrankfurterRateJob(
    { latest: vi.fn() },
    { listPairs: vi.fn(), append: vi.fn() },
  );
  const runOnce = vi
    .spyOn(job, 'runOnce')
    .mockReturnValueOnce(first)
    .mockResolvedValue(undefined);
  try {
    job.start();
    job.start();
    expect(runOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(runOnce).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(day - 3_001);
    expect(runOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runOnce).toHaveBeenCalledTimes(2);
    await job.stop();
    expect(runOnce.mock.calls[1][0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(day);
    expect(runOnce).toHaveBeenCalledTimes(2);
  } finally {
    finish();
    await job.stop();
    vi.useRealTimers();
  }
});
