import { describe, expect, it, vi } from 'vitest';

import type { TransactionClient } from '../../src/identity/pg-transaction.js';
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
        update: vi.fn(),
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
        requestFingerprint: 'different-fingerprint-from-other-payload',
        responseStatus: 201,
        responseEtag: '"1"',
        responseBody: fakeWorkspace,
      };

      let readCallCount = 0;
      const idempotencyStoreDouble: IdempotencyStore = {
        read: vi.fn(async () => {
          readCallCount += 1;
          if (readCallCount === 1) return undefined;
          return conflictingRecord;
        }),
        write: vi.fn(async () => false),
      };

      const storeDouble: WorkspaceStore = {
        readMembership: vi.fn(),
        readWorkspace: vi.fn(async () => fakeCreatedRecord),
        listWorkspaces: vi.fn(),
        createWorkspace: vi.fn(async () => ({ id: fakeCreatedRecord.id })),
        createMembership: vi.fn(async () => undefined),
        update: vi.fn(),
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
        update: vi.fn(),
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
});
