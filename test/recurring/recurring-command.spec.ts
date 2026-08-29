import { describe, expect, it } from 'vitest';
import {
  createRecurringRuleCommand,
  RecurringCommandValidationError,
} from '../../src/recurring/recurring-command.js';

const VALID_TEMPLATE = {
  type: 'expense',
  accountId: '00000000-0000-0000-0000-000000000001',
  amount: {
    amountMinor: '5000',
    currency: 'USD',
  },
  occurredAt: '2026-08-29T12:00:00.000Z',
  description: 'Monthly Cloud Subscription',
};

const VALID_REQUEST = {
  name: 'Cloud Hosting',
  frequency: 'monthly',
  behavior: 'create_draft',
  template: VALID_TEMPLATE,
  startsAt: '2026-08-31T00:00:00.000Z',
};

describe('createRecurringRuleCommand validation (RULING 51, 52, 53, 55)', () => {
  it('accepts a valid monthly recurring rule and COMPUTEs nextOccurrenceAt (RULING 51, 54)', () => {
    const command = createRecurringRuleCommand(VALID_REQUEST);

    expect(command.name).toBe('Cloud Hosting');
    expect(command.frequency).toBe('monthly');
    expect(command.behavior).toBe('create_draft');
    expect(command.rrule).toBeNull();
    expect(command.startsAt).toBe('2026-08-31T00:00:00.000Z');
    // RULING 51, 54: nextOccurrenceAt is COMPUTED (Aug 31 -> Sept 30)
    expect(command.nextOccurrenceAt).toBe('2026-09-30T00:00:00.000Z');
    expect(command.anchorDayOfMonth).toBe(31);
    expect(command.template.accountId).toBe(
      '00000000-0000-0000-0000-000000000001',
    );
  });

  describe('RULING 52: custom frequency requires rrule, other frequencies forbid it', () => {
    it('rejects custom frequency when rrule is omitted (422)', () => {
      expect(() =>
        createRecurringRuleCommand({
          ...VALID_REQUEST,
          frequency: 'custom',
          rrule: undefined,
        }),
      ).toThrow(RecurringCommandValidationError);

      try {
        createRecurringRuleCommand({
          ...VALID_REQUEST,
          frequency: 'custom',
          rrule: undefined,
        });
      } catch (e) {
        const err = e as RecurringCommandValidationError;
        expect(err.violations).toContainEqual(
          expect.objectContaining({
            field: 'rrule',
            code: 'required',
          }),
        );
      }
    });

    it('rejects custom frequency when rrule is null or empty (422)', () => {
      expect(() =>
        createRecurringRuleCommand({
          ...VALID_REQUEST,
          frequency: 'custom',
          rrule: null,
        }),
      ).toThrow(RecurringCommandValidationError);

      expect(() =>
        createRecurringRuleCommand({
          ...VALID_REQUEST,
          frequency: 'custom',
          rrule: '   ',
        }),
      ).toThrow(RecurringCommandValidationError);
    });

    it('rejects non-custom frequency when rrule is provided as a non-null string (422)', () => {
      expect(() =>
        createRecurringRuleCommand({
          ...VALID_REQUEST,
          frequency: 'monthly',
          rrule: 'FREQ=MONTHLY;INTERVAL=1',
        }),
      ).toThrow(RecurringCommandValidationError);

      try {
        createRecurringRuleCommand({
          ...VALID_REQUEST,
          frequency: 'monthly',
          rrule: 'FREQ=MONTHLY;INTERVAL=1',
        });
      } catch (e) {
        const err = e as RecurringCommandValidationError;
        expect(err.violations).toContainEqual(
          expect.objectContaining({
            field: 'rrule',
            code: 'not-allowed',
          }),
        );
      }
    });

    it('accepts non-custom frequency when rrule is explicitly null or omitted', () => {
      const cmd1 = createRecurringRuleCommand({
        ...VALID_REQUEST,
        frequency: 'daily',
        rrule: null,
      });
      expect(cmd1.rrule).toBeNull();

      const cmd2 = createRecurringRuleCommand({
        ...VALID_REQUEST,
        frequency: 'weekly',
      });
      expect(cmd2.rrule).toBeNull();
    });

    it('accepts custom frequency when valid rrule is provided', () => {
      const command = createRecurringRuleCommand({
        ...VALID_REQUEST,
        frequency: 'custom',
        rrule: 'FREQ=WEEKLY;INTERVAL=3',
        startsAt: '2026-08-01T12:00:00.000Z',
      });
      expect(command.frequency).toBe('custom');
      expect(command.rrule).toBe('FREQ=WEEKLY;INTERVAL=3');
      expect(command.nextOccurrenceAt).toBe('2026-08-22T12:00:00.000Z');
    });
  });

  describe('RULING 53: template is fully validated with prefixed violations', () => {
    it('surfaces violations when template is missing required fields (e.g. accountId, amount)', () => {
      try {
        createRecurringRuleCommand({
          ...VALID_REQUEST,
          template: {
            type: 'expense',
            occurredAt: '2026-08-29T12:00:00.000Z',
          },
        });
        expect.unreachable('Should have failed validation');
      } catch (e) {
        const err = e as RecurringCommandValidationError;
        expect(err.violations).toContainEqual(
          expect.objectContaining({
            field: 'template.accountId',
            code: 'required',
          }),
        );
        expect(err.violations).toContainEqual(
          expect.objectContaining({
            field: 'template.amount',
            code: 'required',
          }),
        );
      }
    });

    it('surfaces nested violations from inside template amount (amount.amountMinor)', () => {
      try {
        createRecurringRuleCommand({
          ...VALID_REQUEST,
          template: {
            ...VALID_TEMPLATE,
            amount: {
              amountMinor: 'not-a-number',
              currency: 'USD',
            },
          },
        });
        expect.unreachable('Should have failed validation');
      } catch (e) {
        const err = e as RecurringCommandValidationError;
        expect(err.violations).toContainEqual(
          expect.objectContaining({
            field: 'template.amount.amountMinor',
            code: 'invalid-format',
          }),
        );
      }
    });

    it('rejects unallowed properties inside template', () => {
      try {
        createRecurringRuleCommand({
          ...VALID_REQUEST,
          template: {
            ...VALID_TEMPLATE,
            forbiddenExtra: 'malicious',
          },
        });
        expect.unreachable('Should have failed validation');
      } catch (e) {
        const err = e as RecurringCommandValidationError;
        expect(err.violations).toContainEqual(
          expect.objectContaining({
            field: 'template.forbiddenExtra',
            code: 'not-allowed',
          }),
        );
      }
    });
  });

  describe('RULING 55: endsAt must be strictly after startsAt and rule must be fireable', () => {
    it('rejects endsAt earlier than startsAt (422)', () => {
      try {
        createRecurringRuleCommand({
          ...VALID_REQUEST,
          startsAt: '2026-08-29T12:00:00.000Z',
          endsAt: '2026-08-28T12:00:00.000Z',
        });
        expect.unreachable('Should have failed');
      } catch (e) {
        const err = e as RecurringCommandValidationError;
        expect(err.violations).toContainEqual(
          expect.objectContaining({
            field: 'endsAt',
            code: 'invalid-range',
          }),
        );
      }
    });

    it('rejects endsAt equal to startsAt (422)', () => {
      try {
        createRecurringRuleCommand({
          ...VALID_REQUEST,
          startsAt: '2026-08-29T12:00:00.000Z',
          endsAt: '2026-08-29T12:00:00.000Z',
        });
        expect.unreachable('Should have failed');
      } catch (e) {
        const err = e as RecurringCommandValidationError;
        expect(err.violations).toContainEqual(
          expect.objectContaining({
            field: 'endsAt',
            code: 'invalid-range',
          }),
        );
      }
    });

    it('rejects rule when nextOccurrenceAt falls after endsAt (unfireable rule 422)', () => {
      // startsAt: 2026-08-01, frequency: monthly -> next occurrence is 2026-09-01
      // endsAt: 2026-08-15 -> strictly after startsAt, but rule can NEVER fire before ending!
      try {
        createRecurringRuleCommand({
          ...VALID_REQUEST,
          frequency: 'monthly',
          startsAt: '2026-08-01T00:00:00.000Z',
          endsAt: '2026-08-15T00:00:00.000Z',
        });
        expect.unreachable('Should have failed');
      } catch (e) {
        const err = e as RecurringCommandValidationError;
        expect(err.violations).toContainEqual(
          expect.objectContaining({
            field: 'endsAt',
            code: 'unfireable-rule',
          }),
        );
      }
    });

    it('accepts endsAt when nextOccurrenceAt falls before or on endsAt', () => {
      const command = createRecurringRuleCommand({
        ...VALID_REQUEST,
        frequency: 'monthly',
        startsAt: '2026-08-01T00:00:00.000Z',
        endsAt: '2026-09-01T00:00:00.000Z',
      });
      expect(command.endsAt).toBe('2026-09-01T00:00:00.000Z');
      expect(command.nextOccurrenceAt).toBe('2026-09-01T00:00:00.000Z');
    });
  });

  describe('General input validation', () => {
    it('rejects non-object body', () => {
      expect(() => createRecurringRuleCommand(null)).toThrow(
        RecurringCommandValidationError,
      );
      expect(() => createRecurringRuleCommand([])).toThrow(
        RecurringCommandValidationError,
      );
      expect(() => createRecurringRuleCommand('string')).toThrow(
        RecurringCommandValidationError,
      );
    });

    it('rejects missing name or empty name', () => {
      try {
        createRecurringRuleCommand({
          ...VALID_REQUEST,
          name: '',
        });
        expect.unreachable('Should have failed');
      } catch (e) {
        const err = e as RecurringCommandValidationError;
        expect(err.violations).toContainEqual(
          expect.objectContaining({
            field: 'name',
            code: 'required',
          }),
        );
      }
    });

    it('rejects name exceeding 120 characters', () => {
      try {
        createRecurringRuleCommand({
          ...VALID_REQUEST,
          name: 'x'.repeat(121),
        });
        expect.unreachable('Should have failed');
      } catch (e) {
        const err = e as RecurringCommandValidationError;
        expect(err.violations).toContainEqual(
          expect.objectContaining({
            field: 'name',
            code: 'max-length',
          }),
        );
      }
    });

    it('rejects unsupported frequency', () => {
      try {
        createRecurringRuleCommand({
          ...VALID_REQUEST,
          frequency: 'hourly',
        });
        expect.unreachable('Should have failed');
      } catch (e) {
        const err = e as RecurringCommandValidationError;
        expect(err.violations).toContainEqual(
          expect.objectContaining({
            field: 'frequency',
            code: 'unsupported',
          }),
        );
      }
    });

    it('rejects unsupported behavior', () => {
      try {
        createRecurringRuleCommand({
          ...VALID_REQUEST,
          behavior: 'instant_charge',
        });
        expect.unreachable('Should have failed');
      } catch (e) {
        const err = e as RecurringCommandValidationError;
        expect(err.violations).toContainEqual(
          expect.objectContaining({
            field: 'behavior',
            code: 'unsupported',
          }),
        );
      }
    });

    it('rejects extra unallowed properties at top level', () => {
      try {
        createRecurringRuleCommand({
          ...VALID_REQUEST,
          extraField: 'not-allowed',
        });
        expect.unreachable('Should have failed');
      } catch (e) {
        const err = e as RecurringCommandValidationError;
        expect(err.violations).toContainEqual(
          expect.objectContaining({
            field: 'extraField',
            code: 'not-allowed',
          }),
        );
      }
    });
  });
});
