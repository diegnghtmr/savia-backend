import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  JobExecutionContext,
  NonRenderingJobHandler,
} from '../platform/job-handler.port.js';
import { PROBLEM_TYPES } from '../platform/problem-details.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import { JOB_WRITER_TYPES } from '../platform/job-writer.port.js';
import {
  computeBalanceForecast,
  ForecastMissingRateError,
  type ForecastComputationResult,
} from './forecast-computation.js';
import {
  parseForecastJobPayload,
  type ForecastJobPayload,
} from './forecast-job-payload.js';
import { PostgresForecastAdapter } from './postgres-forecast.adapter.js';

const FORECAST_WRITE_ROLES = {
  OWNER: 'owner',
  ADMINISTRATOR: 'administrator',
  EDITOR: 'editor',
} as const;

type ForecastWriteRole =
  (typeof FORECAST_WRITE_ROLES)[keyof typeof FORECAST_WRITE_ROLES];

const WRITE_ROLE_VALUES: readonly string[] =
  Object.values(FORECAST_WRITE_ROLES);

export class ForecastWriteForbiddenError extends Error {
  public readonly isDomainError = true;
  public readonly type = PROBLEM_TYPES.FORBIDDEN;
  public readonly title = 'Forbidden';
  public readonly status = 403;
  public readonly code = 'forbidden';

  public constructor() {
    super('Workspace access forbidden');
    this.name = 'ForecastWriteForbiddenError';
  }
}

function isWriteRole(role: string | undefined): role is ForecastWriteRole {
  return WRITE_ROLE_VALUES.includes(role ?? '');
}

@Injectable()
export class ForecastJobHandler
  implements
    NonRenderingJobHandler<ForecastJobPayload, ForecastComputationResult>
{
  public readonly jobType = JOB_WRITER_TYPES.BALANCE_FORECAST;

  public constructor(private readonly forecasts: PostgresForecastAdapter) {}

  public parsePayload(raw: unknown): ForecastJobPayload {
    return parseForecastJobPayload(raw);
  }

  public async compute(
    context: JobExecutionContext<ForecastJobPayload>,
    client: TransactionClient,
  ): Promise<ForecastComputationResult> {
    const payload = context.payload;
    const asOf = new Date(payload.asOf);
    const periodEnd = asOf.toISOString().slice(0, 10);
    const nowYear = asOf.getUTCFullYear();
    const nowMonth = asOf.getUTCMonth();
    const periodStart = new Date(Date.UTC(nowYear, nowMonth - 11, 1))
      .toISOString()
      .slice(0, 10);

    const flowRows = await this.forecasts.readTransactionsInPeriod(
      client,
      context.workspaceId,
      periodStart,
      periodEnd,
      payload.effectiveAccountIds,
    );
    const accountBalances = await this.forecasts.readAccountNativeBalances(
      client,
      context.workspaceId,
      payload.effectiveAccountIds,
    );

    const rates = new Map<string, string>();
    const neededCurrencies = new Set<string>();
    for (const acct of accountBalances) {
      if (acct.currency !== payload.baseCurrency) {
        neededCurrencies.add(acct.currency);
      }
    }
    for (const row of flowRows) {
      if (row.currency !== payload.baseCurrency) {
        neededCurrencies.add(row.currency);
      }
    }
    for (const curr of neededCurrencies) {
      const rate = await this.forecasts.findExchangeRate(
        client,
        context.workspaceId,
        curr,
        payload.baseCurrency,
        asOf,
      );
      if (!rate) {
        throw new ForecastMissingRateError(curr, payload.baseCurrency);
      }
      rates.set(`${curr}:${payload.baseCurrency}`, rate);
    }

    let appliedScenarioRun = null;
    if (payload.includeScenarios) {
      const scenarioRun =
        await this.forecasts.findMostRecentCompletedScenarioRun(
          client,
          context.workspaceId,
        );
      if (scenarioRun) {
        appliedScenarioRun = {
          id: scenarioRun.id,
          monthlySavingsCapacityMinor: scenarioRun.monthlySavingsCapacityMinor,
        };
      }
    }

    return computeBalanceForecast({
      baseCurrency: payload.baseCurrency,
      horizonDays: payload.horizonDays,
      asOf,
      includeScenarios: payload.includeScenarios,
      closedAccountAssumptions: payload.closedAccountAssumptions,
      accountBalances,
      flowRows,
      rates,
      appliedScenarioRun,
    });
  }

  public async persist(
    context: JobExecutionContext<ForecastJobPayload>,
    computed: ForecastComputationResult,
    client: TransactionClient,
  ): Promise<string> {
    const role = await this.forecasts.readActiveRole(
      client,
      context.workspaceId,
    );
    if (!isWriteRole(role)) {
      throw new ForecastWriteForbiddenError();
    }

    const forecastId = randomUUID();
    await this.forecasts.createForecast(
      client,
      context.workspaceId,
      context.actorId,
      {
        id: forecastId,
        jobId: context.jobId,
        status: 'completed',
        confidence: computed.confidence,
        method: computed.method,
        horizonDays: context.payload.horizonDays,
        assumptions: computed.assumptions,
        series: computed.series,
        generatedAt: new Date(context.payload.asOf),
      },
    );
    return forecastId;
  }
}
