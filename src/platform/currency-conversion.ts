export function fxFreshnessSql(valuation: string): string {
  return `case
    when source = 'manual' then 'fresh'
    when source <> 'frankfurter' or not isfinite(effective_at) or effective_at > ${valuation} then 'unknown'
    when effective_at <= ${valuation} - interval '72 hours' then 'stale'
    else 'fresh'
  end`;
}

function currencyRateSelectionSql(
  historical: boolean,
  provenance = false,
): string {
  return `
select rate::text as rate,
       to_char(effective_at at time zone 'utc', 'YYYY-MM-DD') as "rateDate",
       source as "rateSource"${provenance ? `,\n       ${fxFreshnessSql('coalesce($4::timestamptz, now())')} as freshness` : ''}
  from public.exchange_rates
 where workspace_id = $1::uuid
   and base_currency = $2
   and quote_currency = $3
   -- FR-FX-007/008: provider rates expire after 72 hours; manual rates never do.
   and not (source = 'frankfurter'
            and effective_at <= coalesce($4::timestamptz, now()) - interval '72 hours')${historical ? '\n   and effective_at <= $4::timestamptz' : ''}
 order by (effective_at <= coalesce($4::timestamptz, now())) desc,
          case
            when effective_at <= coalesce($4::timestamptz, now()) then effective_at
          end desc,
          effective_at asc,
          id desc
 limit 1`;
}

export const CURRENCY_RATE_SELECTION_SQL = currencyRateSelectionSql(false);
export const ANALYTICS_CURRENCY_RATE_SELECTION_SQL = currencyRateSelectionSql(
  false,
  true,
);
export const HISTORICAL_CURRENCY_RATE_SELECTION_SQL = currencyRateSelectionSql(
  true,
  true,
);

export interface FxRateUsed {
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly rate: string;
  readonly rateDate: string;
  readonly source: string;
  readonly freshness: 'fresh' | 'stale' | 'unknown';
}

export interface SelectedFxRate
  extends Pick<FxRateUsed, 'rate' | 'rateDate' | 'freshness'> {
  readonly rateSource: string;
}

export function describeFxRate(
  baseCurrency: string,
  quoteCurrency: string,
  selected: SelectedFxRate,
): FxRateUsed {
  return {
    baseCurrency,
    quoteCurrency,
    rate: selected.rate,
    rateDate: selected.rateDate,
    source: selected.rateSource,
    freshness: selected.freshness,
  };
}

export class FxUsage {
  private readonly rates = new Map<string, FxRateUsed>();

  public add(rate: FxRateUsed | undefined): void {
    if (!rate) return;
    const key = JSON.stringify([
      rate.baseCurrency,
      rate.quoteCurrency,
      rate.rateDate,
      rate.rate,
      rate.source,
      rate.freshness,
    ]);
    this.rates.set(key, rate);
  }

  public include(usage: FxUsage): void {
    for (const [key, rate] of usage.rates) this.rates.set(key, rate);
  }

  public fields(): { readonly fxRatesUsed?: readonly FxRateUsed[] } {
    if (!this.rates.size) return {};
    return {
      fxRatesUsed: [...this.rates.keys()]
        .sort()
        .map((key) => this.rates.get(key)!),
    };
  }
}

export function multiplyMinorByRate(
  amountMinorStr: string,
  rateStr: string,
): string {
  const isNegativeRate = rateStr.startsWith('-');
  const cleanRate = isNegativeRate ? rateStr.slice(1) : rateStr;
  const dotIndex = cleanRate.indexOf('.');
  let unscaledRateStr: string;
  let scale = 0;
  if (dotIndex === -1) unscaledRateStr = cleanRate;
  else {
    const intPart = cleanRate.slice(0, dotIndex);
    const fracPart = cleanRate.slice(dotIndex + 1);
    scale = fracPart.length;
    unscaledRateStr = intPart + fracPart;
  }
  const rateNumerator = (isNegativeRate ? -1n : 1n) * BigInt(unscaledRateStr);
  const denominator = 10n ** BigInt(scale);
  const product = BigInt(amountMinorStr) * rateNumerator;
  if (denominator === 1n) return product.toString();
  const absolute = product < 0n ? -product : product;
  let quotient = absolute / denominator;
  if ((absolute % denominator) * 2n >= denominator) quotient += 1n;
  return (product < 0n ? -quotient : quotient).toString();
}
