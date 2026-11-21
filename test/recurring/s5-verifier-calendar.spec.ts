import { expect, it, vi } from 'vitest';
import {
  RecurringMaterializer,
  type DueRule,
} from '../../src/recurring/recurring-materializer.js';

it.each([
  [
    'monthly',
    'create_draft',
    '2024-01-31T23:59:59.999Z',
    '2024-02-29T18:59:59.999-05:00',
    '2024-02-29T23:59:59.999Z',
    'draft',
  ],
  [
    'monthly',
    'create_pending',
    '2024-02-29T23:59:59.999Z',
    '2024-03-31T23:59:59.998Z',
    null,
    'pending',
  ],
  [
    'yearly',
    'confirm_automatically',
    '2099-02-28T23:59:59.999Z',
    null,
    '2100-02-28T23:59:59.999Z',
    'confirmed',
  ],
  [
    'daily',
    'remind',
    '2024-03-10T01:00:00.000-05:00',
    null,
    '2024-03-11T06:00:00.000Z',
    null,
  ],
] as const)(
  'S5 %s %s advances UTC cursor with inclusive end',
  async (
    frequency,
    behavior,
    scheduledAt,
    endsAt,
    nextOccurrenceAt,
    status,
  ) => {
    const rule: DueRule = {
      frequency,
      behavior,
      endsAt,
      rrule: null,
      startsAt:
        frequency === 'yearly'
          ? '2096-02-29T23:59:59.999Z'
          : '2023-12-31T23:59:59.999Z',
      anchorDayOfMonth: frequency === 'yearly' ? 29 : 31,
      template: {
        type: 'expense',
        accountId: 'account',
        amount: { amountMinor: '105', currency: 'USD' },
        status: 'confirmed',
        occurredAt: '2023-12-31T23:59:59.999Z',
        receiptId: 'receipt',
      },
    };
    const lockDue = vi.fn().mockResolvedValue(rule);
    const record = vi.fn().mockResolvedValue(undefined);
    const createTransaction = vi
      .fn()
      .mockResolvedValue({ kind: 'created', transaction: { id: 'booked' } });
    const materializer = new RecurringMaterializer(
      { lockDue, record },
      { createTransaction },
    );
    const client = { query: vi.fn() };
    const due = {
      workspaceId: 'workspace',
      subject: 'creator',
      ruleId: 'rule',
      scheduledAt,
      asOf: scheduledAt,
    };
    const id = await materializer.materialize(client, due);
    expect(record).toHaveBeenCalledExactlyOnceWith(client, due, {
      id,
      behavior,
      nextOccurrenceAt,
      transactionId: status === null ? null : 'booked',
    });
    if (status === null) expect(createTransaction).not.toHaveBeenCalled();
    else
      expect(createTransaction).toHaveBeenCalledExactlyOnceWith(
        client,
        'creator',
        'workspace',
        {
          ...rule.template,
          status,
          receiptId: null,
          occurredAt: new Date(scheduledAt).toISOString(),
        },
        id,
      );
  },
);
