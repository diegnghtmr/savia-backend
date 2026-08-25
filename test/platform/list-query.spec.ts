import { describe, expect, it } from 'vitest';
import { encodeCursor, type Cursor } from '../../src/platform/cursor.js';
import {
  DEFAULT_LIST_LIMIT,
  parseListQuery,
} from '../../src/platform/list-query.js';

const VALID_WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER_WORKSPACE_ID = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3e';
const VALID_TIMESTAMP = '2026-07-15T00:00:00.000000Z';
const VALID_ITEM_ID = '00000000-0000-0000-0000-000000000001';

describe('platform list-query helper', () => {
  describe('limit validation', () => {
    it('defaults limit to 50 when limitParam is undefined', () => {
      const result = parseListQuery({});
      expect(result.limit).toBe(DEFAULT_LIST_LIMIT);
      expect(result.violations).toEqual([]);
    });

    it('accepts boundary limits 1 and 200', () => {
      const resultMin = parseListQuery({ limitParam: '1' });
      expect(resultMin.limit).toBe(1);
      expect(resultMin.violations).toEqual([]);

      const resultMax = parseListQuery({ limitParam: '200' });
      expect(resultMax.limit).toBe(200);
      expect(resultMax.violations).toEqual([]);
    });

    it.each(['abc', '1.5', '-1', ''])(
      'rejects non-plain-integer limit %s with invalid violation',
      (badLimit) => {
        const result = parseListQuery({ limitParam: badLimit });
        expect(result.violations).toEqual([
          {
            field: 'limit',
            code: 'invalid',
            message: 'limit must be a plain integer.',
          },
        ]);
      },
    );

    it.each(['0', '201'])(
      'rejects out-of-range limit %s at both edges with out-of-range violation',
      (outOfRangeLimit) => {
        const result = parseListQuery({ limitParam: outOfRangeLimit });
        expect(result.violations).toEqual([
          {
            field: 'limit',
            code: 'out-of-range',
            message: 'limit must be between 1 and 200.',
          },
        ]);
      },
    );
  });

  describe('cursor decoding and validation', () => {
    it('decodes a valid unbound cursor', () => {
      const cursor: Cursor = {
        createdAt: VALID_TIMESTAMP,
        id: VALID_ITEM_ID,
      };
      const raw = encodeCursor(cursor);
      const result = parseListQuery({ cursorParam: raw });
      expect(result.cursor).toEqual(cursor);
      expect(result.violations).toEqual([]);
    });

    it('decodes a valid bound cursor matching expectedWorkspaceId', () => {
      const cursor: Cursor = {
        createdAt: VALID_TIMESTAMP,
        id: VALID_ITEM_ID,
        workspaceId: VALID_WORKSPACE_ID,
      };
      const raw = encodeCursor(cursor);
      const result = parseListQuery({
        cursorParam: raw,
        expectedWorkspaceId: VALID_WORKSPACE_ID,
      });
      expect(result.cursor).toEqual(cursor);
      expect(result.violations).toEqual([]);
    });

    it('rejects a malformed cursor with invalid violation', () => {
      const result = parseListQuery({ cursorParam: '!!!not-base64url!!!' });
      expect(result.cursor).toBeUndefined();
      expect(result.violations).toEqual([
        {
          field: 'cursor',
          code: 'invalid',
          message: 'cursor is not a valid opaque cursor.',
        },
      ]);
    });

    it('rejects a bound-cursor mismatch when workspaceId does not match expectedWorkspaceId', () => {
      const cursor: Cursor = {
        createdAt: VALID_TIMESTAMP,
        id: VALID_ITEM_ID,
        workspaceId: OTHER_WORKSPACE_ID,
      };
      const raw = encodeCursor(cursor);
      const result = parseListQuery({
        cursorParam: raw,
        expectedWorkspaceId: VALID_WORKSPACE_ID,
      });
      expect(result.cursor).toBeUndefined();
      expect(result.violations).toEqual([
        {
          field: 'cursor',
          code: 'invalid',
          message: 'cursor is not a valid opaque cursor.',
        },
      ]);
    });

    it('rejects an unbound cursor when expectedWorkspaceId is specified', () => {
      const cursor: Cursor = {
        createdAt: VALID_TIMESTAMP,
        id: VALID_ITEM_ID,
      };
      const raw = encodeCursor(cursor);
      const result = parseListQuery({
        cursorParam: raw,
        expectedWorkspaceId: VALID_WORKSPACE_ID,
      });
      expect(result.cursor).toBeUndefined();
      expect(result.violations).toEqual([
        {
          field: 'cursor',
          code: 'invalid',
          message: 'cursor is not a valid opaque cursor.',
        },
      ]);
    });

    it('rejects a bound cursor when expectedWorkspaceId is not specified', () => {
      const cursor: Cursor = {
        createdAt: VALID_TIMESTAMP,
        id: VALID_ITEM_ID,
        workspaceId: VALID_WORKSPACE_ID,
      };
      const raw = encodeCursor(cursor);
      const result = parseListQuery({ cursorParam: raw });
      expect(result.cursor).toBeUndefined();
      expect(result.violations).toEqual([
        {
          field: 'cursor',
          code: 'invalid',
          message: 'cursor is not a valid opaque cursor.',
        },
      ]);
    });
  });

  describe('accumulation of multiple violations', () => {
    it('accumulates both limit and cursor violations at once without short-circuiting', () => {
      const result = parseListQuery({
        limitParam: 'abc',
        cursorParam: 'invalid-cursor',
      });
      expect(result.violations).toEqual([
        {
          field: 'limit',
          code: 'invalid',
          message: 'limit must be a plain integer.',
        },
        {
          field: 'cursor',
          code: 'invalid',
          message: 'cursor is not a valid opaque cursor.',
        },
      ]);
    });

    it('accumulates out-of-range limit and invalid cursor violations at once', () => {
      const result = parseListQuery({
        limitParam: '0',
        cursorParam: 'invalid-cursor',
      });
      expect(result.violations).toEqual([
        {
          field: 'limit',
          code: 'out-of-range',
          message: 'limit must be between 1 and 200.',
        },
        {
          field: 'cursor',
          code: 'invalid',
          message: 'cursor is not a valid opaque cursor.',
        },
      ]);
    });
  });
});
