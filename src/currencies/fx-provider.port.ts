export interface FxSnapshot {
  readonly baseCurrency: string;
  /** Provider publication date as an ISO UTC timestamp. */
  readonly effectiveAt: string;
  /** Exact decimal strings keyed by supported quote currency. */
  readonly rates: Readonly<Record<string, string>>;
}

export interface FxProvider {
  /** Returns undefined for unsupported pairs; provider failures reject. */
  latest(
    baseCurrency: string,
    quoteCurrencies: readonly string[],
  ): Promise<FxSnapshot | undefined>;
}

const FX_FRESHNESS_MS = 72 * 60 * 60 * 1_000;

export function isFxRateStale(effectiveAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(effectiveAt) >= FX_FRESHNESS_MS;
}
