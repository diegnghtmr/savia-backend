import { describe, expect, it, vi } from 'vitest';
import type {
  IdempotencyRecord,
  IdempotencyStore,
} from '../../src/platform/idempotency.port.js';
import { computeRequestFingerprint } from '../../src/platform/idempotency.service.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import {
  SCENARIO_OUTCOMES,
  type AccountNativeBalanceRow,
  type CreateScenarioRequest,
  type DebtOutstandingBalanceRow,
  type Scenario,
  type ScenarioItem,
  type ScenarioRun,
  type ScenarioStore,
  type TransactionFlowRow,
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
    foundScenario?: Scenario | null;
    baseCurrency?: string;
    flowRows?: readonly TransactionFlowRow[];
    accountBalances?: readonly AccountNativeBalanceRow[];
    debtBalances?: readonly DebtOutstandingBalanceRow[];
    exchangeRates?: Record<string, string>;
    clockDate?: Date;
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

    const defaultRun: ScenarioRun = {
      id: 'dddddddd-0000-4000-8000-000000000001',
      scenarioId: sampleScenario.id,
      status: 'completed',
      baseline: {
        periodStart: '2025-10-01',
        periodEnd: '2026-09-04',
        baseCurrency: 'USD',
        monthlyIncomeMinor: '300000',
        monthlyExpensesMinor: '200000',
        monthlySavingsCapacityMinor: '100000',
        netWorthMinor: '1000000',
      },
      projected: {
        periodStart: '2025-10-01',
        periodEnd: '2026-09-04',
        baseCurrency: 'USD',
        monthlyIncomeMinor: '310000',
        monthlyExpensesMinor: '200000',
        monthlySavingsCapacityMinor: '110000',
        netWorthMinor: '1000000',
      },
      difference: {
        periodStart: '2025-10-01',
        periodEnd: '2026-09-04',
        baseCurrency: 'USD',
        monthlyIncomeMinor: '10000',
        monthlyExpensesMinor: '0',
        monthlySavingsCapacityMinor: '10000',
        netWorthMinor: '0',
      },
      risks: [],
    };

    const mockStore: ScenarioStore = {
      readActiveRole: vi.fn(async () =>
        overrides && 'role' in overrides ? overrides.role : 'owner',
      ),
      createScenario: vi.fn(
        async () => overrides?.createdScenario ?? sampleScenario,
      ),
      findScenario: vi.fn(async () =>
        overrides && 'foundScenario' in overrides
          ? (overrides.foundScenario ?? undefined)
          : sampleScenario,
      ),
      listScenarios: vi.fn(async () => overrides?.listRows ?? []),
      readWorkspaceBaseCurrency: vi.fn(async () =>
        overrides && 'baseCurrency' in overrides
          ? overrides.baseCurrency
          : 'USD',
      ),
      readAccountNativeBalances: vi.fn(
        async () => overrides?.accountBalances ?? [],
      ),
      readDebtOutstandingBalances: vi.fn(
        async () => overrides?.debtBalances ?? [],
      ),
      readTransactionsInPeriod: vi.fn(async () => overrides?.flowRows ?? []),
      findExchangeRate: vi.fn(async (_c, _w, base, quote) => {
        const key = `${base}:${quote}`;
        return overrides?.exchangeRates?.[key];
      }),
      createScenarioRun: vi.fn(async (_c, _w, _s, _u, res) => ({
        id: defaultRun.id,
        scenarioId: sampleScenario.id,
        status: res.status,
        baseline: res.baseline,
        projected: res.projected,
        difference: res.difference,
        risks: res.risks,
      })),
      updateScenarioLastRunId: vi.fn(async () => undefined),
    };

    const mockIdempotency: IdempotencyStore = {
      read: vi.fn(async () => overrides?.existingIdempotency ?? undefined),
      write: vi.fn(async () => overrides?.writeIdempotencyResult ?? true),
    };

    const fixedClock = overrides?.clockDate ?? new Date('2026-09-04T12:00:00Z');
    const service = new ScenarioService(
      mockTx,
      mockStore,
      mockIdempotency,
      () => fixedClock,
    );

    return {
      service,
      mockTx,
      mockStore,
      mockIdempotency,
      defaultRun,
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

  describe('runScenario', () => {
    const scenarioId = sampleScenario.id;

    it('computes run, creates run record, updates lastRunId, writes idempotency with 200, returns OK', async () => {
      const { service, mockStore, mockIdempotency, defaultRun } =
        createHarness();

      const outcome = await service.runScenario(
        subject,
        workspaceId,
        scenarioId,
        idempotencyKey,
      );

      expect(outcome.kind).toBe(SCENARIO_OUTCOMES.OK);
      if (outcome.kind === SCENARIO_OUTCOMES.OK) {
        expect(outcome.run.id).toBe(defaultRun.id);
        expect(outcome.run.scenarioId).toBe(scenarioId);
        expect(outcome.run.status).toBe('completed');
      }

      expect(mockStore.createScenarioRun).toHaveBeenCalledWith(
        expect.anything(),
        workspaceId,
        scenarioId,
        subject,
        expect.objectContaining({
          status: 'completed',
        }),
      );
      expect(mockStore.updateScenarioLastRunId).toHaveBeenCalledWith(
        expect.anything(),
        workspaceId,
        scenarioId,
        defaultRun.id,
      );
      expect(mockIdempotency.write).toHaveBeenCalledWith(
        expect.anything(),
        subject,
        'POST /v1/scenarios/{scenarioId}/runs',
        idempotencyKey,
        computeRequestFingerprint({ scenarioId }),
        200,
        null,
        expect.objectContaining({ id: defaultRun.id }),
        workspaceId,
      );
    });

    it('returns forbidden when role is viewer or non-member without writing', async () => {
      const { service, mockStore, mockIdempotency } = createHarness({
        role: 'viewer',
      });

      const outcome = await service.runScenario(
        subject,
        workspaceId,
        scenarioId,
        idempotencyKey,
      );

      expect(outcome.kind).toBe(SCENARIO_OUTCOMES.FORBIDDEN);
      expect(mockStore.createScenarioRun).not.toHaveBeenCalled();
      expect(mockIdempotency.write).not.toHaveBeenCalled();
    });

    it('replays original 200 response when same key and scenarioId are sent', async () => {
      const fingerprint = computeRequestFingerprint({ scenarioId });
      const { service, mockStore } = createHarness({
        existingIdempotency: {
          requestFingerprint: fingerprint,
          responseStatus: 200,
          responseEtag: null,
          responseBody: { id: 'replayed-run-id' },
        },
      });

      const outcome = await service.runScenario(
        subject,
        workspaceId,
        scenarioId,
        idempotencyKey,
      );

      expect(outcome.kind).toBe(SCENARIO_OUTCOMES.REPLAYED);
      if (outcome.kind === SCENARIO_OUTCOMES.REPLAYED) {
        expect(outcome.status).toBe(200);
        expect(outcome.body).toEqual({ id: 'replayed-run-id' });
      }
      expect(mockStore.createScenarioRun).not.toHaveBeenCalled();
    });

    it('returns conflict 409 when same key has different fingerprint', async () => {
      const { service, mockStore } = createHarness({
        existingIdempotency: {
          requestFingerprint: 'different-fingerprint',
          responseStatus: 200,
          responseEtag: null,
          responseBody: {},
        },
      });

      const outcome = await service.runScenario(
        subject,
        workspaceId,
        scenarioId,
        idempotencyKey,
      );

      expect(outcome.kind).toBe(SCENARIO_OUTCOMES.CONFLICT);
      expect(mockStore.createScenarioRun).not.toHaveBeenCalled();
    });

    it('returns 404 NOT_FOUND when scenario is not found in workspace', async () => {
      const { service, mockStore } = createHarness({
        foundScenario: null,
      });

      const outcome = await service.runScenario(
        subject,
        workspaceId,
        scenarioId,
        idempotencyKey,
      );

      expect(outcome.kind).toBe(SCENARIO_OUTCOMES.NOT_FOUND);
      expect(mockStore.createScenarioRun).not.toHaveBeenCalled();
    });

    it('returns 422 MISSING_RATE when exchange rate is missing for a foreign currency', async () => {
      const { service, mockStore } = createHarness({
        flowRows: [
          {
            id: 'txn-eur',
            type: 'income',
            amountMinor: '10000',
            currency: 'EUR',
            occurredAt: new Date('2026-08-01T12:00:00Z'),
          },
        ],
        exchangeRates: {}, // No EUR:USD rate
      });

      const outcome = await service.runScenario(
        subject,
        workspaceId,
        scenarioId,
        idempotencyKey,
      );

      expect(outcome.kind).toBe(SCENARIO_OUTCOMES.MISSING_RATE);
      if (outcome.kind === SCENARIO_OUTCOMES.MISSING_RATE) {
        expect(outcome.fromCurrency).toBe('EUR');
        expect(outcome.toCurrency).toBe('USD');
      }
      expect(mockStore.createScenarioRun).not.toHaveBeenCalled();
    });

    it('RULING 92: rolls back inserted scenario run and last_run_id update on concurrent idempotency write collision (conflict)', async () => {
      const differentFingerprint = 'race-conflict-fingerprint';
      const raceRecord: IdempotencyRecord = {
        requestFingerprint: differentFingerprint,
        responseStatus: 200,
        responseEtag: null,
        responseBody: {},
      };

      const { service, mockIdempotency, wasRolledBack } = createHarness({
        writeIdempotencyResult: false,
      });

      mockIdempotency.read = vi
        .fn()
        .mockResolvedValueOnce(undefined) // First read: not found
        .mockResolvedValueOnce(raceRecord); // Reread after failed write: found conflicting

      const outcome = await service.runScenario(
        subject,
        workspaceId,
        scenarioId,
        idempotencyKey,
      );

      expect(wasRolledBack()).toBe(true);
      expect(outcome.kind).toBe(SCENARIO_OUTCOMES.CONFLICT);
    });

    it('RULING 92: rolls back on concurrent idempotency replay collision', async () => {
      const fingerprint = computeRequestFingerprint({ scenarioId });
      const replayRecord: IdempotencyRecord = {
        requestFingerprint: fingerprint,
        responseStatus: 200,
        responseEtag: null,
        responseBody: { id: 'original-run-id' },
      };

      const { service, mockIdempotency, wasRolledBack } = createHarness({
        writeIdempotencyResult: false,
      });

      mockIdempotency.read = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(replayRecord);

      const outcome = await service.runScenario(
        subject,
        workspaceId,
        scenarioId,
        idempotencyKey,
      );

      expect(wasRolledBack()).toBe(true);
      expect(outcome.kind).toBe(SCENARIO_OUTCOMES.REPLAYED);
      if (outcome.kind === SCENARIO_OUTCOMES.REPLAYED) {
        expect(outcome.status).toBe(200);
        expect(outcome.body).toEqual({ id: 'original-run-id' });
      }
    });
  });
});
