import { describe, expect, it, vi } from 'vitest';

import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import type {
  IdempotencyRecord,
  IdempotencyStore,
} from '../../src/identity/idempotency.port.js';
import { computeRequestFingerprint } from '../../src/identity/idempotency.service.js';
import type { WorkspaceCreateCommand } from '../../src/identity/workspace-command.js';
import {
  WORKSPACE_CREATE_OUTCOME_KINDS,
  type Workspace,
} from '../../src/identity/workspace.port.js';
import {
  WorkspaceService,
  type WorkspaceRecord,
  type WorkspaceStore,
  type WorkspaceTransaction,
} from '../../src/identity/workspace.service.js';

describe('WorkspaceService', () => {
  const dummySubject = '3f084ac5-18a6-4e09-920d-2e3da29df7c8';
  const dummyClient = {} as TransactionClient;

  const validCommand: WorkspaceCreateCommand = {
    name: 'Acme Family',
    kind: 'family',
    baseCurrency: 'USD',
  };
  const idempotencyKey = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb01';
  const fingerprint = computeRequestFingerprint(validCommand);

  const fakeTransaction: WorkspaceTransaction = {
    runRead: vi.fn(async (_subject, callback) => callback(dummyClient)),
    run: vi.fn(async (_subject, callback) => callback(dummyClient)),
  };

  const fakeCreatedRecord: WorkspaceRecord = {
    id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    name: 'Acme Family',
    kind: 'family',
    baseCurrency: 'USD',
    createdAt: '2026-07-15T00:00:00.000Z',
    version: 1,
  };

  const fakeWorkspace: Workspace = {
    id: fakeCreatedRecord.id,
    name: fakeCreatedRecord.name,
    kind: fakeCreatedRecord.kind,
    baseCurrency: fakeCreatedRecord.baseCurrency,
    role: 'owner',
    createdAt: fakeCreatedRecord.createdAt,
    version: fakeCreatedRecord.version,
  };

  function fakeIdempotencyStore(): IdempotencyStore {
    return {
      read: vi.fn(async () => undefined),
      write: vi.fn(async () => true),
    };
  }

  describe('create - Finding B1: honour idempotency store write outcome', () => {
    it('when idempotency store write returns false, re-reads and returns REPLAYED outcome instead of CREATED', async () => {
      const liveRecord: IdempotencyRecord = {
        requestFingerprint: fingerprint,
        responseStatus: 201,
        responseEtag: '"1"',
        responseBody: fakeWorkspace,
      };

      let readCallCount = 0;
      const idempotencyStoreDouble: IdempotencyStore = {
        read: vi.fn(async () => {
          readCallCount += 1;
          // First read before execution returns undefined (no record yet)
          if (readCallCount === 1) return undefined;
          // Second read after losing write race returns the winning live record
          return liveRecord;
        }),
        write: vi.fn(async () => false), // Simulates losing race
      };

      const storeDouble: WorkspaceStore = {
        readMembership: vi.fn(),
        readWorkspace: vi.fn(async () => fakeCreatedRecord),
        listWorkspaces: vi.fn(),
        createWorkspace: vi.fn(async () => ({ id: fakeCreatedRecord.id })),
        createMembership: vi.fn(async () => undefined),
        hasAccounts: vi.fn(async () => false),
        update: vi.fn(),
        deleteWorkspace: vi.fn(),
      };

      const service = new WorkspaceService(
        fakeTransaction,
        storeDouble,
        idempotencyStoreDouble,
      );

      const outcome = await service.create(
        dummySubject,
        validCommand,
        idempotencyKey,
      );

      expect(outcome.kind).toBe(WORKSPACE_CREATE_OUTCOME_KINDS.REPLAYED);
      if (outcome.kind === WORKSPACE_CREATE_OUTCOME_KINDS.REPLAYED) {
        expect(outcome.status).toBe(201);
        expect(outcome.etag).toBe('"1"');
        expect(outcome.body).toEqual(fakeWorkspace);
      }
      expect(idempotencyStoreDouble.write).toHaveBeenCalledTimes(1);
      expect(idempotencyStoreDouble.read).toHaveBeenCalledTimes(2);
    });

    it('when idempotency store write returns false and live record has different fingerprint, returns IDEMPOTENCY_CONFLICT', async () => {
      const conflictingRecord: IdempotencyRecord = {
        requestFingerprint: 'different-fingerprint-999',
        responseStatus: 201,
        responseEtag: '"1"',
        responseBody: fakeWorkspace,
      };

      const idempotencyStoreDouble: IdempotencyStore = {
        read: vi.fn(async () => undefined),
        write: vi.fn(async () => false),
      };
      // On losing the race, the subsequent re-read returns the conflicting record
      idempotencyStoreDouble.read = vi
        .fn()
        .mockResolvedValueOnce(undefined) // First read before operation
        .mockResolvedValueOnce(conflictingRecord); // Re-read after losing write

      const storeDouble: WorkspaceStore = {
        readMembership: vi.fn(),
        readWorkspace: vi.fn(async () => fakeCreatedRecord),
        listWorkspaces: vi.fn(),
        createWorkspace: vi.fn(async () => ({ id: fakeCreatedRecord.id })),
        createMembership: vi.fn(async () => undefined),
        hasAccounts: vi.fn(async () => false),
        update: vi.fn(),
        deleteWorkspace: vi.fn(),
      };

      const service = new WorkspaceService(
        fakeTransaction,
        storeDouble,
        idempotencyStoreDouble,
      );

      const outcome = await service.create(
        dummySubject,
        validCommand,
        idempotencyKey,
      );

      expect(outcome.kind).toBe(
        WORKSPACE_CREATE_OUTCOME_KINDS.IDEMPOTENCY_CONFLICT,
      );
    });

    it('when idempotency store write succeeds (returns true), returns CREATED outcome', async () => {
      const idempotencyStoreDouble: IdempotencyStore = {
        read: vi.fn(async () => undefined),
        write: vi.fn(async () => true),
      };

      const storeDouble: WorkspaceStore = {
        readMembership: vi.fn(),
        readWorkspace: vi.fn(async () => fakeCreatedRecord),
        listWorkspaces: vi.fn(),
        createWorkspace: vi.fn(async () => ({ id: fakeCreatedRecord.id })),
        createMembership: vi.fn(async () => undefined),
        hasAccounts: vi.fn(async () => false),
        update: vi.fn(),
        deleteWorkspace: vi.fn(),
      };

      const service = new WorkspaceService(
        fakeTransaction,
        storeDouble,
        idempotencyStoreDouble,
      );

      const outcome = await service.create(
        dummySubject,
        validCommand,
        idempotencyKey,
      );

      expect(outcome.kind).toBe(WORKSPACE_CREATE_OUTCOME_KINDS.CREATED);
      if (outcome.kind === WORKSPACE_CREATE_OUTCOME_KINDS.CREATED) {
        expect(outcome.workspace).toEqual(fakeWorkspace);
      }
    });
  });

  describe('update - base currency change invariant', () => {
    const workspaceId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const existingWorkspace: WorkspaceRecord = {
      id: workspaceId,
      name: 'Acme Corp',
      kind: 'shared',
      baseCurrency: 'USD',
      createdAt: '2026-07-15T00:00:00.000Z',
      version: 1,
    };

    function setupStore(hasAccountsValue = false) {
      return {
        readMembership: vi.fn(async () => ({
          role: 'owner' as const,
          status: 'active' as const,
        })),
        readWorkspace: vi.fn(async () => existingWorkspace),
        listWorkspaces: vi.fn(),
        createWorkspace: vi.fn(),
        createMembership: vi.fn(),
        hasAccounts: vi.fn(async () => hasAccountsValue),
        update: vi.fn(async (_client, _wsId, cmd) => ({
          ...existingWorkspace,
          name: cmd.name ?? existingWorkspace.name,
          baseCurrency: cmd.baseCurrency ?? existingWorkspace.baseCurrency,
          version: existingWorkspace.version + 1,
        })),
        deleteWorkspace: vi.fn(),
      } satisfies WorkspaceStore;
    }

    it('refuses base-currency change when accounts exist in workspace', async () => {
      const store = setupStore(true);
      const service = new WorkspaceService(
        fakeTransaction,
        store,
        fakeIdempotencyStore(),
      );

      const outcome = await service.update(dummySubject, workspaceId, {
        baseCurrency: 'EUR',
      });

      expect(outcome.kind).toBe('base-currency-change-unsupported');
      expect(store.hasAccounts).toHaveBeenCalledWith(dummyClient, workspaceId);
      expect(store.update).not.toHaveBeenCalled();
    });

    it('accepts base-currency update when value is equal to current base currency even when accounts exist', async () => {
      const store = setupStore(true);
      const service = new WorkspaceService(
        fakeTransaction,
        store,
        fakeIdempotencyStore(),
      );

      const outcome = await service.update(dummySubject, workspaceId, {
        baseCurrency: 'USD',
      });

      expect(outcome.kind).toBe('ok');
      expect(store.hasAccounts).not.toHaveBeenCalled();
      expect(store.update).toHaveBeenCalled();
    });

    it('accepts update that only touches name even when accounts exist', async () => {
      const store = setupStore(true);
      const service = new WorkspaceService(
        fakeTransaction,
        store,
        fakeIdempotencyStore(),
      );

      const outcome = await service.update(dummySubject, workspaceId, {
        name: 'New Name',
      });

      expect(outcome.kind).toBe('ok');
      expect(store.hasAccounts).not.toHaveBeenCalled();
      expect(store.update).toHaveBeenCalled();
    });

    it('accepts base-currency change when workspace has NO accounts', async () => {
      const store = setupStore(false);
      const service = new WorkspaceService(
        fakeTransaction,
        store,
        fakeIdempotencyStore(),
      );

      const outcome = await service.update(dummySubject, workspaceId, {
        baseCurrency: 'EUR',
      });

      expect(outcome.kind).toBe('ok');
      expect(store.hasAccounts).toHaveBeenCalledWith(dummyClient, workspaceId);
      expect(store.update).toHaveBeenCalled();
    });
  });
});
