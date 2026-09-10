import { describe, expect, it, vi } from 'vitest';
import {
  BUDGET_OUTCOMES,
  type BudgetStore,
  type CreateBudgetRequest,
} from '../../src/budgets/budget.port.js';
import { BudgetService } from '../../src/budgets/budget.service.js';
import type { IdempotencyStore } from '../../src/platform/idempotency.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';

const SUBJECT = '00000000-0000-0000-0000-000000000901';
const WORKSPACE_ID = '00000000-0000-0000-0000-000000000951';
const IDEMPOTENCY_KEY = '00000000-0000-0000-0000-000000000801';
const CLIENT: TransactionClient = { query: vi.fn() };

class FakeTransaction {
  public async run<T>(
    _subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    return callback(CLIENT);
  }

  public async runRead<T>(
    _subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    return callback(CLIENT);
  }
}

function fakeStore(role = 'owner'): BudgetStore {
  return {
    readActiveRole: vi.fn().mockResolvedValue(role),
    readWorkspaceCurrency: vi.fn().mockResolvedValue('USD'),
    createBudget: vi.fn(),
    findBudget: vi.fn(),
    findSourceAllocations: vi.fn().mockResolvedValue([]),
    insertCopiedAllocations: vi.fn().mockResolvedValue(undefined),
    listBudgets: vi.fn().mockResolvedValue([]),
  };
}

function fakeIdempotencyStore(): IdempotencyStore {
  return {
    read: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(true),
  };
}

const VALID_COMMAND: CreateBudgetRequest = {
  name: 'Monthly Envelope',
  method: 'envelope',
  periodStart: '2026-01-01',
  periodEnd: '2026-02-01',
};

describe('BudgetService.createBudget', () => {
  it('answers currency_unsupported when the database refuses a budget whose currency has no recorded rate for an existing account', async () => {
    const store = fakeStore('owner');
    const triggerViolation = Object.assign(
      new Error(
        'budget currency requires exchange rates for all account currencies',
      ),
      {
        code: '23514',
        constraint: 'budgets_currency_requires_account_exchange_rates',
      },
    );
    const storeWithCreate = {
      ...store,
      createBudget: vi.fn().mockRejectedValue(triggerViolation),
    };
    const service = new BudgetService(
      new FakeTransaction(),
      storeWithCreate,
      fakeIdempotencyStore(),
    );

    const outcome = await service.createBudget(
      SUBJECT,
      WORKSPACE_ID,
      VALID_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(
      (BUDGET_OUTCOMES as Record<string, string>).CURRENCY_UNSUPPORTED ??
        'currency_unsupported',
    );
  });

  it('rethrows an unrelated check violation instead of mislabelling it as a currency problem', async () => {
    const store = fakeStore('owner');
    const otherViolation = Object.assign(new Error('some other check failed'), {
      code: '23514',
      constraint: 'budgets_check',
    });
    const storeWithCreate = {
      ...store,
      createBudget: vi.fn().mockRejectedValue(otherViolation),
    };
    const service = new BudgetService(
      new FakeTransaction(),
      storeWithCreate,
      fakeIdempotencyStore(),
    );

    await expect(
      service.createBudget(
        SUBJECT,
        WORKSPACE_ID,
        VALID_COMMAND,
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toThrow('some other check failed');
  });
});
