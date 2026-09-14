import { describe, expect, it } from 'vitest';
import { encodeCursor } from '../../src/platform/cursor.js';
import {
  createScenarioListQuery,
  ScenarioQueryValidationError,
} from '../../src/scenarios/scenario-query.js';

describe('createScenarioListQuery validation', () => {
  const workspaceId = '11111111-0000-4000-8000-000000000001';

  it('defaults limit to 50 when omitted', () => {
    const query = createScenarioListQuery({ workspaceId });
    expect(query.limit).toBe(50);
    expect(query.cursor).toBeUndefined();
    expect(query.workspaceId).toBe(workspaceId);
  });

  it('accepts valid limits between 1 and 200', () => {
    const q1 = createScenarioListQuery({ workspaceId, limitParam: '1' });
    expect(q1.limit).toBe(1);

    const q200 = createScenarioListQuery({ workspaceId, limitParam: '200' });
    expect(q200.limit).toBe(200);

    const q42 = createScenarioListQuery({ workspaceId, limitParam: '42' });
    expect(q42.limit).toBe(42);
  });

  it('rejects non-integer limits', () => {
    const nonIntegers = ['', 'abc', '1.5', '-5', '1e2'];
    for (const limitParam of nonIntegers) {
      expect(() =>
        createScenarioListQuery({ workspaceId, limitParam }),
      ).toThrow(ScenarioQueryValidationError);
      try {
        createScenarioListQuery({ workspaceId, limitParam });
      } catch (err) {
        const error = err as ScenarioQueryValidationError;
        expect(error.violations).toEqual(
          expect.arrayContaining([expect.objectContaining({ field: 'limit' })]),
        );
      }
    }
  });

  it('rejects out-of-range limits (< 1 or > 200)', () => {
    for (const limitParam of ['0', '201', '1000']) {
      expect(() =>
        createScenarioListQuery({ workspaceId, limitParam }),
      ).toThrow(ScenarioQueryValidationError);
      try {
        createScenarioListQuery({ workspaceId, limitParam });
      } catch (err) {
        const error = err as ScenarioQueryValidationError;
        expect(error.violations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ field: 'limit', code: 'out-of-range' }),
          ]),
        );
      }
    }
  });

  it('accepts valid opaque cursor matching workspace', () => {
    const validCursor = encodeCursor({
      workspaceId,
      createdAt: '2026-09-04T12:00:00.000000Z',
      id: '22222222-0000-4000-8000-000000000002',
    });

    const query = createScenarioListQuery({
      workspaceId,
      cursorParam: validCursor,
    });
    expect(query.cursor).toBeDefined();
    expect(query.cursor?.createdAt).toBe('2026-09-04T12:00:00.000000Z');
    expect(query.cursor?.id).toBe('22222222-0000-4000-8000-000000000002');
  });

  it('rejects invalid or unparseable cursor', () => {
    const invalidCursors = [
      '',
      'invalid-base64!',
      'bm90LWpzb24=',
      // cursor from a different workspace
      encodeCursor({
        workspaceId: '99999999-0000-4000-8000-000000000009',
        createdAt: '2026-09-04T12:00:00.000000Z',
        id: '22222222-0000-4000-8000-000000000002',
      }),
    ];

    for (const cursorParam of invalidCursors) {
      expect(() =>
        createScenarioListQuery({ workspaceId, cursorParam }),
      ).toThrow(ScenarioQueryValidationError);
      try {
        createScenarioListQuery({ workspaceId, cursorParam });
      } catch (err) {
        const error = err as ScenarioQueryValidationError;
        expect(error.violations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ field: 'cursor', code: 'invalid' }),
          ]),
        );
      }
    }
  });

  it('rejects invalid workspaceId', () => {
    expect(() =>
      createScenarioListQuery({ workspaceId: 'not-a-uuid' }),
    ).toThrow(ScenarioQueryValidationError);
    try {
      createScenarioListQuery({ workspaceId: 'not-a-uuid' });
    } catch (err) {
      const error = err as ScenarioQueryValidationError;
      expect(error.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'workspaceId', code: 'invalid' }),
        ]),
      );
    }
  });
});
