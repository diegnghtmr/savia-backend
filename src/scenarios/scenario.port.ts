import type { Cursor, PageInfo } from '../platform/cursor.js';
import type { TransactionClient } from '../platform/pg-transaction.js';

export const SCENARIOS_PORT = Symbol('ScenariosPort');

export interface ScenarioFigureSet {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly baseCurrency: string;
  readonly monthlyIncomeMinor: string;
  readonly monthlyExpensesMinor: string;
  readonly monthlySavingsCapacityMinor: string;
  readonly netWorthMinor: string;
}

export interface ScenarioRunResult {
  readonly status: 'completed' | 'failed';
  readonly baseline: ScenarioFigureSet;
  readonly projected: ScenarioFigureSet;
  readonly difference: ScenarioFigureSet;
  readonly risks: readonly string[];
}

export const SCENARIO_ASSUMPTION_TYPES = [
  'income_change',
  'expense_change',
  'purchase',
  'new_debt',
  'extra_debt_payment',
  'cancel_subscription',
  'exchange_rate_change',
  'savings_contribution',
  'income_gap',
] as const;

export type ScenarioAssumptionType = (typeof SCENARIO_ASSUMPTION_TYPES)[number];

export interface ScenarioAssumption {
  readonly type: ScenarioAssumptionType;
  readonly value: Record<string, unknown>;
}

export interface Scenario {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly assumptions: readonly ScenarioAssumption[];
  readonly createdAt: string;
  readonly lastRunId: string | null;
}

export interface ScenarioRun {
  readonly id: string;
  readonly scenarioId: string;
  readonly status: 'completed' | 'failed';
  readonly baseline: ScenarioFigureSet;
  readonly projected: ScenarioFigureSet;
  readonly difference: ScenarioFigureSet;
  readonly risks: readonly string[];
}

export interface CreateScenarioRequest {
  readonly name: string;
  readonly description?: string | null;
  readonly assumptions: readonly ScenarioAssumption[];
}

export interface ScenarioListQuery {
  readonly workspaceId: string;
  readonly cursor?: Cursor;
  readonly limit: number;
}

export interface ScenarioItem {
  readonly scenario: Scenario;
  readonly cursorAt: string;
}

export interface ScenarioPage {
  readonly items: readonly Scenario[];
  readonly pageInfo: PageInfo;
}

export interface AccountNativeBalanceRow extends Record<string, unknown> {
  readonly id: string;
  readonly currency: string;
  readonly nativeBalanceMinor: string;
}

export interface DebtOutstandingBalanceRow extends Record<string, unknown> {
  readonly id: string;
  readonly currency: string;
  readonly outstandingBalanceMinor: string;
}

export interface TransactionFlowRow extends Record<string, unknown> {
  readonly id: string;
  readonly type: 'income' | 'expense' | 'refund';
  readonly amountMinor: string;
  readonly currency: string;
  readonly occurredAt: Date;
  readonly categoryId?: string | null;
  readonly categoryName?: string | null;
}

export const SCENARIO_OUTCOMES = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  CONFLICT: 'conflict',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  MISSING_RATE: 'missing_rate',
  OK: 'ok',
} as const;

export type ScenarioCreateOutcome =
  | {
      readonly kind: typeof SCENARIO_OUTCOMES.CREATED;
      readonly scenario: Scenario;
    }
  | {
      readonly kind: typeof SCENARIO_OUTCOMES.REPLAYED;
      readonly status: number;
      readonly etag?: string | null;
      readonly body: unknown;
    }
  | { readonly kind: typeof SCENARIO_OUTCOMES.CONFLICT }
  | { readonly kind: typeof SCENARIO_OUTCOMES.FORBIDDEN };

export type ScenarioListOutcome =
  | { readonly kind: 'ok'; readonly page: ScenarioPage }
  | { readonly kind: typeof SCENARIO_OUTCOMES.FORBIDDEN };

export type ScenarioRunOutcome =
  | {
      readonly kind: typeof SCENARIO_OUTCOMES.OK;
      readonly run: ScenarioRun;
    }
  | {
      readonly kind: typeof SCENARIO_OUTCOMES.REPLAYED;
      readonly status: number;
      readonly etag?: string | null;
      readonly body: unknown;
    }
  | { readonly kind: typeof SCENARIO_OUTCOMES.CONFLICT }
  | { readonly kind: typeof SCENARIO_OUTCOMES.FORBIDDEN }
  | { readonly kind: typeof SCENARIO_OUTCOMES.NOT_FOUND }
  | {
      readonly kind: typeof SCENARIO_OUTCOMES.MISSING_RATE;
      readonly fromCurrency: string;
      readonly toCurrency: string;
    };

export interface ScenarioStore {
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;
  createScenario(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateScenarioRequest,
  ): Promise<Scenario>;
  findScenario(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<Scenario | undefined>;
  listScenarios(
    client: TransactionClient,
    query: ScenarioListQuery,
    limit: number,
  ): Promise<readonly ScenarioItem[]>;
  readWorkspaceBaseCurrency(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;
  readAccountNativeBalances(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<readonly AccountNativeBalanceRow[]>;
  readDebtOutstandingBalances(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<readonly DebtOutstandingBalanceRow[]>;
  readTransactionsInPeriod(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
  ): Promise<readonly TransactionFlowRow[]>;
  findExchangeRate(
    client: TransactionClient,
    workspaceId: string,
    baseCurrency: string,
    quoteCurrency: string,
    asOf?: Date | null,
  ): Promise<string | undefined>;
  createScenarioRun(
    client: TransactionClient,
    workspaceId: string,
    scenarioId: string,
    subject: string,
    run: ScenarioRunResult,
  ): Promise<ScenarioRun>;
  updateScenarioLastRunId(
    client: TransactionClient,
    workspaceId: string,
    scenarioId: string,
    lastRunId: string,
  ): Promise<void>;
}

export interface ScenariosPort {
  createScenario(
    subject: string,
    workspaceId: string,
    command: CreateScenarioRequest,
    key: string,
  ): Promise<ScenarioCreateOutcome>;
  listScenarios(
    subject: string,
    query: ScenarioListQuery,
  ): Promise<ScenarioListOutcome>;
  runScenario(
    subject: string,
    workspaceId: string,
    scenarioId: string,
    key: string,
  ): Promise<ScenarioRunOutcome>;
}
