import { describe, expect, it } from 'vitest';
import {
  createDebtCommand,
  createDebtPaymentCommand,
  DebtCommandValidationError,
} from '../../src/debts/debt-command.js';

describe('createDebtCommand', () => {
  const validPayload = {
    name: 'Mortgage Loan',
    principal: {
      amountMinor: '25000000',
      currency: 'USD',
    },
    annualRate: '0.045000000000000000',
    rateType: 'fixed',
    minimumPayment: {
      amountMinor: '150000',
      currency: 'USD',
    },
    startDate: '2026-01-01',
    termMonths: 360,
  };

  it('accepts a valid full payload', () => {
    const result = createDebtCommand(validPayload);
    expect(result).toEqual({
      name: 'Mortgage Loan',
      principal: {
        amountMinor: '25000000',
        currency: 'USD',
      },
      annualRate: '0.045000000000000000',
      rateType: 'fixed',
      minimumPayment: {
        amountMinor: '150000',
        currency: 'USD',
      },
      startDate: '2026-01-01',
      termMonths: 360,
    });
  });

  it('accepts a valid minimal payload with optional fields omitted or null', () => {
    const minimal = {
      name: 'Car Loan',
      principal: {
        amountMinor: '500000',
        currency: 'EUR',
      },
      annualRate: '0.05',
      rateType: 'variable',
    };
    const result = createDebtCommand(minimal);
    expect(result).toEqual({
      name: 'Car Loan',
      principal: {
        amountMinor: '500000',
        currency: 'EUR',
      },
      annualRate: '0.05',
      rateType: 'variable',
      startDate: null,
      termMonths: null,
    });

    const withNulls = {
      ...minimal,
      minimumPayment: null,
      startDate: null,
      termMonths: null,
    };
    expect(createDebtCommand(withNulls)).toEqual({
      name: 'Car Loan',
      principal: {
        amountMinor: '500000',
        currency: 'EUR',
      },
      annualRate: '0.05',
      rateType: 'variable',
      startDate: null,
      termMonths: null,
    });
  });

  it('accepts an 18-decimal precision annualRate', () => {
    const rate18 = '4123.450000000000000000';
    const result = createDebtCommand({
      name: 'High Precision Debt',
      principal: { amountMinor: '10000', currency: 'USD' },
      annualRate: rate18,
      rateType: 'fixed',
    });
    expect(result.annualRate).toBe(rate18);
  });

  it('accepts zero annualRate for interest-free debt', () => {
    const result = createDebtCommand({
      name: 'Zero Interest Debt',
      principal: { amountMinor: '10000', currency: 'USD' },
      annualRate: '0',
      rateType: 'fixed',
    });
    expect(result.annualRate).toBe('0');
  });

  it('rejects negative annualRate', () => {
    expect(() =>
      createDebtCommand({
        ...validPayload,
        annualRate: '-0.05',
      }),
    ).toThrow(DebtCommandValidationError);
  });

  it('rejects non-decimal annualRate', () => {
    expect(() =>
      createDebtCommand({
        ...validPayload,
        annualRate: 'five-percent',
      }),
    ).toThrow(DebtCommandValidationError);
  });

  it('rejects invalid rateType', () => {
    expect(() =>
      createDebtCommand({
        ...validPayload,
        rateType: 'custom',
      }),
    ).toThrow(DebtCommandValidationError);
  });

  it('rejects minimumPayment with currency mismatching principal currency', () => {
    expect(() =>
      createDebtCommand({
        ...validPayload,
        minimumPayment: {
          amountMinor: '150000',
          currency: 'EUR',
        },
      }),
    ).toThrow(DebtCommandValidationError);
  });

  it('rejects termMonths less than 1', () => {
    expect(() =>
      createDebtCommand({
        ...validPayload,
        termMonths: 0,
      }),
    ).toThrow(DebtCommandValidationError);
  });

  it('rejects invalid startDate format', () => {
    expect(() =>
      createDebtCommand({
        ...validPayload,
        startDate: '01/01/2026',
      }),
    ).toThrow(DebtCommandValidationError);
  });

  it('rejects extra unexpected fields', () => {
    expect(() =>
      createDebtCommand({
        ...validPayload,
        unknownField: 'not-allowed',
      }),
    ).toThrow(DebtCommandValidationError);
  });

  it('rejects non-object input', () => {
    expect(() => createDebtCommand(null)).toThrow(DebtCommandValidationError);
    expect(() => createDebtCommand('invalid')).toThrow(DebtCommandValidationError);
  });
});

