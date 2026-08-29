import { describe, expect, it, vi } from 'vitest';
import { computeRequestFingerprint } from '../../src/platform/idempotency.service.js';
import {
  CATALOG_CREATE_OUTCOMES,
  CATALOG_LIST_OUTCOMES,
  type CreateNamedResourceCommand,
  type Payee,
  type Tag,
} from '../../src/catalogs/catalogs.port.js';
import {
  CatalogsService,
  TagNameConflictError,
  PayeeNameConflictError,
  type CatalogsStore,
  type CatalogsTransaction,
} from '../../src/catalogs/catalogs.service.js';
import type { IdempotencyStore } from '../../src/platform/idempotency.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const IDEMPOTENCY_KEY = 'a0000000-0000-0000-0000-000000000001';

const MOCK_TAG: Tag = {
  id: '00000000-0000-0000-0000-000000001001',
  name: 'Groceries',
  archived: false,
};

const MOCK_PAYEE: Payee = {
  id: '00000000-0000-0000-0000-000000002001',
  name: 'Acme Supermarket',
  archived: false,
};

const TAG_COMMAND: CreateNamedResourceCommand = {
  name: 'Groceries',
};

const PAYEE_COMMAND: CreateNamedResourceCommand = {
  name: 'Acme Supermarket',
};

function createService(
  role: string | null | undefined = 'owner',
  existingIdempotency?: {
    requestFingerprint: string;
    responseStatus: number;
    responseEtag: string | null;
    responseBody: unknown;
  },
  storeTagError?: Error,
  storePayeeError?: Error,
) {
  const dummyClient = {} as TransactionClient;

  const mockTransaction: CatalogsTransaction = {
    run: vi.fn(async (_subj, cb) => cb(dummyClient)),
    runRead: vi.fn(async (_subj, cb) => cb(dummyClient)),
  };

  const mockStore: CatalogsStore = {
    readActiveRole: vi.fn().mockResolvedValue(role === null ? undefined : role),
    createTag: storeTagError
      ? vi.fn().mockRejectedValue(storeTagError)
      : vi.fn().mockResolvedValue(MOCK_TAG),
    listTags: vi
      .fn()
      .mockResolvedValue([
        { tag: MOCK_TAG, cursorAt: '2026-08-28T12:00:00.000000Z' },
      ]),
    createPayee: storePayeeError
      ? vi.fn().mockRejectedValue(storePayeeError)
      : vi.fn().mockResolvedValue(MOCK_PAYEE),
    listPayees: vi
      .fn()
      .mockResolvedValue([
        { payee: MOCK_PAYEE, cursorAt: '2026-08-28T12:00:00.000000Z' },
      ]),
  };

  const mockIdempotencyStore: IdempotencyStore = {
    read: vi.fn().mockResolvedValue(existingIdempotency),
    write: vi.fn().mockResolvedValue(true),
  };

  const service = new CatalogsService(
    mockTransaction,
    mockStore,
    mockIdempotencyStore,
  );

  return { service, mockStore, mockIdempotencyStore, mockTransaction };
}

