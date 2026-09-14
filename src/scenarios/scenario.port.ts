import type { Cursor, PageInfo } from '../platform/cursor.js';
import type { TransactionClient } from '../platform/pg-transaction.js';

export const SCENARIOS_PORT = Symbol('ScenariosPort');

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

export const SCENARIO_OUTCOMES = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  CONFLICT: 'conflict',
  FORBIDDEN: 'forbidden',
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
}
