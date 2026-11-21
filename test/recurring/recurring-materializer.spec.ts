import { expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import {
  RecurringMaterializer,
  type DueOccurrence,
  type DueRule,
  type OccurrenceStore,
} from '../../src/recurring/recurring-materializer.js';

const due: DueOccurrence = {
  workspaceId: 'workspace',
  subject: 'creator',
  ruleId: 'rule',
  scheduledAt: '2024-02-29T23:30:00.000Z',
  asOf: '2024-04-01T00:00:00.000Z',
};
const rule: DueRule = {
  frequency: 'monthly',
  rrule: null,
  behavior: 'confirm_automatically',
  template: {
    accountId: 'account',
    type: 'expense',
    occurredAt: '2024-01-01T12:00:00.000Z',
    amount: { amountMinor: '100', currency: 'USD' },
    status: 'reconciled',
  },
  startsAt: '2024-02-01T01:30:00+02:00',
  endsAt: null,
  anchorDayOfMonth: 31,
};
const client: TransactionClient = { query: vi.fn() };

function setup(input = rule) {
  const store = {
    lockDue: vi.fn<OccurrenceStore['lockDue']>().mockResolvedValueOnce(input),
    record: vi.fn<OccurrenceStore['record']>().mockResolvedValue(undefined),
  };
  const createTransaction = vi.fn().mockResolvedValue({
    kind: 'created',
    transaction: { id: 'transaction' },
  });
  const materializer = new RecurringMaterializer(store, { createTransaction });
  return { materializer, store, createTransaction };
}

it.each([
  ['remind', null],
  ['create_draft', 'draft'],
  ['create_pending', 'pending'],
  ['confirm_automatically', 'confirmed'],
] as const)(
  'materializes %s once and preserves the 31st anchor',
  async (behavior, status) => {
    const { materializer, store, createTransaction } = setup({
      ...rule,
      behavior,
    });
    const id = await materializer.materialize(client, due);
    expect(id).toEqual(expect.any(String));
    if (status === null) expect(createTransaction).not.toHaveBeenCalled();
    else {
      expect(createTransaction).toHaveBeenCalledExactlyOnceWith(
        client,
        due.subject,
        due.workspaceId,
        {
          ...rule.template,
          occurredAt: due.scheduledAt,
          status,
          receiptId: null,
        },
        id,
      );
    }
    expect(await materializer.materialize(client, due)).toBeNull();
    expect(store.record).toHaveBeenCalledExactlyOnceWith(client, due, {
      id,
      behavior,
      transactionId: status === null ? null : 'transaction',
      nextOccurrenceAt: '2024-03-31T23:30:00.000Z',
    });
  },
);

it.each([
  ['yearly', '2023-02-28T23:30:00.000Z', null, '2024-02-29T23:30:00.000Z'],
  [
    'daily',
    '2024-03-10T01:30:00-05:00',
    '2024-03-11T06:30:00.000Z',
    '2024-03-11T06:30:00.000Z',
  ],
  ['daily', '2024-03-10T06:30:00.000Z', '2024-03-10T06:30:00.000Z', null],
] as const)(
  'advances %s in UTC from %s with an inclusive end',
  async (frequency, scheduledAt, endsAt, nextOccurrenceAt) => {
    const { materializer, store } = setup({
      ...rule,
      frequency,
      startsAt: '2020-02-29T23:30:00.000Z',
      anchorDayOfMonth: 29,
      endsAt,
    });
    await materializer.materialize(client, { ...due, scheduledAt });
    expect(store.record).toHaveBeenCalledWith(
      client,
      { ...due, scheduledAt },
      expect.objectContaining({ nextOccurrenceAt }),
    );
  },
);

it('does not attach the template receipt to a new transaction', async () => {
  const { materializer, createTransaction } = setup({
    ...rule,
    template: {
      ...rule.template,
      receiptId: '00000000-0000-4000-8000-000000000001',
    },
  });
  const id = await materializer.materialize(client, due);
  expect(createTransaction).toHaveBeenCalledExactlyOnceWith(
    client,
    due.subject,
    due.workspaceId,
    {
      ...rule.template,
      occurredAt: due.scheduledAt,
      status: 'confirmed',
      receiptId: null,
    },
    id,
  );
});

it('does not record or advance a failed ledger write', async () => {
  const { materializer, store, createTransaction } = setup();
  createTransaction.mockResolvedValue({ kind: 'account_closed' });
  await expect(materializer.materialize(client, due)).rejects.toThrow(
    'Recurring occurrence transaction was not created.',
  );
  expect(store.record).not.toHaveBeenCalled();
});
