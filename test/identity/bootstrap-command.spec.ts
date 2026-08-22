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

  it('rejects strings containing null characters (U+0000) with invalid-characters violation', () => {
    for (const field of ['displayName', 'workspaceName']) {
      expectViolation(
        () =>
          createBootstrapCommand(subject, {
            ...body,
            [field]: 'Acme\0Corp',
          }),
        field,
      );
    }
  });

  it('enforces name length by unicode code points rather than UTF-16 code units', () => {
    // U+1F600 (surrogate pair, 2 UTF-16 code units, 1 Unicode code point) + 119 ASCII chars = 120 code points (121 UTF-16 units)
    const exact120CodePoints = '\u{1F600}' + 'a'.repeat(119);
    expect([...exact120CodePoints].length).toBe(120);
    expect(exact120CodePoints.length).toBe(121);

    const command = createBootstrapCommand(subject, {
      ...body,
      displayName: exact120CodePoints,
      workspaceName: exact120CodePoints,
    });
    expect(command.displayName).toBe(exact120CodePoints);
    expect(command.workspaceName).toBe(exact120CodePoints);

    // 121 code points must be rejected
    const exact121CodePoints = '\u{1F600}' + 'a'.repeat(120);
    expect([...exact121CodePoints].length).toBe(121);
    expectViolation(
      () =>
        createBootstrapCommand(subject, {
          ...body,
          displayName: exact121CodePoints,
        }),
      'displayName',
    );
    expectViolation(
      () =>
        createBootstrapCommand(subject, {
          ...body,
          workspaceName: exact121CodePoints,
        }),
      'workspaceName',
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

  // currencyValue accepts any code in Intl.supportedValuesOf('currency'), and both
  // profiles.default_currency and workspaces.base_currency are
  // `char(3) check (~ '^[A-Z]{3}$')`. Measured on PostgreSQL 18.4, a code that slips
  // through reaches SQL as 23514, or as 22001 if it is longer than three characters,
  // and both escape the catch-all filter as a 500 from a request body. This asserts
  // the validator is genuinely NARROWER than the column rather than merely believed
  // to be, and fails loudly if ICU data ever widens the accepted set.
  it('accepts only currency codes the char(3) column check can store', () => {
    const accepted = Intl.supportedValuesOf('currency');
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.filter((code) => !/^[A-Z]{3}$/.test(code))).toEqual([]);
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
