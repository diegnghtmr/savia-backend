import {
  add,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import {
  REPORT_DIMENSIONS,
  REPORT_MEASURES,
  REPORT_VISUALIZATIONS,
  type CreateReportDefinitionRequest,
  type ReportDimension,
  type ReportMeasure,
  type ReportVisualization,
} from './report.port.js';

export class ReportCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Report definition command validation failed.');
    this.name = 'ReportCommandValidationError';
  }
}

const TOP_LEVEL_FIELDS = [
  'name',
  'dimensions',
  'measures',
  'visualization',
  'filters',
] as const;

export function createReportDefinitionCommand(
  input: unknown,
): CreateReportDefinitionRequest {
  const violations: FieldViolation[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new ReportCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  const body = input as Record<string, unknown>;

  Object.keys(body).forEach((key) => {
    if (!TOP_LEVEL_FIELDS.includes(key as (typeof TOP_LEVEL_FIELDS)[number])) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  });

  const name = body.name;
  if (
    typeof name !== 'string' ||
    [...name].length < 1 ||
    [...name].length > 120
  ) {
    add(violations, 'name', 'invalid', 'must be between 1 and 120 characters');
  }

  const dimensionsRaw = body.dimensions;
  const validatedDimensions: ReportDimension[] = [];
  if (!Array.isArray(dimensionsRaw)) {
    add(violations, 'dimensions', 'invalid', 'must be an array');
  } else {
    for (let index = 0; index < dimensionsRaw.length; index += 1) {
      const item = dimensionsRaw[index];
      if (
        typeof item !== 'string' ||
        !REPORT_DIMENSIONS.includes(item as ReportDimension)
      ) {
        add(
          violations,
          `dimensions.${index}`,
          'invalid',
          'must be a supported report dimension',
        );
      } else if (item === 'variability') {
        add(
          violations,
          `dimensions.${index}`,
          'unsupported',
          "variability dimension is not supported by this deployment's data model",
        );
      } else {
        validatedDimensions.push(item as ReportDimension);
      }
    }
  }

  const measuresRaw = body.measures;
  const validatedMeasures: ReportMeasure[] = [];
  if (!Array.isArray(measuresRaw)) {
    add(violations, 'measures', 'invalid', 'must be an array');
  } else if (measuresRaw.length === 0) {
    add(violations, 'measures', 'invalid', 'must contain at least 1 measure');
  } else {
    for (let index = 0; index < measuresRaw.length; index += 1) {
      const item = measuresRaw[index];
      if (
        typeof item !== 'string' ||
        !REPORT_MEASURES.includes(item as ReportMeasure)
      ) {
        add(
          violations,
          `measures.${index}`,
          'invalid',
          'must be a supported report measure',
        );
      } else {
        validatedMeasures.push(item as ReportMeasure);
      }
    }
  }

  const visualization = body.visualization;
  if (
    typeof visualization !== 'string' ||
    !REPORT_VISUALIZATIONS.includes(visualization as ReportVisualization)
  ) {
    add(
      violations,
      'visualization',
      'invalid',
      'must be a supported visualization type',
    );
  }

  let filters: Record<string, unknown> = {};
  const filtersRaw = body.filters;
  if (filtersRaw !== undefined) {
    if (
      typeof filtersRaw !== 'object' ||
      filtersRaw === null ||
      Array.isArray(filtersRaw)
    ) {
      add(violations, 'filters', 'invalid', 'must be an object');
    } else {
      filters = filtersRaw as Record<string, unknown>;
    }
  }

  if (violations.length > 0) {
    throw new ReportCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  return {
    name: name as string,
    dimensions: validatedDimensions,
    measures: validatedMeasures,
    visualization: visualization as ReportVisualization,
    filters,
  };
}
