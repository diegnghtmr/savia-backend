import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStorageUnavailableError } from '../../src/platform/artifact-storage.port.js';
import { SupabaseStorageAdapter } from '../../src/platform/supabase-storage.adapter.js';

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

  it('overwrites an existing object at the same key instead of failing', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_input, init) => {
        const headers = new Headers(init?.headers);
        if (headers.get('x-upsert') === 'true') {
          return new Response('', { status: 200 });
        }
        return new Response('', { status: 409 });
      });

    await expect(
      new SupabaseStorageAdapter({
        SUPABASE_URL: 'https://storage.test',
        SUPABASE_SERVICE_ROLE_KEY: 'secret',
      }).upload(
        'aaaaaaaa-0000-4000-8000-000000000001/bbbbbbbb-0000-4000-8000-000000000001.json',
        Buffer.from('retry-bytes'),
        'application/json',
      ),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('x-upsert')).toBe('true');
  });

  it('classifies upload transport and 5xx failures as unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    await expect(
      new SupabaseStorageAdapter({
        SUPABASE_URL: 'https://storage.test',
        SUPABASE_SERVICE_ROLE_KEY: 'secret',
      }).upload(
        'workspace/receipt.pdf',
        Buffer.from('receipt'),
        'application/pdf',
      ),
    ).rejects.toBeInstanceOf(ArtifactStorageUnavailableError);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 503 }),
    );
    await expect(
      new SupabaseStorageAdapter({
        SUPABASE_URL: 'https://storage.test',
        SUPABASE_SERVICE_ROLE_KEY: 'secret',
      }).upload(
        'workspace/receipt.pdf',
        Buffer.from('receipt'),
        'application/pdf',
      ),
    ).rejects.toBeInstanceOf(ArtifactStorageUnavailableError);
  });
});
