import { describe, expect, it } from 'vitest';
import {
  createFundCommand,
  createFundContributionCommand,
  FundCommandValidationError,
} from '../../src/funds/fund-command.js';

describe('createFundCommand', () => {
  const validPayload = {
    name: 'Emergency Fund',
    currency: 'USD',
    targetAmount: {
      amountMinor: '100000',
      currency: 'USD',
    },
    targetDate: '2026-12-31',
    linkedAccountId: 'a0000000-0000-4000-8000-000000000001',
  };

  it('accepts a valid full payload', () => {
    const result = createFundCommand(validPayload);
    expect(result).toEqual({
      name: 'Emergency Fund',
      currency: 'USD',
      targetAmount: {
        amountMinor: '100000',
        currency: 'USD',
      },
      targetDate: '2026-12-31',
      linkedAccountId: 'a0000000-0000-4000-8000-000000000001',
    });
  });

  it('accepts a valid minimal payload with nullable fields omitted or null', () => {
    const minimal = {
      name: 'Holiday Savings',
      currency: 'EUR',
      targetAmount: {
        amountMinor: '50000',
        currency: 'EUR',
      },
    };
    const result = createFundCommand(minimal);
    expect(result).toEqual({
      name: 'Holiday Savings',
      currency: 'EUR',
      targetAmount: {
        amountMinor: '50000',
        currency: 'EUR',
      },
      targetDate: null,
      linkedAccountId: null,
    });

    const withNulls = {
      ...minimal,
      targetDate: null,
      linkedAccountId: null,
    };
    expect(createFundCommand(withNulls)).toEqual({
      name: 'Holiday Savings',
      currency: 'EUR',
      targetAmount: {
        amountMinor: '50000',
        currency: 'EUR',
      },
      targetDate: null,
      linkedAccountId: null,
    });
  });

  it('rejects non-object inputs', () => {
    for (const input of [null, undefined, 'string', 123, []]) {
      expect(() => createFundCommand(input)).toThrow(
        FundCommandValidationError,
      );
    }
  });

  it('rejects unknown fields', () => {
    expect(() =>
      createFundCommand({
        ...validPayload,
        extra: 'field',
      }),
    ).toThrow(FundCommandValidationError);
  });

  it('rejects missing or invalid name', () => {
    expect(() => createFundCommand({ ...validPayload, name: '' })).toThrow(
      FundCommandValidationError,
    );
    expect(() => createFundCommand({ ...validPayload, name: '   ' })).toThrow(
      FundCommandValidationError,
    );
    expect(() =>
      createFundCommand({ ...validPayload, name: 'a'.repeat(121) }),
    ).toThrow(FundCommandValidationError);
  });

  it('rejects invalid currency code', () => {
    expect(() =>
      createFundCommand({ ...validPayload, currency: 'XYZ' }),
    ).toThrow(FundCommandValidationError);
    expect(() =>
      createFundCommand({ ...validPayload, currency: 'XYZ9' }),
    ).toThrow(FundCommandValidationError);
  });

  it('rejects targetAmount with zero or negative amountMinor', () => {
    expect(() =>
      createFundCommand({
        ...validPayload,
        targetAmount: { amountMinor: '0', currency: 'USD' },
      }),
    ).toThrow(FundCommandValidationError);

    expect(() =>
      createFundCommand({
        ...validPayload,
        targetAmount: { amountMinor: '-1000', currency: 'USD' },
      }),
    ).toThrow(FundCommandValidationError);
  });

  it('rejects targetAmount currency mismatch with fund currency', () => {
    expect(() =>
      createFundCommand({
        ...validPayload,
        currency: 'USD',
        targetAmount: { amountMinor: '10000', currency: 'EUR' },
      }),
    ).toThrow(FundCommandValidationError);
  });

  it('rejects invalid targetDate', () => {
    expect(() =>
      createFundCommand({ ...validPayload, targetDate: '2026-02-30' }),
    ).toThrow(FundCommandValidationError);
    expect(() =>
      createFundCommand({ ...validPayload, targetDate: 'not-a-date' }),
    ).toThrow(FundCommandValidationError);
  });

  it('rejects invalid linkedAccountId', () => {
    expect(() =>
      createFundCommand({ ...validPayload, linkedAccountId: 'not-a-uuid' }),
    ).toThrow(FundCommandValidationError);
  });
});

describe('createFundContributionCommand', () => {
  const validPayload = {
    accountId: 'b0000000-0000-4000-8000-000000000001',
    amount: {
      amountMinor: '2500',
      currency: 'USD',
    },
    occurredAt: '2026-09-03T12:00:00Z',
    notes: 'Monthly contribution',
  };

  it('accepts a valid full payload', () => {
    const result = createFundContributionCommand(validPayload);
    expect(result).toEqual({
      accountId: 'b0000000-0000-4000-8000-000000000001',
      amount: {
        amountMinor: '2500',
        currency: 'USD',
      },
      occurredAt: '2026-09-03T12:00:00Z',
      notes: 'Monthly contribution',
    });
  });

  it('accepts a minimal payload with notes omitted or null', () => {
    const minimal = {
      accountId: 'b0000000-0000-4000-8000-000000000001',
      amount: {
        amountMinor: '2500',
        currency: 'USD',
      },
      occurredAt: '2026-09-03T12:00:00Z',
    };
    expect(createFundContributionCommand(minimal)).toEqual({
      ...minimal,
      notes: null,
    });

    expect(createFundContributionCommand({ ...minimal, notes: null })).toEqual({
      ...minimal,
      notes: null,
    });
  });

  it('rejects non-object inputs', () => {
    for (const input of [null, undefined, 123, 'str', []]) {
      expect(() => createFundContributionCommand(input)).toThrow(
        FundCommandValidationError,
      );
    }
  });

  it('rejects unknown fields', () => {
    expect(() =>
      createFundContributionCommand({ ...validPayload, unknown: true }),
    ).toThrow(FundCommandValidationError);
  });

  it('rejects invalid accountId', () => {
    expect(() =>
      createFundContributionCommand({ ...validPayload, accountId: 'bad' }),
    ).toThrow(FundCommandValidationError);
  });

  it('rejects amountMinor <= 0 or invalid format', () => {
    expect(() =>
      createFundContributionCommand({
        ...validPayload,
        amount: { amountMinor: '0', currency: 'USD' },
      }),
    ).toThrow(FundCommandValidationError);

    expect(() =>
      createFundContributionCommand({
        ...validPayload,
        amount: { amountMinor: '-500', currency: 'USD' },
      }),
    ).toThrow(FundCommandValidationError);

    expect(() =>
      createFundContributionCommand({
        ...validPayload,
        amount: { amountMinor: 'abc', currency: 'USD' },
      }),
    ).toThrow(FundCommandValidationError);
  });

  it('rejects invalid occurredAt format', () => {
    expect(() =>
      createFundContributionCommand({
        ...validPayload,
        occurredAt: '2026-09-03',
      }),
    ).toThrow(FundCommandValidationError);
    expect(() =>
      createFundContributionCommand({
        ...validPayload,
        occurredAt: 'not-date-time',
      }),
    ).toThrow(FundCommandValidationError);
  });

  it('rejects notes exceeding 500 characters', () => {
    expect(() =>
      createFundContributionCommand({
        ...validPayload,
        notes: 'x'.repeat(501),
      }),
    ).toThrow(FundCommandValidationError);
  });
});