describe('CatalogsService.createTag', () => {
  it('checks active role and returns FORBIDDEN if caller lacks editor+ role', async () => {
    const { service, mockStore, mockIdempotencyStore } =
      createService('viewer');

    const outcome = await service.createTag(
      SUBJECT,
      WORKSPACE_ID,
      TAG_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.FORBIDDEN);
    expect(mockStore.readActiveRole).toHaveBeenCalled();
    expect(mockIdempotencyStore.read).not.toHaveBeenCalled();
    expect(mockStore.createTag).not.toHaveBeenCalled();
  });

  it('checks active role and returns FORBIDDEN if caller is not a member', async () => {
    const { service, mockStore } = createService(null);

    const outcome = await service.createTag(
      SUBJECT,
      WORKSPACE_ID,
      TAG_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.FORBIDDEN);
    expect(mockStore.createTag).not.toHaveBeenCalled();
  });

  it('creates tag successfully and records idempotency', async () => {
    const { service, mockStore, mockIdempotencyStore } =
      createService('editor');

    const outcome = await service.createTag(
      SUBJECT,
      WORKSPACE_ID,
      TAG_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
    if (outcome.kind === CATALOG_CREATE_OUTCOMES.CREATED) {
      expect(outcome.tag).toEqual(MOCK_TAG);
    }
    expect(mockStore.createTag).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      SUBJECT,
      TAG_COMMAND,
    );
    expect(mockIdempotencyStore.write).toHaveBeenCalledWith(
      expect.anything(),
      SUBJECT,
      'POST /v1/tags',
      IDEMPOTENCY_KEY,
      computeRequestFingerprint(TAG_COMMAND),
      201,
      null,
      MOCK_TAG,
      WORKSPACE_ID,
    );
  });

  it('returns REPLAYED when idempotency record with same fingerprint exists', async () => {
    const fingerprint = computeRequestFingerprint(TAG_COMMAND);
    const { service, mockStore } = createService('owner', {
      requestFingerprint: fingerprint,
      responseStatus: 201,
      responseEtag: null,
      responseBody: MOCK_TAG,
    });

    const outcome = await service.createTag(
      SUBJECT,
      WORKSPACE_ID,
      TAG_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.REPLAYED);
    if (outcome.kind === CATALOG_CREATE_OUTCOMES.REPLAYED) {
      expect(outcome.status).toBe(201);
      expect(outcome.body).toEqual(MOCK_TAG);
    }
    expect(mockStore.createTag).not.toHaveBeenCalled();
  });

  it('returns IDEMPOTENCY_CONFLICT when idempotency key is reused with different payload', async () => {
    const { service, mockStore } = createService('owner', {
      requestFingerprint: 'different-fingerprint',
      responseStatus: 201,
      responseEtag: null,
      responseBody: MOCK_TAG,
    });

    const outcome = await service.createTag(
      SUBJECT,
      WORKSPACE_ID,
      TAG_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT);
    expect(mockStore.createTag).not.toHaveBeenCalled();
  });

  it('returns CONFLICT when unique constraint is violated (duplicate tag name in workspace)', async () => {
    const { service } = createService(
      'owner',
      undefined,
      new TagNameConflictError(),
    );

    const outcome = await service.createTag(
      SUBJECT,
      WORKSPACE_ID,
      TAG_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CONFLICT);
  });
});

describe('CatalogsService.createPayee', () => {
  it('checks active role and returns FORBIDDEN if caller lacks editor+ role', async () => {
    const { service, mockStore } = createService('viewer');

    const outcome = await service.createPayee(
      SUBJECT,
      WORKSPACE_ID,
      PAYEE_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.FORBIDDEN);
    expect(mockStore.createPayee).not.toHaveBeenCalled();
  });

  it('creates payee successfully and records idempotency', async () => {
    const { service, mockStore, mockIdempotencyStore } =
      createService('administrator');

    const outcome = await service.createPayee(
      SUBJECT,
      WORKSPACE_ID,
      PAYEE_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CREATED);
    if (outcome.kind === CATALOG_CREATE_OUTCOMES.CREATED) {
      expect(outcome.payee).toEqual(MOCK_PAYEE);
    }
    expect(mockStore.createPayee).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      SUBJECT,
      PAYEE_COMMAND,
    );
    expect(mockIdempotencyStore.write).toHaveBeenCalledWith(
      expect.anything(),
      SUBJECT,
      'POST /v1/payees',
      IDEMPOTENCY_KEY,
      computeRequestFingerprint(PAYEE_COMMAND),
      201,
      null,
      MOCK_PAYEE,
      WORKSPACE_ID,
    );
  });

  it('returns REPLAYED when idempotency record with same fingerprint exists', async () => {
    const fingerprint = computeRequestFingerprint(PAYEE_COMMAND);
    const { service, mockStore } = createService('owner', {
      requestFingerprint: fingerprint,
      responseStatus: 201,
      responseEtag: null,
      responseBody: MOCK_PAYEE,
    });

    const outcome = await service.createPayee(
      SUBJECT,
      WORKSPACE_ID,
      PAYEE_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.REPLAYED);
    if (outcome.kind === CATALOG_CREATE_OUTCOMES.REPLAYED) {
      expect(outcome.status).toBe(201);
      expect(outcome.body).toEqual(MOCK_PAYEE);
    }
    expect(mockStore.createPayee).not.toHaveBeenCalled();
  });

  it('returns IDEMPOTENCY_CONFLICT when idempotency key is reused with different payload', async () => {
    const { service, mockStore } = createService('owner', {
      requestFingerprint: 'different-fingerprint',
      responseStatus: 201,
      responseEtag: null,
      responseBody: MOCK_PAYEE,
    });

    const outcome = await service.createPayee(
      SUBJECT,
      WORKSPACE_ID,
      PAYEE_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT);
    expect(mockStore.createPayee).not.toHaveBeenCalled();
  });

  it('returns CONFLICT when unique constraint is violated (duplicate payee name in workspace)', async () => {
    const { service } = createService(
      'owner',
      undefined,
      undefined,
      new PayeeNameConflictError(),
    );

    const outcome = await service.createPayee(
      SUBJECT,
      WORKSPACE_ID,
      PAYEE_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(CATALOG_CREATE_OUTCOMES.CONFLICT);
  });
});

