export class DeliveryDeadlineExceededError extends Error {
  public constructor(
    message = 'Delivery deadline exceeded.',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DeliveryDeadlineExceededError';
  }
}

export interface DeliveryDeadlineOptions {
  readonly visibilityTimeoutSeconds: number;
  readonly leaseSafetyMs: number;
  readonly terminalReserveMs: number;
  readonly minOperationMs: number;
  readonly claimedAt?: number;
  readonly clock?: () => number;
}

export class DeliveryDeadline {
  public readonly expiresAt: number;
  public readonly terminalReserveMs: number;
  public readonly minOperationMs: number;
  private readonly clock: () => number;

  public constructor(options: DeliveryDeadlineOptions) {
    this.terminalReserveMs = options.terminalReserveMs;
    this.minOperationMs = options.minOperationMs;
    this.clock = options.clock ?? (() => performance.now());
    const claimedAt = options.claimedAt ?? this.clock();
    this.expiresAt =
      claimedAt +
      options.visibilityTimeoutSeconds * 1_000 -
      options.leaseSafetyMs;
  }

  public remaining(): number {
    const remainingMs = this.expiresAt - this.clock();
    return remainingMs > 0 ? Math.floor(remainingMs) : 0;
  }

  public forWork(capMs: number): number {
    const available = this.remaining() - this.terminalReserveMs;
    if (available <= 0) return 0;
    return Math.min(capMs, available);
  }

  public forTerminal(capMs: number): number {
    const available = this.remaining();
    if (available <= 0) return 0;
    return Math.min(capMs, available);
  }

  public isWorkExhausted(): boolean {
    return this.forWork(Number.POSITIVE_INFINITY) < this.minOperationMs;
  }

  public isTerminalExhausted(): boolean {
    return this.forTerminal(Number.POSITIVE_INFINITY) < this.minOperationMs;
  }

  public isExhausted(phase: 'work' | 'terminal' = 'work'): boolean {
    return phase === 'work'
      ? this.isWorkExhausted()
      : this.isTerminalExhausted();
  }
}
