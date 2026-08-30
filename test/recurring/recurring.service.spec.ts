import { describe, expect, it, vi } from 'vitest';
import { decodeCursor } from '../../src/platform/cursor.js';
import { computeRequestFingerprint } from '../../src/platform/idempotency.service.js';
import {
  RECURRING_CREATE_OUTCOMES,
  RECURRING_LIST_OUTCOMES,
  SUBSCRIPTION_LIST_OUTCOMES,
  type CreateRecurringRuleCommand,
  type RecurringRule,
  type Subscription,
} from '../../src/recurring/recurring.port.js';
import {
  RecurringAccountNotFoundError,
  RecurringService,
  type RecurringStore,
  type RecurringTransaction,
} from '../../src/recurring/recurring.service.js';
import type { IdempotencyStore } from '../../src/platform/idempotency.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const IDEMPOTENCY_KEY = 'a0000000-0000-0000-0000-000000000001';

const MOCK_RULE: RecurringRule = {
  id: '00000000-0000-0000-0000-000000001001',
  name: 'Monthly Netflix',
  frequency: 'monthly',
  rrule: null,
  behavior: 'create_draft',
  template: {
    type: 'expense',
    accountId: '00000000-0000-0000-0000-000000002001',
    amount: {
      amountMinor: '1599',
      currency: 'USD',
    },
    occurredAt: '2026-08-29T12:00:00.000Z',
    status: 'draft',
    categoryId: '00000000-0000-0000-0000-000000003001',
    payeeId: '00000000-0000-0000-0000-000000004001',
    description: 'Streaming service',
    notes: null,
    tagIds: ['00000000-0000-0000-0000-000000005001'],
    receiptId: null,
  },
  active: true,
  nextOccurrenceAt: '2026-09-29T12:00:00.000Z',
};

const MOCK_SUBSCRIPTION: Subscription = {
  id: '00000000-0000-0000-0000-000000006001',
  payeeName: 'Spotify',
  currentAmount: {
    amountMinor: '999',
    currency: 'USD',
  },
  previousAmount: {
    amountMinor: '899',
    currency: 'USD',
  },
  increasePercent: 11.12,
  frequency: 'monthly',
  nextExpectedAt: '2026-09-29T12:00:00.000Z',
  status: 'confirmed',
};

const CREATE_COMMAND: CreateRecurringRuleCommand = {
  name: 'Monthly Netflix',
  frequency: 'monthly',
  rrule: null,
  behavior: 'create_draft',
  template: MOCK_RULE.template,
  startsAt: '2026-08-29T12:00:00.000Z',
  endsAt: null,
  nextOccurrenceAt: '2026-09-29T12:00:00.000Z',
  anchorDayOfMonth: 29,
};

function createService(
  role: string | null | undefined = 'owner',
  categoryBelongs = true,
  payeeBelongs = true,
  tagsBelong = true,
  storeError?: Error,
  existingIdempotency?: {
    requestFingerprint: string;
    responseStatus: number;
    responseEtag: string | null;
    responseBody: unknown;
  },
) {
  const dummyClient = {} as TransactionClient;

  const mockTransaction: RecurringTransaction = {
    run: vi.fn(async (_subj, cb) => cb(dummyClient)),
    runRead: vi.fn(async (_subj, cb) => cb(dummyClient)),
  };

  const mockStore: RecurringStore = {
    readActiveRole: vi.fn().mockResolvedValue(role === null ? undefined : role),
    categoryBelongsToWorkspace: vi.fn().mockResolvedValue(categoryBelongs),
    payeeBelongsToWorkspace: vi.fn().mockResolvedValue(payeeBelongs),
    tagsBelongToWorkspace: vi.fn().mockResolvedValue(tagsBelong),
    createRecurringRule: storeError
      ? vi.fn().mockRejectedValue(storeError)
      : vi.fn().mockResolvedValue(MOCK_RULE),
    listRecurringRules: vi
      .fn()
      .mockResolvedValue([
        { rule: MOCK_RULE, cursorAt: '2026-08-29T12:00:00.000000Z' },
      ]),
    listSubscriptions: vi.fn().mockResolvedValue([
      {
        subscription: MOCK_SUBSCRIPTION,
        cursorAt: '2026-08-29T12:00:00.000000Z',
      },
    ]),
  };

  const mockIdempotencyStore: IdempotencyStore = {
    write: vi.fn().mockResolvedValue(!existingIdempotency),
    read: vi.fn().mockResolvedValue(existingIdempotency),
  };

  const service = new RecurringService(
    mockTransaction,
    mockStore,
    mockIdempotencyStore,
  );

  return { service, mockStore, mockIdempotencyStore, mockTransaction };
}

