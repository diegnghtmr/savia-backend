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
    updateBudget: vi.fn(),
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

describe('BudgetService.updateBudget', () => {
  const BUDGET_ID = '00000000-0000-0000-0000-000000000123';
  const EXISTING_BUDGET = {
    id: BUDGET_ID,
    name: 'Old Name',
    method: 'envelope' as const,
    periodStart: '2026-01-01',
    periodEnd: '2026-02-01',
    currency: 'USD',
    allocations: [],
    version: 1,
  };

  it('returns forbidden if caller has non-editor/admin/owner role', async () => {
    const store = fakeStore('viewer');
    const service = new BudgetService(
      new FakeTransaction(),
      store,
      fakeIdempotencyStore(),
    );
    const outcome = await service.updateBudget(
      SUBJECT,
      WORKSPACE_ID,
      BUDGET_ID,
      { name: 'New Name' },
      IDEMPOTENCY_KEY,
      { kind: 'absent' },
    );
    expect(outcome.kind).toBe(BUDGET_OUTCOMES.FORBIDDEN);
  });

  it('returns not-found if budget does not exist in workspace', async () => {
    const store = fakeStore('owner');
    store.findBudget = vi.fn().mockResolvedValue(undefined);
    const service = new BudgetService(
      new FakeTransaction(),
      store,
      fakeIdempotencyStore(),
    );
    const outcome = await service.updateBudget(
      SUBJECT,
      WORKSPACE_ID,
      BUDGET_ID,
      { name: 'New Name' },
      IDEMPOTENCY_KEY,
      { kind: 'absent' },
    );
    expect(outcome.kind).toBe(BUDGET_OUTCOMES.NOT_FOUND);
  });

  it('returns precondition-failed when If-Match version does not match existing version', async () => {
    const store = fakeStore('owner');
    store.findBudget = vi.fn().mockResolvedValue(EXISTING_BUDGET);
    const service = new BudgetService(
      new FakeTransaction(),
      store,
      fakeIdempotencyStore(),
    );
    const outcome = await service.updateBudget(
      SUBJECT,
      WORKSPACE_ID,
      BUDGET_ID,
      { name: 'New Name' },
      IDEMPOTENCY_KEY,
      { kind: 'versions', versions: [2, 3] },
    );
    expect(outcome.kind).toBe('precondition-failed');
  });

  it('updates budget successfully when If-Match matches existing version', async () => {
    const store = fakeStore('owner');
    store.findBudget = vi.fn().mockResolvedValue(EXISTING_BUDGET);
    const updated = { ...EXISTING_BUDGET, name: 'New Name', version: 2 };
    store.updateBudget = vi.fn().mockResolvedValue(updated);
    const service = new BudgetService(
      new FakeTransaction(),
      store,
      fakeIdempotencyStore(),
    );
    const outcome = await service.updateBudget(
      SUBJECT,
      WORKSPACE_ID,
      BUDGET_ID,
      { name: 'New Name' },
      IDEMPOTENCY_KEY,
      { kind: 'versions', versions: [1] },
    );
    expect(outcome.kind).toBe('updated');
    if (outcome.kind === 'updated') {
      expect(outcome.budget.name).toBe('New Name');
      expect(outcome.budget.version).toBe(2);
    }
  });

  it('updates budget successfully on unconditional path (absent If-Match)', async () => {
    const store = fakeStore('owner');
    store.findBudget = vi.fn().mockResolvedValue(EXISTING_BUDGET);
    const updated = { ...EXISTING_BUDGET, name: 'Unconditional', version: 2 };
    store.updateBudget = vi.fn().mockResolvedValue(updated);
    const service = new BudgetService(
      new FakeTransaction(),
      store,
      fakeIdempotencyStore(),
    );
    const outcome = await service.updateBudget(
      SUBJECT,
      WORKSPACE_ID,
      BUDGET_ID,
      { name: 'Unconditional' },
      IDEMPOTENCY_KEY,
      { kind: 'absent' },
    );
    expect(outcome.kind).toBe('updated');
    if (outcome.kind === 'updated') {
      expect(outcome.budget.name).toBe('Unconditional');
      expect(outcome.budget.version).toBe(2);
    }
  });
});
