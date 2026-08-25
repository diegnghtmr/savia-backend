import { describe, expect, it } from 'vitest';

import {
  decodeCursor,
  encodeCursor,
  type Cursor,
} from '../../src/platform/cursor.js';

const VALID_ID = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const VALID_WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER_WORKSPACE_ID = '8c9e6679-7425-40de-944b-e07fc1f90ae8';
const VALID_TIMESTAMP = '2026-06-01T12:34:56.123456Z';

describe('shared cursor encoding and decoding', () => {
  it('decodes a valid microsecond-precision cursor (unbound)', () => {
    const cursor: Cursor = {
      createdAt: VALID_TIMESTAMP,
      id: VALID_ID,
    };
    const raw = encodeCursor(cursor);
    expect(decodeCursor(raw)).toEqual(cursor);
  });

  it('decodes a valid microsecond-precision cursor (bound to workspaceId)', () => {
    const cursor: Cursor = {
      workspaceId: VALID_WORKSPACE_ID,
      createdAt: VALID_TIMESTAMP,
      id: VALID_ID,
    };
    const raw = encodeCursor(cursor);
    expect(decodeCursor(raw, VALID_WORKSPACE_ID)).toEqual(cursor);
  });

  it('rejects a bound cursor when expectedWorkspaceId does not match', () => {
    const cursor: Cursor = {
      workspaceId: VALID_WORKSPACE_ID,
      createdAt: VALID_TIMESTAMP,
      id: VALID_ID,
    };
    const raw = encodeCursor(cursor);
    expect(decodeCursor(raw, OTHER_WORKSPACE_ID)).toBeUndefined();
  });

  it('rejects an unbound cursor when expectedWorkspaceId is specified', () => {
    const cursor: Cursor = {
      createdAt: VALID_TIMESTAMP,
      id: VALID_ID,
    };
    const raw = encodeCursor(cursor);
    expect(decodeCursor(raw, VALID_WORKSPACE_ID)).toBeUndefined();
  });

  it('satisfies the round-trip invariant: what a site emits, that same site accepts', () => {
    // The invariant is scoped to the call site, not global. A bound site emits
    // three elements and decodes with its binding; an unbound site emits two and
    // decodes without one. Stating it globally would force the decoder to accept
    // shapes a given site never emits.
    const samples: Cursor[] = [
      { createdAt: '2026-01-01T00:00:00.000000Z', id: VALID_ID },
      { createdAt: '2026-06-01T00:00:00.000500Z', id: VALID_ID },
      { createdAt: '2026-12-31T23:59:59.999999Z', id: VALID_ID },
      { createdAt: '2024-02-29T12:00:00.123456Z', id: VALID_ID },
      {
        workspaceId: VALID_WORKSPACE_ID,
        createdAt: '2026-06-01T00:00:00.000500Z',
        id: VALID_ID,
      },
    ];
    for (const sample of samples) {
      const encoded = encodeCursor(sample);
      expect(decodeCursor(encoded, sample.workspaceId)).toEqual(sample);
    }
  });

  it('rejects a 3-digit millisecond timestamp cursor', () => {
    const raw = Buffer.from(
      JSON.stringify(['2026-06-01T12:34:56.123Z', VALID_ID]),
    ).toString('base64url');
    expect(decodeCursor(raw)).toBeUndefined();

    const rawBound = Buffer.from(
      JSON.stringify([
        VALID_WORKSPACE_ID,
        '2026-06-01T12:34:56.123Z',
        VALID_ID,
      ]),
    ).toString('base64url');
    expect(decodeCursor(rawBound)).toBeUndefined();
  });

  it('rejects a timestamp with invalid calendar date that rolls over (e.g. Feb 30)', () => {
    const raw = Buffer.from(
      JSON.stringify(['2026-02-30T00:00:00.000000Z', VALID_ID]),
    ).toString('base64url');
    expect(decodeCursor(raw)).toBeUndefined();
  });

  it('rejects year 0000', () => {
    const raw = Buffer.from(
      JSON.stringify(['0000-01-01T00:00:00.000000Z', VALID_ID]),
    ).toString('base64url');
    expect(decodeCursor(raw)).toBeUndefined();
  });

  it('rejects extended year >= 10000', () => {
    const raw = Buffer.from(
      JSON.stringify(['+010000-01-01T00:00:00.000000Z', VALID_ID]),
    ).toString('base64url');
    expect(decodeCursor(raw)).toBeUndefined();

    const raw5Digit = Buffer.from(
      JSON.stringify(['10000-01-01T00:00:00.000000Z', VALID_ID]),
    ).toString('base64url');
    expect(decodeCursor(raw5Digit)).toBeUndefined();
  });

  it('rejects non-base64url, malformed JSON, invalid array structures, or invalid UUIDs', () => {
    expect(decodeCursor('')).toBeUndefined();
    expect(decodeCursor('???not-base64url???')).toBeUndefined();
    expect(
      decodeCursor(Buffer.from('not-json').toString('base64url')),
    ).toBeUndefined();
    expect(
      decodeCursor(Buffer.from(JSON.stringify({})).toString('base64url')),
    ).toBeUndefined();
    expect(
      decodeCursor(
        Buffer.from(JSON.stringify([VALID_TIMESTAMP])).toString('base64url'),
      ),
    ).toBeUndefined();
    expect(
      decodeCursor(
        Buffer.from(
          JSON.stringify([
            VALID_WORKSPACE_ID,
            VALID_TIMESTAMP,
            VALID_ID,
            'extra',
          ]),
        ).toString('base64url'),
      ),
    ).toBeUndefined();
    expect(
      decodeCursor(
        Buffer.from(JSON.stringify([VALID_TIMESTAMP, 'not-a-uuid'])).toString(
          'base64url',
        ),
      ),
    ).toBeUndefined();
  });

  it('rejects a bound cursor at an unbound call site: the accepted shape must equal the emitted one', () => {
    const bound = encodeCursor({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-06-01T12:34:56.123456Z',
      id: '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d',
    });
    // An unbound site emits two elements, so a three-element payload is a
    // cursor minted elsewhere. Accepting a shape we never emit is how the
    // binding quietly stops meaning anything.
    expect(decodeCursor(bound)).toBeUndefined();
    // ...and it still decodes where it was minted.
    expect(decodeCursor(bound, '11111111-1111-4111-8111-111111111111')).toEqual(
      {
        workspaceId: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-06-01T12:34:56.123456Z',
        id: '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d',
      },
    );
  });
});
