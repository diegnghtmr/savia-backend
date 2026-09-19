export interface SemaphorePermit {
  release(): void;
}

export class AsyncSemaphore {
  private available: number;
  private readonly queue: Array<{
    resolve: (permit: SemaphorePermit) => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  public constructor(public readonly capacity: number) {
    if (capacity < 1 || !Number.isInteger(capacity)) {
      throw new Error(
        `Semaphore capacity must be a positive integer, got ${capacity}`,
      );
    }
    this.available = capacity;
  }

  public get availablePermits(): number {
    return this.available;
  }

  public get waitingCount(): number {
    return this.queue.length;
  }

  public async acquire(signal?: AbortSignal): Promise<SemaphorePermit> {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Aborted');
    }

    if (this.available > 0) {
      this.available--;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          this.releaseOne();
        },
      };
    }

    return new Promise<SemaphorePermit>((resolve, reject) => {
      const waiter: {
        resolve: (permit: SemaphorePermit) => void;
        reject: (error: unknown) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve, reject, signal };

      if (signal) {
        const onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) {
            this.queue.splice(index, 1);
          }
          reject(signal.reason ?? new Error('Aborted'));
        };
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.queue.push(waiter);
    });
  }

  private releaseOne(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      if (next.signal?.aborted) {
        // Waiter was already aborted while in queue, continue to next waiter
        continue;
      }
      let released = false;
      next.resolve({
        release: () => {
          if (released) return;
          released = true;
          this.releaseOne();
        },
      });
      return;
    }
    this.available++;
  }
}
