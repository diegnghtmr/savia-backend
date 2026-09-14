import { describe, expect, it } from 'vitest';
import {
  DeliveryDeadline,
  DeliveryDeadlineExceededError,
} from '../../src/platform/delivery-deadline.js';

describe('DeliveryDeadline', () => {
  function createFakeClock(initialTime = 10_000) {
    let now = initialTime;
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('calculates expiresAt and remaining time from claimedAt, visibilityTimeout, and leaseSafetyMs', () => {
    const clock = createFakeClock(10_000);
    const deadline = new DeliveryDeadline({
      visibilityTimeoutSeconds: 300,
      leaseSafetyMs: 20_000,
      terminalReserveMs: 10_000,
      minOperationMs: 1_000,
      clock: clock.now,
    });

    // claimedAt = 10_000
    // expiresAt = 10_000 + 300_000 - 20_000 = 290_000
    // remaining = 290_000 - 10_000 = 280_000
    expect(deadline.expiresAt).toBe(290_000);
    expect(deadline.remaining()).toBe(280_000);

    clock.advance(50_000);
    expect(deadline.remaining()).toBe(230_000);
  });

  it('remaining never returns a negative number after expiresAt', () => {
    const clock = createFakeClock(0);
    const deadline = new DeliveryDeadline({
      visibilityTimeoutSeconds: 10,
      leaseSafetyMs: 2_000,
      terminalReserveMs: 1_000,
      minOperationMs: 500,
      clock: clock.now,
    });

    // expiresAt = 0 + 10_000 - 2_000 = 8_000
    clock.advance(8_001);
    expect(deadline.remaining()).toBe(0);

    clock.advance(10_000);
    expect(deadline.remaining()).toBe(0);
  });

  it('forWork caps at min(capMs, remaining - terminalReserveMs) and is never negative', () => {
    const clock = createFakeClock(0);
    const deadline = new DeliveryDeadline({
      visibilityTimeoutSeconds: 60,
      leaseSafetyMs: 10_000,
      terminalReserveMs: 5_000,
      minOperationMs: 1_000,
      clock: clock.now,
    });

    // expiresAt = 50_000, remaining = 50_000
    // remaining - terminalReserveMs = 45_000
    // with cap 20_000 -> 20_000
    expect(deadline.forWork(20_000)).toBe(20_000);
    // with cap 100_000 -> 45_000
    expect(deadline.forWork(100_000)).toBe(45_000);

    // Advance clock to within terminalReserveMs of expiresAt
    clock.advance(46_000); // remaining = 4_000 < terminalReserveMs (5_000)
    expect(deadline.forWork(10_000)).toBe(0);
  });

  it('forTerminal caps at min(capMs, remaining) and is never negative', () => {
    const clock = createFakeClock(0);
    const deadline = new DeliveryDeadline({
      visibilityTimeoutSeconds: 60,
      leaseSafetyMs: 10_000,
      terminalReserveMs: 5_000,
      minOperationMs: 1_000,
      clock: clock.now,
    });

    // expiresAt = 50_000, remaining = 50_000
    expect(deadline.forTerminal(10_000)).toBe(10_000);
    expect(deadline.forTerminal(100_000)).toBe(50_000);

    clock.advance(48_000); // remaining = 2_000
    expect(deadline.forTerminal(10_000)).toBe(2_000);

    clock.advance(3_000); // past expiresAt
    expect(deadline.forTerminal(10_000)).toBe(0);
  });

  it('detects exhaustion when available time is below minOperationMs', () => {
    const clock = createFakeClock(0);
    const deadline = new DeliveryDeadline({
      visibilityTimeoutSeconds: 60,
      leaseSafetyMs: 10_000,
      terminalReserveMs: 5_000,
      minOperationMs: 1_000,
      clock: clock.now,
    });

    // expiresAt = 50_000, remaining = 50_000
    expect(deadline.isWorkExhausted()).toBe(false);
    expect(deadline.isTerminalExhausted()).toBe(false);
    expect(deadline.isExhausted('work')).toBe(false);
    expect(deadline.isExhausted('terminal')).toBe(false);

    // Advance so remaining = 5_500.
    // remaining - terminalReserveMs = 500 < minOperationMs (1_000) -> work is exhausted
    clock.advance(44_500);
    expect(deadline.isWorkExhausted()).toBe(true);
    expect(deadline.isExhausted('work')).toBe(true);
    expect(deadline.isExhausted()).toBe(true);
    // But terminal has 5_500 >= 1_000 -> not exhausted
    expect(deadline.isTerminalExhausted()).toBe(false);
    expect(deadline.isExhausted('terminal')).toBe(false);

    // Advance so remaining = 500 < minOperationMs -> terminal also exhausted
    clock.advance(5_000);
    expect(deadline.isWorkExhausted()).toBe(true);
    expect(deadline.isTerminalExhausted()).toBe(true);
    expect(deadline.isExhausted('terminal')).toBe(true);
  });

  it('provides a typed DeliveryDeadlineExceededError', () => {
    const error = new DeliveryDeadlineExceededError('Deadline exceeded');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DeliveryDeadlineExceededError');
    expect(error.message).toBe('Deadline exceeded');
  });
});
