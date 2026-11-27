import { expect, it, vi } from 'vitest';
import {
  NotificationDeliverySweep,
  type NotificationClaim,
} from '../../src/notifications/notification-delivery-sweep.js';

// Reviewer regression for B7 (verify task mwr0ejbt): a worker whose lease was taken over must not submit.
it('does not submit a claim after another worker has taken over its lease', async () => {
  vi.useFakeTimers();
  try {
    const oldClaim = {
      delivery_id: 'same-outbox-row',
      lease_id: 'old-lease',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      attempts: 1,
      recipient: 'recipient@example.test',
      title: 'Report ready',
      body: null,
    } satisfies NotificationClaim & { lease_expires_at: string };
    const heldClaim = Promise.withResolvers<NotificationClaim>();
    const oldClaimStarted = Promise.withResolvers<void>();
    const finish = vi.fn(async () => {});
    const email = { deliver: vi.fn(async () => 'accepted' as const) };
    const former = new NotificationDeliverySweep(
      {
        scheduleDigests: async () => {},
        claim: vi
          .fn<() => Promise<NotificationClaim | undefined>>()
          .mockResolvedValue(undefined)
          .mockImplementationOnce(() => {
            oldClaimStarted.resolve();
            return heldClaim.promise;
          }),
        finish,
      },
      email,
    );
    const formerRun = former.runOnce();
    await oldClaimStarted.promise;
    await vi.advanceTimersByTimeAsync(60_001);
    const reclaimed = {
      ...oldClaim,
      attempts: 2,
      lease_id: 'new-lease',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    await new NotificationDeliverySweep(
      {
        scheduleDigests: async () => {},
        claim: vi
          .fn<() => Promise<NotificationClaim | undefined>>()
          .mockResolvedValue(undefined)
          .mockResolvedValueOnce(reclaimed),
        finish,
      },
      email,
    ).runOnce();
    heldClaim.resolve(oldClaim);
    await formerRun;
    expect(email.deliver).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledExactlyOnceWith(reclaimed, 'accepted', 10);
  } finally {
    vi.useRealTimers();
  }
});
