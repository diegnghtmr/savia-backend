import { describe, expect, it } from 'vitest';

import {
  decodeAccountCursor,
  encodeAccountCursor,
  type AccountCursor,
} from '../../src/accounts/accounts.port.js';

const VALID_ID = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const VALID_TIMESTAMP = '2026-06-01T12:34:56.123456Z';

describe('account cursor encoding and decoding', () => {
  it('decodes a valid microsecond-precision cursor', () => {
    const cursor: AccountCursor = {
      createdAt: VALID_TIMESTAMP,
      id: VALID_ID,
    };
    const raw = encodeAccountCursor(cursor);
    expect(decodeAccountCursor(raw)).toEqual(cursor);
  });

  it('satisfies the round-trip invariant: every encodeAccountCursor output is accepted by decodeAccountCursor', () => {
    const samples: AccountCursor[] = [
      { createdAt: '2026-01-01T00:00:00.000000Z', id: VALID_ID },
      { createdAt: '2026-06-01T00:00:00.000500Z', id: VALID_ID },
      { createdAt: '2026-12-31T23:59:59.999999Z', id: VALID_ID },
      { createdAt: '2024-02-29T12:00:00.123456Z', id: VALID_ID },
    ];
    for (const sample of samples) {
      const encoded = encodeAccountCursor(sample);
      expect(decodeAccountCursor(encoded)).toEqual(sample);
    }
  });

  it('rejects a 3-digit millisecond timestamp cursor', () => {
    const raw = Buffer.from(
      JSON.stringify(['2026-06-01T12:34:56.123Z', VALID_ID]),
    ).toString('base64url');
    expect(decodeAccountCursor(raw)).toBeUndefined();
  });

  it('rejects a timestamp with invalid calendar date that rolls over (e.g. Feb 30)', () => {
    const raw = Buffer.from(
      JSON.stringify(['2026-02-30T00:00:00.000000Z', VALID_ID]),
    ).toString('base64url');
    expect(decodeAccountCursor(raw)).toBeUndefined();
  });

  it('rejects year 0000', () => {
    const raw = Buffer.from(
      JSON.stringify(['0000-01-01T00:00:00.000000Z', VALID_ID]),
    ).toString('base64url');
    expect(decodeAccountCursor(raw)).toBeUndefined();
  });

  it('rejects extended year >= 10000', () => {
    const raw = Buffer.from(
      JSON.stringify(['+010000-01-01T00:00:00.000000Z', VALID_ID]),
    ).toString('base64url');
    expect(decodeAccountCursor(raw)).toBeUndefined();

    const raw5Digit = Buffer.from(
      JSON.stringify(['10000-01-01T00:00:00.000000Z', VALID_ID]),
    ).toString('base64url');
    expect(decodeAccountCursor(raw5Digit)).toBeUndefined();
  });

  it('rejects non-base64url, malformed JSON, invalid array structures, or invalid UUIDs', () => {
    expect(decodeAccountCursor('')).toBeUndefined();
    expect(decodeAccountCursor('???not-base64url???')).toBeUndefined();
    expect(
      decodeAccountCursor(Buffer.from('not-json').toString('base64url')),
    ).toBeUndefined();
    expect(
      decodeAccountCursor(
        Buffer.from(JSON.stringify({})).toString('base64url'),
      ),
    ).toBeUndefined();
    expect(
      decodeAccountCursor(
        Buffer.from(JSON.stringify([VALID_TIMESTAMP])).toString('base64url'),
      ),
    ).toBeUndefined();
    expect(
      decodeAccountCursor(
        Buffer.from(
          JSON.stringify([VALID_TIMESTAMP, VALID_ID, 'extra']),
        ).toString('base64url'),
      ),
    ).toBeUndefined();
    expect(
      decodeAccountCursor(
        Buffer.from(JSON.stringify([VALID_TIMESTAMP, 'not-a-uuid'])).toString(
          'base64url',
        ),
      ),
    ).toBeUndefined();
  });
});
