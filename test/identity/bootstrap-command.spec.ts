import { describe, expect, it } from 'vitest';

import {
  BootstrapCommandValidationError,
  createBootstrapCommand,
  isExactBootstrapReplay,
} from '../../src/identity/bootstrap-command.js';

const subject = '3f084ac5-18a6-4e09-920d-2e3da29df7c8';
type FieldCase = readonly [field: string, value: unknown];
// prettier-ignore
const body = { email: '  ADA@EXAMPLE.TEST ', displayName: '  Ada Lovelace  ', locale: 'es-co', countryCode: 'co', timezone: 'america/bogota', dateFormat: 'DD/MM/YYYY', weekStartsOn: 1, numberFormat: '1.234,56', defaultCurrency: 'cop', workspaceName: '  Ada Personal  ', baseCurrency: 'usd' };

describe('createBootstrapCommand', () => {
  it('creates an immutable canonical command from trusted subject and normalized body', () => {
    const command = createBootstrapCommand(subject, body);
    expect(command).toEqual({
      subject,
      email: 'ada@example.test',
      displayName: 'Ada Lovelace',
      locale: 'es-CO',
      countryCode: 'CO',
      timezone: 'America/Bogota',
      dateFormat: 'DD/MM/YYYY',
      weekStartsOn: 1,
      numberFormat: '1.234,56',
      defaultCurrency: 'COP',
      privacyModeEnabled: false,
      workspaceName: 'Ada Personal',
      baseCurrency: 'USD',
    });
    expect(Object.isFrozen(command)).toBe(true);
    expect(command).not.toBe(body);
  });
  // prettier-ignore
  const invalidCases: readonly FieldCase[] = [['email', undefined], ['displayName', undefined], ['locale', undefined], ['countryCode', undefined], ['timezone', undefined], ['dateFormat', undefined], ['weekStartsOn', undefined], ['numberFormat', undefined], ['defaultCurrency', undefined], ['workspaceName', undefined], ['baseCurrency', undefined], ['email', '   '], ['email', '.a@example.com'], ['email', 'a..b@example.com'], ['email', 'a@-example.com'], ['email', 'a@example-.com'], ['email', 'a@@example.com'], ['email', 'aexample.com'], ['displayName', ''], ['locale', 'not_a_locale'], ['locale', 'zz-ZZ'], ['countryCode', 'ZZ'], ['countryCode', 'EU'], ['countryCode', 'UN'], ['countryCode', 'XK'], ['timezone', 'Mars/Olympus'], ['dateFormat', 'MM-YYYY-DD'], ['weekStartsOn', 7], ['weekStartsOn', 1.5], ['numberFormat', '1 234,56'], ['defaultCurrency', 'XXX'], ['workspaceName', ''], ['baseCurrency', 'DEM']];
  it.each(invalidCases)(
    'reports invalid %s values as field violations',
    (field, value) =>
      expectViolation(
        () => createBootstrapCommand(subject, { ...body, [field]: value }),
        field,
      ),
  );
  // prettier-ignore
  const injectedFields: readonly FieldCase[] = [['sub', subject], ['userId', subject], ['profileId', subject], ['workspaceId', subject], ['transport', { requestId: 'untrusted' }]];
  it.each(injectedFields)(
    'rejects body-supplied identity and transport metadata: %s',
    (field, value) =>
      expectViolation(
        () => createBootstrapCommand(subject, { ...body, [field]: value }),
        field,
      ),
  );
  it('sorts additional-field violations independently of input insertion order', () => {
    const violations = (input: object) => {
      try {
        createBootstrapCommand(subject, input);
      } catch (error) {
        return (error as BootstrapCommandValidationError).violations;
      }
      throw new Error('expected validation failure');
    };
    expect(violations({ ...body, z: 1, a: 1 })).toEqual(
      violations({ ...body, a: 1, z: 1 }),
    );
  });
  it('enforces name boundaries and boolean privacy mode', () => {
    expect(
      createBootstrapCommand(subject, {
        ...body,
        displayName: 'a',
        workspaceName: 'b'.repeat(120),
        privacyModeEnabled: true,
      }).privacyModeEnabled,
    ).toBe(true);
    for (const [field, value] of [
      ['displayName', 'a'.repeat(121)],
      ['workspaceName', 'a'.repeat(121)],
      ['privacyModeEnabled', 'false'],
    ] as const)
      expectViolation(
        () => createBootstrapCommand(subject, { ...body, [field]: value }),
        field,
      );
  });
});

describe('isExactBootstrapReplay', () => {
  it('accepts equivalent normalized requests and rejects a difference in every canonical field', () => {
    const canonical = createBootstrapCommand(subject, body);
    expect(
      isExactBootstrapReplay(
        canonical,
        createBootstrapCommand(subject, { ...body, locale: 'ES-co' }),
      ),
    ).toBe(true);
    // prettier-ignore
    const differences = { subject: 'other-subject', email: 'grace@example.test', displayName: 'Grace', locale: 'en-US', countryCode: 'US', timezone: 'UTC', dateFormat: 'MM/DD/YYYY', weekStartsOn: 0, numberFormat: '1,234.56', defaultCurrency: 'USD', privacyModeEnabled: true, workspaceName: 'Grace Personal', baseCurrency: 'COP' };
    for (const [field, value] of Object.entries(differences))
      expect(
        isExactBootstrapReplay(canonical, { ...canonical, [field]: value }),
      ).toBe(false);
  });
});

function expectViolation(action: () => unknown, field: string): void {
  expect(action).toThrow(BootstrapCommandValidationError);
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(BootstrapCommandValidationError);
    expect(
      (error as BootstrapCommandValidationError).violations,
    ).toContainEqual(expect.objectContaining({ field }));
  }
}
