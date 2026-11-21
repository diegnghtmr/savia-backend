import { expect, it, vi } from 'vitest';
import { JOB_TYPES } from '../../src/jobs/job.port.js';
import { JobRunner } from '../../src/platform/job-runner.js';
import { WorkerConfig } from '../../src/platform/worker-config.js';

it('S5 retains the six existing job types', () => {
  expect(
    JOB_TYPES.filter((t) => String(t) !== 'recurring_materialization'),
  ).toEqual([
    'import_commit',
    'import_rollback',
    'balance_forecast',
    'report_run',
    'export_job',
    'receipt_ocr',
  ]);
});

it('S5 keeps claiming queued user jobs at their configured rate during a slow sweep', async () => {
  vi.useFakeTimers();
  const slow = Promise.withResolvers<number>();
  const queued = {
    msgId: 1,
    readCt: 1,
    message: {
      job_id: '00000000-0000-4000-8000-000000000011',
      workspace_id: '00000000-0000-4000-8000-000000000012',
      actor_id: '00000000-0000-4000-8000-000000000013',
    },
  };
  const claim = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([queued])
    .mockResolvedValue([]);
  const runner = Reflect.construct(JobRunner, [
    { claim },
    {},
    {},
    new WorkerConfig(1, 300, 1000, 30),
    undefined,
    undefined,
    { sweep: () => slow.promise },
  ]) as JobRunner;
  const process = vi.spyOn(runner, 'processMessage').mockResolvedValue(true);
  try {
    await runner.start();
    await vi.advanceTimersByTimeAsync(1000);
    console.log(
      'S5 existing-job poll',
      JSON.stringify({
        claims: claim.mock.calls.length,
        delivered: process.mock.calls.length,
      }),
    );
    expect(process).toHaveBeenCalledExactlyOnceWith(queued, expect.anything());
  } finally {
    slow.resolve(0);
    await vi.advanceTimersByTimeAsync(1);
    await runner.stop();
    vi.useRealTimers();
  }
});

it('keeps sweeps serial and cancels the next sweep on stop', async () => {
  vi.useFakeTimers();
  const slow = Promise.withResolvers<number>();
  const sweep = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue(0);
  const runner = Reflect.construct(JobRunner, [
    { claim: vi.fn().mockResolvedValue([]) },
    {},
    {},
    new WorkerConfig(1, 300, 1000, 30),
    undefined,
    undefined,
    { sweep },
  ]) as JobRunner;
  try {
    await runner.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sweep).toHaveBeenCalledTimes(1);
    slow.resolve(0);
    await vi.advanceTimersByTimeAsync(1001);
    expect(sweep).toHaveBeenCalledTimes(2);
    await runner.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sweep).toHaveBeenCalledTimes(2);
  } finally {
    slow.resolve(0);
    await vi.advanceTimersByTimeAsync(1);
    await runner.stop();
    vi.useRealTimers();
  }
});

it('S5 retries rejected sweeps during a blocked claim and drains on stop', async () => {
  vi.useFakeTimers();
  const claim = Promise.withResolvers<[]>();
  const drain = Promise.withResolvers<number>();
  const sweep = vi
    .fn()
    .mockRejectedValueOnce(new Error('database unavailable'))
    .mockReturnValueOnce(drain.promise)
    .mockResolvedValue(0);
  const runner = Reflect.construct(JobRunner, [
    { claim: () => claim.promise },
    {},
    {},
    new WorkerConfig(1, 300, 1000, 1),
    undefined,
    undefined,
    { sweep },
  ]) as JobRunner;
  try {
    await runner.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(2);
    claim.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    const stopped = runner.stop();
    expect(runner.activeJobsCount).toBe(1);
    drain.resolve(0);
    await vi.advanceTimersByTimeAsync(3050);
    await stopped;
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(runner.activeJobsCount).toBe(0);
  } finally {
    claim.resolve([]);
    drain.resolve(0);
    const stopped = runner.stop();
    await vi.advanceTimersByTimeAsync(1050);
    await stopped;
    vi.useRealTimers();
  }
});