describe('CatalogsService.listTags', () => {
  it('returns FORBIDDEN when caller is not an active workspace member', async () => {
    const { service, mockStore } = createService(null);

    const outcome = await service.listTags(SUBJECT, {
      workspaceId: WORKSPACE_ID,
      limit: 50,
    });

    expect(outcome.kind).toBe(CATALOG_LIST_OUTCOMES.FORBIDDEN);
    expect(mockStore.listTags).not.toHaveBeenCalled();
  });

  it('admits viewer role and returns paginated tags with nextCursor null when no more pages', async () => {
    const { service } = createService('viewer');

    const outcome = await service.listTags(SUBJECT, {
      workspaceId: WORKSPACE_ID,
      limit: 50,
    });

    expect(outcome.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
    if (outcome.kind === CATALOG_LIST_OUTCOMES.OK) {
      expect(outcome.page.items).toEqual([MOCK_TAG]);
      expect(outcome.page.pageInfo.hasNextPage).toBe(false);
      expect(outcome.page.pageInfo.nextCursor).toBeNull();
    }
  });

  it('computes nextCursor when more items exist than limit', async () => {
    const { service, mockStore } = createService('owner');
    mockStore.listTags = vi.fn().mockResolvedValue([
      {
        tag: {
          id: '00000000-0000-0000-0000-000000000001',
          name: 'Tag1',
          archived: false,
        },
        cursorAt: '2026-08-28T12:00:00.000000Z',
      },
      {
        tag: {
          id: '00000000-0000-0000-0000-000000000002',
          name: 'Tag2',
          archived: false,
        },
        cursorAt: '2026-08-28T12:01:00.000000Z',
      },
    ]);

    const outcome = await service.listTags(SUBJECT, {
      workspaceId: WORKSPACE_ID,
      limit: 1,
    });

    expect(outcome.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
    if (outcome.kind === CATALOG_LIST_OUTCOMES.OK) {
      expect(outcome.page.items).toHaveLength(1);
      expect(outcome.page.pageInfo.hasNextPage).toBe(true);
      expect(outcome.page.pageInfo.nextCursor).not.toBeNull();
    }
  });
});

describe('CatalogsService.listPayees', () => {
  it('returns FORBIDDEN when caller is not an active workspace member', async () => {
    const { service, mockStore } = createService(null);

    const outcome = await service.listPayees(SUBJECT, {
      workspaceId: WORKSPACE_ID,
      limit: 50,
    });

    expect(outcome.kind).toBe(CATALOG_LIST_OUTCOMES.FORBIDDEN);
    expect(mockStore.listPayees).not.toHaveBeenCalled();
  });

  it('admits viewer role and returns paginated payees', async () => {
    const { service } = createService('viewer');

    const outcome = await service.listPayees(SUBJECT, {
      workspaceId: WORKSPACE_ID,
      limit: 50,
    });

    expect(outcome.kind).toBe(CATALOG_LIST_OUTCOMES.OK);
    if (outcome.kind === CATALOG_LIST_OUTCOMES.OK) {
      expect(outcome.page.items).toEqual([MOCK_PAYEE]);
      expect(outcome.page.pageInfo.hasNextPage).toBe(false);
      expect(outcome.page.pageInfo.nextCursor).toBeNull();
    }
  });
});
