import { Logger } from '@nestjs/common';
import type { FxProvider } from './fx-provider.port.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface FrankfurterPair extends Record<string, unknown> {
  readonly workspace_id: string;
  readonly base_currency: string;
  readonly quote_currency: string;
}

export interface FrankfurterPublication extends FrankfurterPair {
  readonly effective_on: string;
  readonly rate: string;
}

export interface FrankfurterRateStore {
  listPairs(): Promise<readonly FrankfurterPair[]>;
  append(rates: readonly FrankfurterPublication[]): Promise<void>;
}

export class FrankfurterRateJob {
  private readonly logger = new Logger(FrankfurterRateJob.name);
  private controller?: AbortController;
  private pollTimer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;

  public constructor(
    private readonly provider: FxProvider,
    private readonly store: FrankfurterRateStore,
  ) {}

  public start(): void {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    const poll = () => {
      const startedAt = performance.now();
      this.inFlight = this.runOnce(controller.signal)
        .catch(() => {
          if (!controller.signal.aborted)
            this.logger.warn('Frankfurter ingestion failed.');
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            this.pollTimer = setTimeout(
              poll,
              DAY_MS - (performance.now() - startedAt),
            ).unref();
          }
        });
    };
    poll();
  }

  public async stop(): Promise<void> {
    const controller = this.controller;
    if (!controller) return;
    controller.abort();
    clearTimeout(this.pollTimer);
    await this.inFlight;
    if (this.controller === controller) this.controller = undefined;
  }

  public async runOnce(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const byBase = new Map<string, FrankfurterPair[]>();
    for (const pair of await this.store.listPairs()) {
      const pairs = byBase.get(pair.base_currency) ?? [];
      pairs.push(pair);
      byBase.set(pair.base_currency, pairs);
    }

    const batch: FrankfurterPublication[] = [];
    for (const [base, pairs] of byBase) {
      signal?.throwIfAborted();
      const snapshot = await this.provider.latest(
        base,
        pairs.map((pair) => pair.quote_currency),
        signal,
      );
      if (!snapshot) continue;
      for (const pair of pairs) {
        const rate = snapshot.rates[pair.quote_currency];
        if (rate !== undefined)
          batch.push({
            ...pair,
            rate,
            effective_on: snapshot.effectiveAt.slice(0, 10),
          });
      }
    }
    // Prepare every provider response before the one atomic DB write.
    signal?.throwIfAborted();
    if (batch.length > 0) await this.store.append(batch);
  }
}
