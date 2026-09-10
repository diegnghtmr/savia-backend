export const CURRENCY_RATE_SELECTION_SQL = `
select rate::text as rate,
       to_char(effective_at at time zone 'utc', 'YYYY-MM-DD') as "rateDate",
       source as "rateSource"
  from public.exchange_rates
 where workspace_id = $1::uuid
   and base_currency = $2
   and quote_currency = $3
 order by (effective_at <= coalesce($4::timestamptz, now())) desc,
          case
            when effective_at <= coalesce($4::timestamptz, now()) then effective_at
          end desc,
          effective_at asc,
          id desc
 limit 1`;

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
