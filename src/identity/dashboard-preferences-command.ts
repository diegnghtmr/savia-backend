import {
  currencyValue,
  type FieldViolation,
} from '../platform/field-validation.js';

export const DASHBOARD_CARD_IDS = [
  'net_worth',
  'assets',
  'debts',
  'income',
  'expenses',
  'savings_capacity',
  'budget_utilization',
  'account_balances',
  'upcoming_operations',
  'alerts',
  'reconciliation_status',
] as const;
type CardId = (typeof DASHBOARD_CARD_IDS)[number];
const supportedCards: ReadonlySet<unknown> = new Set(DASHBOARD_CARD_IDS);

export interface DashboardPreferencesCommand {
  readonly cards: readonly { readonly id: CardId; readonly visible: boolean }[];
  readonly period:
    | { readonly preset: 'this_month' | 'this_quarter' | 'this_year' }
    | { readonly preset: 'custom'; readonly from: string; readonly to: string };
  readonly presentationCurrency: string;
}

function object(
  value: unknown,
  fields: number,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields
  );
}

function date(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function period(
  value: unknown,
): DashboardPreferencesCommand['period'] | undefined {
  if (
    object(value, 1) &&
    (value.preset === 'this_month' ||
      value.preset === 'this_quarter' ||
      value.preset === 'this_year')
  )
    return { preset: value.preset };
  if (
    object(value, 3) &&
    value.preset === 'custom' &&
    date(value.from) &&
    date(value.to) &&
    value.from <= value.to
  )
    return { preset: 'custom', from: value.from, to: value.to };
  return undefined;
}

export function parseDashboardPreferences(
  input: unknown,
): DashboardPreferencesCommand | undefined {
  if (
    !object(input, 3) ||
    !Array.isArray(input.cards) ||
    input.cards.length > DASHBOARD_CARD_IDS.length
  )
    return undefined;
  const seen = new Set<unknown>();
  const cards: Array<DashboardPreferencesCommand['cards'][number]> = [];
  for (const card of input.cards as unknown[]) {
    if (
      !object(card, 2) ||
      !supportedCards.has(card.id) ||
      typeof card.visible !== 'boolean' ||
      seen.has(card.id)
    )
      return undefined;
    seen.add(card.id);
    cards.push({ id: card.id as CardId, visible: card.visible });
  }
  const parsedPeriod = period(input.period);
  const violations: FieldViolation[] = [];
  // Reuse the same active-currency allowlist used by account/workspace inputs.
  const presentationCurrency = currencyValue(
    input.presentationCurrency,
    'presentationCurrency',
    violations,
  );
  if (
    !parsedPeriod ||
    violations.length ||
    input.presentationCurrency !== presentationCurrency
  )
    return undefined;
  return { cards, period: parsedPeriod, presentationCurrency };
}
