import type {
  DebtPaymentFrequency,
  DebtProjection,
  DebtProjectionInput,
  DebtProjectionTerms,
  Money,
  ProjectedPayment,
} from './debt.port.js';

const DAY_MS = 86_400_000;
const CADENCE = {
  daily: { days: 1, months: 0, periods: 365n },
  weekly: { days: 7, months: 0, periods: 52n },
  biweekly: { days: 14, months: 0, periods: 26n },
  monthly: { days: 0, months: 1, periods: 12n },
  quarterly: { days: 0, months: 3, periods: 4n },
  yearly: { days: 0, months: 12, periods: 1n },
} as const;
type Cadence = (typeof CADENCE)[DebtPaymentFrequency];

function installment(anchor: Date, cadence: Cadence, index: number): Date {
  if (cadence.days) return new Date(+anchor + cadence.days * index * DAY_MS);
  const due = new Date(anchor);
  due.setUTCMonth(due.getUTCMonth() + cadence.months * index + 1, 0);
  due.setUTCDate(Math.min(due.getUTCDate(), anchor.getUTCDate()));
  return due;
}

function firstIndex(
  anchor: Date,
  cadence: Cadence,
  asOf: Date,
  hasNextDue: boolean,
): number {
  const months =
    (asOf.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    asOf.getUTCMonth() -
    anchor.getUTCMonth();
  const offset = cadence.days
    ? (+asOf - +anchor) / (cadence.days * DAY_MS)
    : months / cadence.months;
  const index = Math.max(hasNextDue ? 0 : 1, Math.floor(offset));
  return installment(anchor, cadence, index) < asOf ? index + 1 : index;
}

function state(row: DebtProjectionTerms, asOf: Date) {
  const cadence = CADENCE[row.frequency ?? 'monthly'];
  const anchor = new Date(row.nextDue ?? row.startDate ?? asOf);
  const [whole, fractional = ''] = row.annualRate.split('.');
  const index = firstIndex(anchor, cadence, asOf, row.nextDue !== null);
  return {
    id: row.id,
    principal: BigInt(row.balance),
    interest: 0n,
    minimum: BigInt(row.minimum ?? '0'),
    rate: BigInt(`${whole}${fractional}`),
    scale: 10n ** BigInt(fractional.length),
    cadence,
    anchor,
    index,
    due: installment(anchor, cadence, index),
  };
}

type State = ReturnType<typeof state>;
const minimum = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const owing = (debt: State) => debt.principal + debt.interest;

function pay(debt: State, amount: bigint): bigint {
  const paid = minimum(owing(debt), amount);
  const interest = minimum(debt.interest, paid);
  debt.interest -= interest;
  debt.principal -= paid - interest;
  return paid;
}

export function projectDebt(
  rows: readonly DebtProjectionTerms[],
  input: DebtProjectionInput,
): DebtProjection | undefined {
  const loan = rows.find((row) => row.id === input.debtId);
  if (!loan) return undefined;
  const { asOf, currency } = loan;
  const money = (amount: bigint): Money => ({
    amountMinor: String(amount),
    currency,
  });
  const schedule: ProjectedPayment[] = [];
  const starting = BigInt(loan.balance);
  const result = (interest: bigint, estimatedPayoffDate: string) => ({
    debtId: loan.id,
    strategy: input.strategy,
    asOf,
    startingBalance: money(starting),
    totalInterest: money(interest),
    totalCost: money(starting + interest),
    estimatedPayoffDate,
    schedule,
  });
  if (starting === 0n) return result(0n, asOf);
  if (rows.some((row) => BigInt(row.balance) > 0n && row.minimum === null)) {
    return undefined;
  }

  const date = new Date(asOf);
  const debts = rows
    .filter((row) => BigInt(row.balance) > 0n)
    .map((row) => state(row, date));
  const target = debts.find((debt) => debt.id === loan.id)!;
  const portfolio =
    input.strategy === 'snowball' || input.strategy === 'avalanche';
  const monthlyAnchor = target.due;
  const monthly = CADENCE.monthly;
  let extraIndex = 0;
  let totalInterest = 0n;
  // Bound simulation work and the size of the returned schedule for unrealistic terms.
  for (let event = 0; event < 24_000; event++) {
    const extraDue =
      input.extra > 0n
        ? +installment(monthlyAnchor, monthly, extraIndex)
        : Infinity;
    let due = extraDue;
    for (const debt of debts) due = Math.min(due, +debt.due);
    if (!Number.isFinite(due) || new Date(due).getUTCFullYear() > 9999) {
      return undefined;
    }

    const priorPrincipal = target.principal;
    let targetAccrued = 0n;
    const priorInterest = target.interest;
    let budget = due === extraDue ? input.extra : 0n;
    if (due === extraDue) extraIndex++;

    // Minimums are applied first. A paid-off debt's freed installment remains
    // available on its own cadence. Interest rounds half-up per scheduled period.
    for (const debt of debts) {
      if (+debt.due !== due) continue;
      const divisor = debt.scale * debt.cadence.periods;
      const accrued = (debt.principal * debt.rate + divisor / 2n) / divisor;
      debt.interest += accrued;
      if (debt === target) targetAccrued = accrued;
      const paid = pay(debt, debt.minimum);
      if (portfolio) budget += debt.minimum - paid;
      debt.due = installment(debt.anchor, debt.cadence, ++debt.index);
    }
    if (budget > 0n) {
      const ranked = portfolio
        ? debts
            .filter((debt) => owing(debt) > 0n)
            .sort((a, b) => {
              const difference =
                input.strategy === 'avalanche'
                  ? b.rate * a.scale - a.rate * b.scale
                  : owing(a) - owing(b);
              return difference === 0n
                ? a.id.localeCompare(b.id)
                : difference < 0n
                  ? -1
                  : 1;
            })
        : [target];
      for (const debt of ranked) {
        budget -= pay(debt, budget);
        if (budget === 0n) break;
      }
    }
    const principal = priorPrincipal - target.principal;
    const interest = priorInterest + targetAccrued - target.interest;
    totalInterest += interest;
    const dueDate = new Date(due).toISOString().slice(0, 10);
    if (principal + interest > 0n) {
      schedule.push({
        dueDate,
        paymentAmount: money(principal + interest),
        principalAmount: money(principal),
        interestAmount: money(interest),
        remainingBalance: money(target.principal),
      });
    }
    if (owing(target) === 0n) return result(totalInterest, dueDate);
    if (!portfolio && input.extra === 0n && principal === 0n) return undefined;
  }
  return undefined;
}
