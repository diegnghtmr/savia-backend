import { describe, expect, it } from 'vitest';
import {
  createScenarioCommand,
  ScenarioCommandValidationError,
} from '../../src/scenarios/scenario-command.js';
import { SCENARIO_ASSUMPTION_TYPES } from '../../src/scenarios/scenario.port.js';

describe('createScenarioCommand validation', () => {
  const validBase = {
    name: 'Conservative Forecast 2027',
    description: 'Baseline conservative assumptions.',
    assumptions: [
      {
        type: 'income_change',
        value: { amountMinor: '50000', currency: 'USD' },
      },
    ],
  };

  it('accepts a valid request with name, description, and assumption', () => {
    const result = createScenarioCommand(validBase);
    expect(result.name).toBe(validBase.name);
    expect(result.description).toBe(validBase.description);
    expect(result.assumptions).toEqual(validBase.assumptions);
  });

  it('accepts null description and omitted description', () => {
    const withNull = createScenarioCommand({
      ...validBase,
      description: null,
    });
    expect(withNull.description).toBeNull();

    const withOmitted = createScenarioCommand({
      name: validBase.name,
      assumptions: validBase.assumptions,
    });
    expect(withOmitted.description).toBeUndefined();
  });

  it('accepts all nine assumption types', () => {
    for (const type of SCENARIO_ASSUMPTION_TYPES) {
      const result = createScenarioCommand({
        name: 'Type Test',
        assumptions: [{ type, value: { arbitrary: true, count: 42 } }],
      });
      expect(result.assumptions[0]?.type).toBe(type);
      expect(result.assumptions[0]?.value).toEqual({
        arbitrary: true,
        count: 42,
      });
    }
  });

  it('does not invent per-type rules for assumption value (open object)', () => {
    const openValues = [
      {},
      { emptyNested: {} },
      { customField: 123, nestedArray: [1, 2, 3] },
      { arbitraryString: 'anything', flag: false },
    ];
    for (const value of openValues) {
      const result = createScenarioCommand({
        name: 'Open Value Test',
        assumptions: [{ type: 'purchase', value }],
      });
      expect(result.assumptions[0]?.value).toEqual(value);
    }
  });

  it('rejects non-object body', () => {
    const inputs = [null, undefined, 'string', 123, true, []];
    for (const input of inputs) {
      expect(() => createScenarioCommand(input)).toThrow(
        ScenarioCommandValidationError,
      );
      try {
        createScenarioCommand(input);
      } catch (err) {
        const error = err as ScenarioCommandValidationError;
        expect(error.violations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ field: 'body', code: 'invalid-type' }),
          ]),
        );
      }
    }
  });

  it('rejects unknown top-level properties', () => {
    const input = {
      ...validBase,
      unexpected: 'not-allowed',
      anotherOne: 123,
    };
    try {
      createScenarioCommand(input);
      expect.unreachable('should have thrown');
    } catch (err) {
      const error = err as ScenarioCommandValidationError;
      expect(error.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'unexpected', code: 'not-allowed' }),
          expect.objectContaining({ field: 'anotherOne', code: 'not-allowed' }),
        ]),
      );
    }
  });

  it('rejects name of 0 characters', () => {
    expect(() => createScenarioCommand({ ...validBase, name: '' })).toThrow(
      ScenarioCommandValidationError,
    );
    try {
      createScenarioCommand({ ...validBase, name: '' });
    } catch (err) {
      const error = err as ScenarioCommandValidationError;
      expect(error.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'name', code: 'invalid' }),
        ]),
      );
    }
  });

  it('rejects name of 121 characters', () => {
    const longName = 'a'.repeat(121);
    expect(() =>
      createScenarioCommand({ ...validBase, name: longName }),
    ).toThrow(ScenarioCommandValidationError);
    try {
      createScenarioCommand({ ...validBase, name: longName });
    } catch (err) {
      const error = err as ScenarioCommandValidationError;
      expect(error.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'name', code: 'invalid' }),
        ]),
      );
    }
  });

  it('rejects missing or non-string name', () => {
    for (const name of [undefined, null, 123, true, {}]) {
      expect(() => createScenarioCommand({ ...validBase, name })).toThrow(
        ScenarioCommandValidationError,
      );
    }
  });

  it('rejects description longer than 1000 characters', () => {
    const longDescription = 'd'.repeat(1001);
    expect(() =>
      createScenarioCommand({ ...validBase, description: longDescription }),
    ).toThrow(ScenarioCommandValidationError);
    try {
      createScenarioCommand({ ...validBase, description: longDescription });
    } catch (err) {
      const error = err as ScenarioCommandValidationError;
      expect(error.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'description', code: 'invalid' }),
        ]),
      );
    }
  });

  it('rejects non-string and non-null description', () => {
    for (const description of [123, true, {}, []]) {
      expect(() =>
        createScenarioCommand({ ...validBase, description }),
      ).toThrow(ScenarioCommandValidationError);
    }
  });

  it('accepts name of exactly 120 astral characters (code points)', () => {
    const astralName = '💰'.repeat(120);
    const result = createScenarioCommand({ ...validBase, name: astralName });
    expect(result.name).toBe(astralName);
  });

  it('rejects name of 121 astral characters (code points)', () => {
    const astralName = '💰'.repeat(121);
    expect(() =>
      createScenarioCommand({ ...validBase, name: astralName }),
    ).toThrow(ScenarioCommandValidationError);
    try {
      createScenarioCommand({ ...validBase, name: astralName });
    } catch (err) {
      const error = err as ScenarioCommandValidationError;
      expect(error.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'name', code: 'invalid' }),
        ]),
      );
    }
  });

  it('accepts description of exactly 1000 astral characters (code points)', () => {
    const astralDescription = '💰'.repeat(1000);
    const result = createScenarioCommand({
      ...validBase,
      description: astralDescription,
    });
    expect(result.description).toBe(astralDescription);
  });

  it('rejects description of 1001 astral characters (code points)', () => {
    const astralDescription = '💰'.repeat(1001);
    expect(() =>
      createScenarioCommand({ ...validBase, description: astralDescription }),
    ).toThrow(ScenarioCommandValidationError);
    try {
      createScenarioCommand({ ...validBase, description: astralDescription });
    } catch (err) {
      const error = err as ScenarioCommandValidationError;
      expect(error.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'description', code: 'invalid' }),
        ]),
      );
    }
  });

  it('rejects empty assumptions array with violation naming assumptions', () => {
    expect(() =>
      createScenarioCommand({ ...validBase, assumptions: [] }),
    ).toThrow(ScenarioCommandValidationError);
    try {
      createScenarioCommand({ ...validBase, assumptions: [] });
      expect.unreachable('should have thrown');
    } catch (err) {
      const error = err as ScenarioCommandValidationError;
      expect(error.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'assumptions', code: 'invalid' }),
        ]),
      );
    }
  });

  it('rejects missing or non-array assumptions', () => {
    for (const assumptions of [undefined, null, 'not-array', 123, {}]) {
      expect(() =>
        createScenarioCommand({ ...validBase, assumptions }),
      ).toThrow(ScenarioCommandValidationError);
    }
  });

  it('rejects unknown assumption type with violation naming assumptions.0.type', () => {
    const input = {
      ...validBase,
      assumptions: [{ type: 'unknown_custom_type', value: {} }],
    };
    try {
      createScenarioCommand(input);
      expect.unreachable('should have thrown');
    } catch (err) {
      const error = err as ScenarioCommandValidationError;
      expect(error.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'assumptions.0.type',
            code: 'invalid',
          }),
        ]),
      );
    }
  });

  it('rejects missing assumption type and null assumption type', () => {
    const missingType = {
      ...validBase,
      assumptions: [{ value: {} }],
    };
    try {
      createScenarioCommand(missingType);
      expect.unreachable('should have thrown');
    } catch (err) {
      const error = err as ScenarioCommandValidationError;
      expect(error.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'assumptions.0.type',
            code: 'invalid',
          }),
        ]),
      );
    }

    const nullType = {
      ...validBase,
      assumptions: [{ type: null, value: {} }],
    };
    try {
      createScenarioCommand(nullType);
      expect.unreachable('should have thrown');
    } catch (err) {
      const error = err as ScenarioCommandValidationError;
      expect(error.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'assumptions.0.type',
            code: 'invalid',
          }),
        ]),
      );
    }
  });

  it('rejects non-object assumption value (null, array, string, number, boolean)', () => {
    const invalidValues = [null, [1, 2], 'primitive_string', 123, false];
    for (const value of invalidValues) {
      const input = {
        ...validBase,
        assumptions: [{ type: 'purchase', value }],
      };
      try {
        createScenarioCommand(input);
        expect.unreachable('should have thrown');
      } catch (err) {
        const error = err as ScenarioCommandValidationError;
        expect(error.violations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              field: 'assumptions.0.value',
              code: 'invalid',
            }),
          ]),
        );
      }
    }
  });

  it('rejects non-object assumption item', () => {
    const input = {
      ...validBase,
      assumptions: [null, 'string_item', 123],
    };
    try {
      createScenarioCommand(input);
      expect.unreachable('should have thrown');
    } catch (err) {
      const error = err as ScenarioCommandValidationError;
      expect(error.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'assumptions.0',
            code: 'invalid',
          }),
        ]),
      );
    }
  });

  it('rejects unknown properties on assumption item', () => {
    const input = {
      ...validBase,
      assumptions: [
        {
          type: 'purchase',
          value: {},
          extraProperty: 'not allowed',
        },
      ],
    };
    try {
      createScenarioCommand(input);
      expect.unreachable('should have thrown');
    } catch (err) {
      const error = err as ScenarioCommandValidationError;
      expect(error.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'assumptions.0.extraProperty',
            code: 'not-allowed',
          }),
        ]),
      );
    }
  });

  it('returns sorted and frozen violations', () => {
    const input = {
      unexpectedZ: 1,
      name: '',
      unexpectedA: 2,
      assumptions: [],
    };
    try {
      createScenarioCommand(input);
      expect.unreachable('should have thrown');
    } catch (err) {
      const error = err as ScenarioCommandValidationError;
      expect(Object.isFrozen(error.violations)).toBe(true);
      const fields = error.violations.map((v) => v.field);
      const sorted = [...fields].sort();
      expect(fields).toEqual(sorted);
    }
  });
});