describe('RecurringService', () => {
  describe('createRecurringRule', () => {
    it('answers forbidden when subject has no active role in workspace', async () => {
      const { service, mockStore } = createService(null);
      const outcome = await service.createRecurringRule(
        SUBJECT,
        WORKSPACE_ID,
        CREATE_COMMAND,
        IDEMPOTENCY_KEY,
      );

      expect(outcome.kind).toBe(RECURRING_CREATE_OUTCOMES.FORBIDDEN);
      expect(mockStore.createRecurringRule).not.toHaveBeenCalled();
    });

    it('answers forbidden when subject is only a viewer', async () => {
      const { service, mockStore } = createService('viewer');
      const outcome = await service.createRecurringRule(
        SUBJECT,
        WORKSPACE_ID,
        CREATE_COMMAND,
        IDEMPOTENCY_KEY,
      );

      expect(outcome.kind).toBe(RECURRING_CREATE_OUTCOMES.FORBIDDEN);
      expect(mockStore.createRecurringRule).not.toHaveBeenCalled();
    });

    it('answers category_not_found when template category does not belong to workspace (RULING 53)', async () => {
      const { service, mockStore } = createService(
        'owner',
        false, // categoryBelongs = false
      );
      const outcome = await service.createRecurringRule(
        SUBJECT,
        WORKSPACE_ID,
        CREATE_COMMAND,
        IDEMPOTENCY_KEY,
      );

      expect(outcome.kind).toBe(RECURRING_CREATE_OUTCOMES.CATEGORY_NOT_FOUND);
      expect(mockStore.createRecurringRule).not.toHaveBeenCalled();
    });

    it('answers payee_not_found when template payee does not belong to workspace (RULING 53)', async () => {
      const { service, mockStore } = createService(
        'owner',
        true,
        false, // payeeBelongs = false
      );
      const outcome = await service.createRecurringRule(
        SUBJECT,
        WORKSPACE_ID,
        CREATE_COMMAND,
        IDEMPOTENCY_KEY,
      );

      expect(outcome.kind).toBe(RECURRING_CREATE_OUTCOMES.PAYEE_NOT_FOUND);
      expect(mockStore.createRecurringRule).not.toHaveBeenCalled();
    });

    it('answers tag_not_found when template tags do not belong to workspace (RULING 53)', async () => {
      const { service, mockStore } = createService(
        'owner',
        true,
        true,
        false, // tagsBelong = false
      );
      const outcome = await service.createRecurringRule(
        SUBJECT,
        WORKSPACE_ID,
        CREATE_COMMAND,
        IDEMPOTENCY_KEY,
      );

      expect(outcome.kind).toBe(RECURRING_CREATE_OUTCOMES.TAG_NOT_FOUND);
      expect(mockStore.createRecurringRule).not.toHaveBeenCalled();
    });

    it('answers account_not_found when DB composite FK to account fails (RULING 53)', async () => {
      const { service } = createService(
        'owner',
        true,
        true,
        true,
        new RecurringAccountNotFoundError(),
      );
      const outcome = await service.createRecurringRule(
        SUBJECT,
        WORKSPACE_ID,
        CREATE_COMMAND,
        IDEMPOTENCY_KEY,
      );

      expect(outcome.kind).toBe(RECURRING_CREATE_OUTCOMES.ACCOUNT_NOT_FOUND);
    });

    it('creates rule and records idempotency when authorized and valid', async () => {
      const { service, mockStore, mockIdempotencyStore } =
        createService('owner');
      const outcome = await service.createRecurringRule(
        SUBJECT,
        WORKSPACE_ID,
        CREATE_COMMAND,
        IDEMPOTENCY_KEY,
      );

      expect(outcome.kind).toBe(RECURRING_CREATE_OUTCOMES.CREATED);
      if (outcome.kind === RECURRING_CREATE_OUTCOMES.CREATED) {
        expect(outcome.rule).toEqual(MOCK_RULE);
      }
      expect(mockStore.createRecurringRule).toHaveBeenCalled();
      expect(mockIdempotencyStore.write).toHaveBeenCalledWith(
        expect.anything(),
        SUBJECT,
        'POST /v1/recurring-rules',
        IDEMPOTENCY_KEY,
        computeRequestFingerprint(CREATE_COMMAND),
        201,
        null,
        MOCK_RULE,
        WORKSPACE_ID,
      );
    });

    it('replays response when identical request is submitted with same idempotency key', async () => {
      const fingerprint = computeRequestFingerprint(CREATE_COMMAND);
      const { service, mockStore } = createService(
        'owner',
        true,
        true,
        true,
        undefined,
        {
          requestFingerprint: fingerprint,
          responseStatus: 201,
          responseEtag: null,
          responseBody: MOCK_RULE,
        },
      );

      const outcome = await service.createRecurringRule(
        SUBJECT,
        WORKSPACE_ID,
        CREATE_COMMAND,
        IDEMPOTENCY_KEY,
      );

      expect(outcome.kind).toBe(RECURRING_CREATE_OUTCOMES.REPLAYED);
      if (outcome.kind === RECURRING_CREATE_OUTCOMES.REPLAYED) {
        expect(outcome.status).toBe(201);
        expect(outcome.body).toEqual(MOCK_RULE);
      }
      expect(mockStore.createRecurringRule).not.toHaveBeenCalled();
    });

    it('conflicts when idempotency key is reused with different request body', async () => {
      const { service, mockStore } = createService(
        'owner',
        true,
        true,
        true,
        undefined,
        {
          requestFingerprint: 'different-fingerprint-sha256',
          responseStatus: 201,
          responseEtag: null,
          responseBody: MOCK_RULE,
        },
      );

      const outcome = await service.createRecurringRule(
        SUBJECT,
        WORKSPACE_ID,
        CREATE_COMMAND,
        IDEMPOTENCY_KEY,
      );

      expect(outcome.kind).toBe(RECURRING_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT);
      expect(mockStore.createRecurringRule).not.toHaveBeenCalled();
    });
  });

  describe('listRecurringRules', () => {
    it('answers forbidden when subject has no active role in workspace', async () => {
      const { service } = createService(null);
      const outcome = await service.listRecurringRules(SUBJECT, {
        workspaceId: WORKSPACE_ID,
        limit: 50,
      });

      expect(outcome.kind).toBe(RECURRING_LIST_OUTCOMES.FORBIDDEN);
    });

    it('returns items and pageInfo for viewer or editor or owner', async () => {
      const { service } = createService('viewer');
      const outcome = await service.listRecurringRules(SUBJECT, {
        workspaceId: WORKSPACE_ID,
        limit: 50,
      });

      expect(outcome.kind).toBe(RECURRING_LIST_OUTCOMES.OK);
      if (outcome.kind === RECURRING_LIST_OUTCOMES.OK) {
        expect(outcome.page.items).toEqual([MOCK_RULE]);
        expect(outcome.page.pageInfo.hasNextPage).toBe(false);
        expect(outcome.page.pageInfo.nextCursor).toBeNull();
      }
    });

    it('emits nextCursor when rows exceed limit', async () => {
      const { service, mockStore } = createService('owner');
      mockStore.listRecurringRules = vi.fn().mockResolvedValue([
        { rule: MOCK_RULE, cursorAt: '2026-08-29T12:00:00.000000Z' },
        {
          rule: { ...MOCK_RULE, id: '00000000-0000-0000-0000-000000001002' },
          cursorAt: '2026-08-29T13:00:00.000000Z',
        },
      ]);

      const outcome = await service.listRecurringRules(SUBJECT, {
        workspaceId: WORKSPACE_ID,
        limit: 1,
      });

      expect(outcome.kind).toBe(RECURRING_LIST_OUTCOMES.OK);
      if (outcome.kind === RECURRING_LIST_OUTCOMES.OK) {
        expect(outcome.page.items).toHaveLength(1);
        expect(outcome.page.pageInfo.hasNextPage).toBe(true);
        expect(outcome.page.pageInfo.nextCursor).not.toBeNull();

        const decoded = decodeCursor(
          outcome.page.pageInfo.nextCursor!,
          WORKSPACE_ID,
        );
        expect(decoded).toEqual({
          workspaceId: WORKSPACE_ID,
          createdAt: '2026-08-29T12:00:00.000000Z',
          id: MOCK_RULE.id,
        });
      }
    });
  });

  describe('listSubscriptions', () => {
    it('returns FORBIDDEN when user has no active role or is non-member', async () => {
      const { service } = createService(null);
      const outcome = await service.listSubscriptions(SUBJECT, {
        workspaceId: WORKSPACE_ID,
        limit: 50,
      });

      expect(outcome.kind).toBe(SUBSCRIPTION_LIST_OUTCOMES.FORBIDDEN);
    });

    it('returns items and pageInfo for viewer or editor or owner', async () => {
      const { service } = createService('viewer');
      const outcome = await service.listSubscriptions(SUBJECT, {
        workspaceId: WORKSPACE_ID,
        limit: 50,
        status: 'confirmed',
      });

      expect(outcome.kind).toBe(SUBSCRIPTION_LIST_OUTCOMES.OK);
      if (outcome.kind === SUBSCRIPTION_LIST_OUTCOMES.OK) {
        expect(outcome.page.items).toEqual([MOCK_SUBSCRIPTION]);
        expect(outcome.page.pageInfo.hasNextPage).toBe(false);
        expect(outcome.page.pageInfo.nextCursor).toBeNull();
      }
    });

    it('emits nextCursor when subscription rows exceed limit', async () => {
      const { service, mockStore } = createService('owner');
      mockStore.listSubscriptions = vi.fn().mockResolvedValue([
        {
          subscription: MOCK_SUBSCRIPTION,
          cursorAt: '2026-08-29T12:00:00.000000Z',
        },
        {
          subscription: {
            ...MOCK_SUBSCRIPTION,
            id: '00000000-0000-0000-0000-000000006002',
          },
          cursorAt: '2026-08-29T13:00:00.000000Z',
        },
      ]);

      const outcome = await service.listSubscriptions(SUBJECT, {
        workspaceId: WORKSPACE_ID,
        limit: 1,
      });

      expect(outcome.kind).toBe(SUBSCRIPTION_LIST_OUTCOMES.OK);
      if (outcome.kind === SUBSCRIPTION_LIST_OUTCOMES.OK) {
        expect(outcome.page.items).toHaveLength(1);
        expect(outcome.page.pageInfo.hasNextPage).toBe(true);
        const decoded = decodeCursor(
          outcome.page.pageInfo.nextCursor!,
          WORKSPACE_ID,
          null,
        );
        expect(decoded).toEqual({
          workspaceId: WORKSPACE_ID,
          createdAt: '2026-08-29T12:00:00.000000Z',
          id: MOCK_SUBSCRIPTION.id,
          filter: null,
        });
      }
    });

    it('emits nextCursor binding the specific status filter when filtered', async () => {
      const { service, mockStore } = createService('owner');
      mockStore.listSubscriptions = vi.fn().mockResolvedValue([
        {
          subscription: MOCK_SUBSCRIPTION,
          cursorAt: '2026-08-29T12:00:00.000000Z',
        },
        {
          subscription: {
            ...MOCK_SUBSCRIPTION,
            id: '00000000-0000-0000-0000-000000006002',
          },
          cursorAt: '2026-08-29T13:00:00.000000Z',
        },
      ]);

      const outcome = await service.listSubscriptions(SUBJECT, {
        workspaceId: WORKSPACE_ID,
        limit: 1,
        status: 'confirmed',
      });

      expect(outcome.kind).toBe(SUBSCRIPTION_LIST_OUTCOMES.OK);
      if (outcome.kind === SUBSCRIPTION_LIST_OUTCOMES.OK) {
        expect(outcome.page.items).toHaveLength(1);
        expect(outcome.page.pageInfo.hasNextPage).toBe(true);
        expect(outcome.page.pageInfo.nextCursor).not.toBeNull();

        const decoded = decodeCursor(
          outcome.page.pageInfo.nextCursor!,
          WORKSPACE_ID,
          'confirmed',
        );
        expect(decoded).toEqual({
          workspaceId: WORKSPACE_ID,
          createdAt: '2026-08-29T12:00:00.000000Z',
          id: MOCK_SUBSCRIPTION.id,
          filter: 'confirmed',
        });
      }
    });
  });
});
