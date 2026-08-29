import { describe, expect, it } from 'vitest';
import {
  createCatalogListQuery,
  createCategoryListQuery,
  createPayeeListQuery,
  createTagListQuery,
  CatalogQueryValidationError,
} from '../../src/catalogs/catalog-query.js';
import { encodeCursor } from '../../src/platform/cursor.js';

describe('createCatalogListQuery', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000951';

  it('creates query with workspaceId and default limit 50 when no query params provided', () => {
    const query = createCatalogListQuery({ workspaceId });
    expect(query).toEqual({
      workspaceId,
      limit: 50,
    });
  });

  it('creates query with custom valid limit', () => {
    const query = createCatalogListQuery({
      workspaceId,
      limitParam: '25',
    });
    expect(query).toEqual({
      workspaceId,
      limit: 25,
    });
  });

  it('creates query with valid workspace-bound cursor', () => {
    const cursorStr = encodeCursor({
      workspaceId,
      createdAt: '2026-08-28T12:00:00.000000Z',
      id: '00000000-0000-0000-0000-000000000001',
    });

    const query = createCatalogListQuery({
      workspaceId,
      cursorParam: cursorStr,
    });

    expect(query).toEqual({
      workspaceId,
      limit: 50,
      cursor: {
        workspaceId,
        createdAt: '2026-08-28T12:00:00.000000Z',
        id: '00000000-0000-0000-0000-000000000001',
      },
    });
  });

  it('rejects cursor bound to a different workspace (workspace-scoping invariant)', () => {
    const otherWorkspaceId = '00000000-0000-0000-0000-000000000999';
    const foreignCursor = encodeCursor({
      workspaceId: otherWorkspaceId,
      createdAt: '2026-08-28T12:00:00.000000Z',
      id: '00000000-0000-0000-0000-000000000001',
    });

    expect(() =>
      createCatalogListQuery({
        workspaceId,
        cursorParam: foreignCursor,
      }),
    ).toThrow(CatalogQueryValidationError);
  });

  it('rejects unbounded 2-element cursor when expectedWorkspaceId is enforced', () => {
    const unboundCursor = encodeCursor({
      createdAt: '2026-08-28T12:00:00.000000Z',
      id: '00000000-0000-0000-0000-000000000001',
    });

    expect(() =>
      createCatalogListQuery({
        workspaceId,
        cursorParam: unboundCursor,
      }),
    ).toThrow(CatalogQueryValidationError);
  });

  it('rejects invalid limit (non-integer, <= 0, > 200)', () => {
    for (const invalidLimit of ['0', '-5', '201', 'abc', '1.5']) {
      expect(() =>
        createCatalogListQuery({
          workspaceId,
          limitParam: invalidLimit,
        }),
      ).toThrow(CatalogQueryValidationError);
    }
  });

  it('aliases createTagListQuery, createPayeeListQuery, and createCategoryListQuery correctly', () => {
    expect(createTagListQuery({ workspaceId })).toEqual({
      workspaceId,
      limit: 50,
    });
    expect(createPayeeListQuery({ workspaceId })).toEqual({
      workspaceId,
      limit: 50,
    });
    expect(createCategoryListQuery({ workspaceId })).toEqual({
      workspaceId,
      limit: 50,
    });
  });
});
