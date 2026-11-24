import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NotificationDeliverySweep,
  type NotificationClaim,
} from '../../src/notifications/notification-delivery-sweep.js';

const claim = {
  delivery_id: 'stable-id',
  lease_id: 'lease-1',
  lease_expires_at: '9999-12-31T00:00:00.000Z',
  attempts: 1,
  recipient: 'recipient@example.test',
  title: 'Savia weekly digest',
  body: '2 notifications',
} satisfies NotificationClaim;

function fixtures() {
  const store = {
    scheduleDigests: vi.fn(async () => {}),
    claim: vi
      .fn<(configured: boolean) => Promise<NotificationClaim | undefined>>()
      .mockResolvedValue(undefined),
    finish: vi.fn(async () => {}),
  };
  const email = { deliver: vi.fn(async () => 'retryable' as const) };
  return { store, email };
}

afterEach(() => vi.useRealTimers());

describe('notification delivery sweep', () => {
  it('persists retry outcomes with exponential delays and stable provider idempotency', async () => {
    const { store, email } = fixtures();
    const retry = { ...claim, attempts: 2, lease_id: 'lease-2' };
    store.claim
      .mockResolvedValueOnce(claim)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(retry);
    const sweep = new NotificationDeliverySweep(store, email);
    await sweep.runOnce();
    await sweep.runOnce();
    const payload = {
      to: claim.recipient,
      title: claim.title,
      body: claim.body,
      idempotencyKey: claim.delivery_id,
    };
    expect(email.deliver.mock.calls).toEqual([[payload], [payload]]);
    expect(store.finish.mock.calls).toEqual([
      [claim, 'retryable', 5],
      [retry, 'retryable', 10],
    ]);
    expect(store.claim.mock.calls.every(([configured]) => configured)).toBe(
      true,
    );
  });

  it('sweeps without email configured so tokenless pushes do not stay pending', async () => {
    const { store } = fixtures();
    await new NotificationDeliverySweep(store).runOnce();
    expect(store.scheduleDigests).toHaveBeenCalledTimes(1);
    expect(store.claim).toHaveBeenCalledExactlyOnceWith(false);
    expect(store.finish).not.toHaveBeenCalled();
  });

  it('starts one independent poll, never overlaps an active send, and settles it on shutdown', async () => {
    vi.useFakeTimers();
    const { store } = fixtures();
    const { promise, resolve } = Promise.withResolvers<'accepted'>();
    const email = { deliver: vi.fn(() => promise) };
    store.claim.mockResolvedValueOnce(claim);
    const sweep = new NotificationDeliverySweep(store, email);
    sweep.start();
    sweep.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.claim).toHaveBeenCalledTimes(1);
    expect(email.deliver).toHaveBeenCalledTimes(1);
    expect(store.finish).not.toHaveBeenCalled();
    const shutdown = sweep.beforeApplicationShutdown();
    resolve('accepted');
    await shutdown;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.finish).toHaveBeenCalledExactlyOnceWith(claim, 'accepted', 5);
    expect(store.claim).toHaveBeenCalledTimes(1);
  });
});
