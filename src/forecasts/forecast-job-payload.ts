import { UUID_PATTERN } from '../platform/uuid.js';

export const FORECAST_JOB_PAYLOAD_VERSION = 1 as const;

export class ForecastJobPayloadError extends Error {
  public readonly isDomainError = true;
  public readonly code = 'INVALID_PAYLOAD';

  public constructor(message: string) {
    super(message);
    this.name = 'ForecastJobPayloadError';
  }
}

export interface ForecastJobPayload {
  readonly version: typeof FORECAST_JOB_PAYLOAD_VERSION;
  readonly asOf: string;
  readonly horizonDays: number;
  readonly includeScenarios: boolean;
  readonly effectiveAccountIds: readonly string[];
  readonly closedAccountAssumptions: readonly string[];
  readonly baseCurrency: string;
}

const PAYLOAD_KEYS = [
  'version',
  'asOf',
  'horizonDays',
  'includeScenarios',
  'effectiveAccountIds',
  'closedAccountAssumptions',
  'baseCurrency',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

export function parseForecastJobPayload(raw: unknown): ForecastJobPayload {
  if (!isRecord(raw)) {
    throw new ForecastJobPayloadError(
      'Forecast job payload must be an object.',
    );
  }

  const keys = Object.keys(raw);
  if (
    keys.length !== PAYLOAD_KEYS.length ||
    keys.some(
      (key) => !PAYLOAD_KEYS.includes(key as (typeof PAYLOAD_KEYS)[number]),
    )
  ) {
    throw new ForecastJobPayloadError(
      'Forecast job payload has unknown or missing fields.',
    );
  }

  if (raw.version !== FORECAST_JOB_PAYLOAD_VERSION) {
    throw new ForecastJobPayloadError(
      'Forecast job payload version is not supported.',
    );
  }

  if (typeof raw.asOf !== 'string' || Number.isNaN(Date.parse(raw.asOf))) {
    throw new ForecastJobPayloadError(
      'Forecast job payload asOf must be an ISO timestamp.',
    );
  }

  if (
    typeof raw.horizonDays !== 'number' ||
    !Number.isInteger(raw.horizonDays) ||
    raw.horizonDays < 1 ||
    raw.horizonDays > 730
  ) {
    throw new ForecastJobPayloadError(
      'Forecast job payload horizonDays must be an integer between 1 and 730.',
    );
  }

  if (typeof raw.includeScenarios !== 'boolean') {
    throw new ForecastJobPayloadError(
      'Forecast job payload includeScenarios must be a boolean.',
    );
  }

  if (
    !isStringArray(raw.effectiveAccountIds) ||
    raw.effectiveAccountIds.some((id) => !UUID_PATTERN.test(id))
  ) {
    throw new ForecastJobPayloadError(
      'Forecast job payload effectiveAccountIds must be an array of UUIDs.',
    );
  }

  if (!isStringArray(raw.closedAccountAssumptions)) {
    throw new ForecastJobPayloadError(
      'Forecast job payload closedAccountAssumptions must be an array of strings.',
    );
  }

  if (typeof raw.baseCurrency !== 'string' || raw.baseCurrency.trim() === '') {
    throw new ForecastJobPayloadError(
      'Forecast job payload baseCurrency must be a non-empty string.',
    );
  }

  return {
    version: FORECAST_JOB_PAYLOAD_VERSION,
    asOf: raw.asOf,
    horizonDays: raw.horizonDays,
    includeScenarios: raw.includeScenarios,
    effectiveAccountIds: raw.effectiveAccountIds,
    closedAccountAssumptions: raw.closedAccountAssumptions,
    baseCurrency: raw.baseCurrency,
  };
}

export function freezeForecastJobPayload(
  payload: ForecastJobPayload,
): Record<string, unknown> {
  return {
    version: payload.version,
    asOf: payload.asOf,
    horizonDays: payload.horizonDays,
    includeScenarios: payload.includeScenarios,
    effectiveAccountIds: [...payload.effectiveAccountIds],
    closedAccountAssumptions: [...payload.closedAccountAssumptions],
    baseCurrency: payload.baseCurrency,
  };
}
