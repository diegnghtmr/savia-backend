import { describe, expect, it, vi } from 'vitest';
import type {
  IdempotencyRecord,
  IdempotencyStore,
} from '../../src/platform/idempotency.port.js';
import { computeRequestFingerprint } from '../../src/platform/idempotency.service.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import {
  SCENARIO_OUTCOMES,
  type CreateScenarioRequest,
  type Scenario,
  type ScenarioItem,
  type ScenarioStore,
} from '../../src/scenarios/scenario.port.js';
import {
  ScenarioService,
  type ScenarioTransaction,
} from '../../src/scenarios/scenario.service.js';

describe('ScenarioService', () => {
  const subject = '11111111-0000-4000-8000-000000000001';
  const workspaceId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const idempotencyKey = 'bbbbbbbb-0000-4000-8000-000000000001';

  const validCommand: CreateScenarioRequest = {
    name: 'Baseline Scenario',
    description: 'Test description',
    assumptions: [
      {
        type: 'income_change',
        value: { amountMinor: '10000', currency: 'USD' },
      },
    ],
  };

  const sampleScenario: Scenario = {
    id: 'cccccccc-0000-4000-8000-000000000001',
    name: validCommand.name,
    description: validCommand.description ?? null,
    assumptions: validCommand.assumptions,
    createdAt: '2026-09-04T12:00:00.000000Z',
    lastRunId: null,
  };

  function createHarness(overrides?: {
    role?: string | undefined;
    existingIdempotency?: IdempotencyRecord | undefined;
    writeIdempotencyResult?: boolean;
    rereadIdempotency?: IdempotencyRecord | undefined;
    createdScenario?: Scenario;
    listRows?: readonly ScenarioItem[];
  }) {
    let rollbackOccurred = false;

    const mockClient = {} as TransactionClient;

    const mockTx: ScenarioTransaction = {
      run: vi.fn(async (_subj, callback) => {
        try {
          return await callback(mockClient);
        } catch (err) {
          rollbackOccurred = true;
          throw err;
        }
      }),
      runRead: vi.fn(async (_subj, callback) => callback(mockClient)),
    };

    const mockStore: ScenarioStore = {
      readActiveRole: vi.fn(async () =>
        overrides && 'role' in overrides ? overrides.role : 'owner',
      ),
      createScenario: vi.fn(
        async () => overrides?.createdScenario ?? sampleScenario,
      ),
      findScenario: vi.fn(async () => sampleScenario),
      listScenarios: vi.fn(async () => overrides?.listRows ?? []),
    };

    const mockIdempotency: IdempotencyStore = {
      read: vi.fn(async () => overrides?.existingIdempotency ?? undefined),
      write: vi.fn(async () => overrides?.writeIdempotencyResult ?? true),
    };

    const service = new ScenarioService(mockTx, mockStore, mockIdempotency);

    return {
      service,
      mockTx,
      mockStore,
      mockIdempotency,
      wasRolledBack: () => rollbackOccurred,
    };
  }

  describe('createScenario', () => {
    it('creates scenario and records idempotency when authorized', () => {
      const { service, mockStore, mockIdempotency } = createHarness();

      return service
        .createScenario(subject, workspaceId, validCommand, idempotencyKey)
        .then((outcome) => {
          expect(outcome.kind).toBe(SCENARIO_OUTCOMES.CREATED);
          if (outcome.kind === SCENARIO_OUTCOMES.CREATED) {
            expect(outcome.scenario).toEqual(sampleScenario);
            expect(outcome.scenario.lastRunId).toBeNull();
          }
          expect(mockStore.createScenario).toHaveBeenCalledWith(
            expect.anything(),
            workspaceId,
            subject,
            validCommand,
          );
          expect(mockIdempotency.write).toHaveBeenCalledWith(
            expect.anything(),
            subject,
            'POST /v1/scenarios',
            idempotencyKey,
            computeRequestFingerprint(validCommand),
            201,
            null,
            sampleScenario,
            workspaceId,
          );
        });
    });

    it('returns forbidden when role is viewer or non-member without writing', async () => {
      const { service, mockStore, mockIdempotency } = createHarness({
        role: 'viewer',
      });

      const outcome = await service.createScenario(
        subject,
        workspaceId,
        validCommand,
        idempotencyKey,
      );
      expect(outcome.kind).toBe(SCENARIO_OUTCOMES.FORBIDDEN);
      expect(mockStore.createScenario).not.toHaveBeenCalled();
      expect(mockIdempotency.write).not.toHaveBeenCalled();
    });

    it('replays original 201 response when same key and payload are sent', async () => {
      const fingerprint = computeRequestFingerprint(validCommand);
      const existing: IdempotencyRecord = {
        requestFingerprint: fingerprint,
        responseStatus: 201,
        responseEtag: null,
        responseBody: sampleScenario,
      };

      const { service, mockStore } = createHarness({
        existingIdempotency: existing,
      });

      const outcome = await service.createScenario(
        subject,
        workspaceId,
        validCommand,
        idempotencyKey,
      );
      expect(outcome.kind).toBe(SCENARIO_OUTCOMES.REPLAYED);
      if (outcome.kind === SCENARIO_OUTCOMES.REPLAYED) {
        expect(outcome.status).toBe(201);
        expect(outcome.body).toEqual(sampleScenario);
      }
      expect(mockStore.createScenario).not.toHaveBeenCalled();
    });

    it('returns 409 conflict when same key has different payload', async () => {
      const existing: IdempotencyRecord = {
        requestFingerprint: 'different-fingerprint',
        responseStatus: 201,
        responseEtag: null,
        responseBody: sampleScenario,
      };

      const { service, mockStore } = createHarness({
        existingIdempotency: existing,
      });

      const outcome = await service.createScenario(
        subject,
        workspaceId,
        validCommand,
        idempotencyKey,
      );
      expect(outcome.kind).toBe(SCENARIO_OUTCOMES.CONFLICT);
      expect(mockStore.createScenario).not.toHaveBeenCalled();
    });

    it('RULING 92: rolls back created scenario on concurrent idempotency write collision (conflict)', async () => {
      const differentFingerprint = 'race-conflict-fingerprint';
      const raceRecord: IdempotencyRecord = {
        requestFingerprint: differentFingerprint,
        responseStatus: 201,
        responseEtag: null,
        responseBody: sampleScenario,
      };

      const { service, mockIdempotency, wasRolledBack } = createHarness({
        writeIdempotencyResult: false,
      });

      mockIdempotency.read = vi
        .fn()
        .mockResolvedValueOnce(undefined) // First read: not found
        .mockResolvedValueOnce(raceRecord); // Reread after failed write: found conflicting

      const outcome = await service.createScenario(
        subject,
        workspaceId,
        validCommand,
        idempotencyKey,
      );

      expect(wasRolledBack()).toBe(true);
      expect(outcome.kind).toBe(SCENARIO_OUTCOMES.CONFLICT);
    });

    it('RULING 92: rolls back created scenario on concurrent idempotency write collision (replay)', async () => {
      const matchingFingerprint = computeRequestFingerprint(validCommand);
      const raceRecord: IdempotencyRecord = {
        requestFingerprint: matchingFingerprint,
        responseStatus: 201,
        responseEtag: null,
        responseBody: sampleScenario,
      };

      const { service, mockIdempotency, wasRolledBack } = createHarness({
        writeIdempotencyResult: false,
      });

      mockIdempotency.read = vi
        .fn()
        .mockResolvedValueOnce(undefined) // First read: not found
        .mockResolvedValueOnce(raceRecord); // Reread after failed write: found matching

      const outcome = await service.createScenario(
        subject,
        workspaceId,
        validCommand,
        idempotencyKey,
      );

      expect(wasRolledBack()).toBe(true);
      expect(outcome.kind).toBe(SCENARIO_OUTCOMES.REPLAYED);
      if (outcome.kind === SCENARIO_OUTCOMES.REPLAYED) {
        expect(outcome.status).toBe(201);
        expect(outcome.body).toEqual(sampleScenario);
      }
    });
  });

  describe('listScenarios', () => {
    it('lists scenarios with pagination when authorized', async () => {
      const items: ScenarioItem[] = [
        {
          scenario: sampleScenario,
          cursorAt: '2026-09-04T12:00:00.000000Z',
        },
      ];
      const { service, mockStore } = createHarness({ listRows: items });

      const outcome = await service.listScenarios(subject, {
        workspaceId,
        limit: 50,
      });

      expect(outcome.kind).toBe('ok');
      if (outcome.kind === 'ok') {
        expect(outcome.page.items).toEqual([sampleScenario]);
        expect(outcome.page.pageInfo.hasNextPage).toBe(false);
        expect(outcome.page.pageInfo.nextCursor).toBeNull();
      }
      expect(mockStore.listScenarios).toHaveBeenCalledWith(
        expect.anything(),
        { workspaceId, limit: 50 },
        51, // requests limit + 1
      );
    });

    it('computes nextCursor when more rows exist than limit', async () => {
      const row1: ScenarioItem = {
        scenario: {
          ...sampleScenario,
          id: '11111111-1111-4000-8000-000000000001',
        },
        cursorAt: '2026-09-04T10:00:00.000000Z',
      };
      const row2: ScenarioItem = {
        scenario: {
          ...sampleScenario,
          id: '22222222-2222-4000-8000-000000000002',
        },
        cursorAt: '2026-09-04T11:00:00.000000Z',
      };
      const row3: ScenarioItem = {
        scenario: {
          ...sampleScenario,
          id: '33333333-3333-4000-8000-000000000003',
        },
        cursorAt: '2026-09-04T12:00:00.000000Z',
      };

      const { service } = createHarness({
        listRows: [row1, row2, row3],
      });

      const outcome = await service.listScenarios(subject, {
        workspaceId,
        limit: 2,
      });

      expect(outcome.kind).toBe('ok');
      if (outcome.kind === 'ok') {
        expect(outcome.page.items).toHaveLength(2);
        expect(outcome.page.items[0]?.id).toBe(row1.scenario.id);
        expect(outcome.page.items[1]?.id).toBe(row2.scenario.id);
        expect(outcome.page.pageInfo.hasNextPage).toBe(true);
        expect(outcome.page.pageInfo.nextCursor).not.toBeNull();
      }
    });

    it('returns forbidden when active role is not a workspace member', async () => {
      const { service } = createHarness({ role: undefined });

      const outcome = await service.listScenarios(subject, {
        workspaceId,
        limit: 50,
      });

      expect(outcome.kind).toBe(SCENARIO_OUTCOMES.FORBIDDEN);
    });
  });
});