describe('createDebtPaymentCommand', () => {
  const accountId = 'a0000000-0000-4000-8000-000000000001';
  const validPaymentPayload = {
    accountId,
    totalAmount: { amountMinor: '5000', currency: 'USD' },
    principalAmount: { amountMinor: '3000', currency: 'USD' },
    interestAmount: { amountMinor: '1500', currency: 'USD' },
    feeAmount: { amountMinor: '500', currency: 'USD' },
    occurredAt: '2026-09-03T12:00:00Z',
  };

  it('accepts a valid payment with full split summing to totalAmount', () => {
    const result = createDebtPaymentCommand(validPaymentPayload);
    expect(result).toEqual({
      accountId,
      totalAmount: { amountMinor: '5000', currency: 'USD' },
      principalAmount: { amountMinor: '3000', currency: 'USD' },
      interestAmount: { amountMinor: '1500', currency: 'USD' },
      feeAmount: { amountMinor: '500', currency: 'USD' },
      occurredAt: '2026-09-03T12:00:00Z',
    });
  });

  it('accepts a payment with NO split supplied (principal will receive full amount)', () => {
    const noSplit = {
      accountId,
      totalAmount: { amountMinor: '5000', currency: 'USD' },
      occurredAt: '2026-09-03T12:00:00Z',
    };
    const result = createDebtPaymentCommand(noSplit);
    expect(result).toEqual({
      accountId,
      totalAmount: { amountMinor: '5000', currency: 'USD' },
      occurredAt: '2026-09-03T12:00:00Z',
    });
    expect(result.principalAmount).toBeUndefined();
    expect(result.interestAmount).toBeUndefined();
    expect(result.feeAmount).toBeUndefined();
  });

  it('rejects a split whose parts do not sum to totalAmount', () => {
    const mismatch = {
      ...validPaymentPayload,
      principalAmount: { amountMinor: '3000', currency: 'USD' },
      interestAmount: { amountMinor: '1000', currency: 'USD' },
      feeAmount: { amountMinor: '500', currency: 'USD' }, // 3000 + 1000 + 500 = 4500 != 5000
    };
    expect(() => createDebtPaymentCommand(mismatch)).toThrow(
      DebtCommandValidationError,
    );
  });

  it('treats absent split parts as zero when verifying sum', () => {
    const partialSplit = {
      accountId,
      totalAmount: { amountMinor: '5000', currency: 'USD' },
      principalAmount: { amountMinor: '5000', currency: 'USD' },
      occurredAt: '2026-09-03T12:00:00Z',
    };
    const result = createDebtPaymentCommand(partialSplit);
    expect(result.principalAmount?.amountMinor).toBe('5000');
    expect(result.interestAmount).toBeUndefined();
    expect(result.feeAmount).toBeUndefined();
  });

  it('rejects a partial split that does not sum to totalAmount', () => {
    const partialMismatch = {
      accountId,
      totalAmount: { amountMinor: '5000', currency: 'USD' },
      principalAmount: { amountMinor: '4000', currency: 'USD' },
      occurredAt: '2026-09-03T12:00:00Z',
    };
    expect(() => createDebtPaymentCommand(partialMismatch)).toThrow(
      DebtCommandValidationError,
    );
  });

  it('rejects negative split parts', () => {
    const negativeSplit = {
      accountId,
      totalAmount: { amountMinor: '5000', currency: 'USD' },
      principalAmount: { amountMinor: '-1000', currency: 'USD' },
      interestAmount: { amountMinor: '6000', currency: 'USD' },
      occurredAt: '2026-09-03T12:00:00Z',
    };
    expect(() => createDebtPaymentCommand(negativeSplit)).toThrow(
      DebtCommandValidationError,
    );
  });

  it('rejects zero or negative totalAmount', () => {
    expect(() =>
      createDebtPaymentCommand({
        ...validPaymentPayload,
        totalAmount: { amountMinor: '0', currency: 'USD' },
      }),
    ).toThrow(DebtCommandValidationError);

    expect(() =>
      createDebtPaymentCommand({
        ...validPaymentPayload,
        totalAmount: { amountMinor: '-500', currency: 'USD' },
      }),
    ).toThrow(DebtCommandValidationError);
  });

  it('rejects split currency mismatch with totalAmount currency', () => {
    const currencyMismatch = {
      ...validPaymentPayload,
      interestAmount: { amountMinor: '1500', currency: 'EUR' },
    };
    expect(() => createDebtPaymentCommand(currencyMismatch)).toThrow(
      DebtCommandValidationError,
    );
  });

  it('rejects invalid occurredAt date format', () => {
    expect(() =>
      createDebtPaymentCommand({
        ...validPaymentPayload,
        occurredAt: 'not-a-date',
      }),
    ).toThrow(DebtCommandValidationError);
  });

  it('rejects invalid accountId format', () => {
    expect(() =>
      createDebtPaymentCommand({
        ...validPaymentPayload,
        accountId: 'not-a-uuid',
      }),
    ).toThrow(DebtCommandValidationError);
  });

  it('rejects disallowed extra fields', () => {
    expect(() =>
      createDebtPaymentCommand({
        ...validPaymentPayload,
        notes: 'some note not in schema',
      }),
    ).toThrow(DebtCommandValidationError);
  });
});
