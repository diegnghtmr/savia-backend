import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupabaseStorageAdapter } from '../../src/exports/supabase-storage.adapter.js';

const token = (exp: number) =>
  `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.x`;

describe('SupabaseStorageAdapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('persists the expiry encoded by the signed token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          signedURL: `/object/sign/exports/a?token=${token(1799366400)}`,
        }),
        { status: 200 },
      ),
    );
    const result = await new SupabaseStorageAdapter({
      SUPABASE_URL: 'https://storage.test',
      SUPABASE_SERVICE_ROLE_KEY: 'secret',
    }).sign('workspace/job.csv', new Date('2026-09-07T00:00:00.000Z'));
    expect(result.expiresAt.toISOString()).toBe('2027-01-08T00:00:00.000Z');
  });

  it('rejects unsuccessful removal responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 500 }),
    );
    await expect(
      new SupabaseStorageAdapter({
        SUPABASE_URL: 'https://storage.test',
        SUPABASE_SERVICE_ROLE_KEY: 'secret',
      }).remove('workspace/job.csv'),
    ).rejects.toThrow('500');
  });
});
