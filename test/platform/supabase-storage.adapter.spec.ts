import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ArtifactStorageClientError,
  ArtifactStorageUnavailableError,
} from '../../src/platform/artifact-storage.port.js';
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

  it('retrieves complete buffer via HTTP GET', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(Buffer.from('binary-image-payload'), { status: 200 }),
      );

    const adapter = new SupabaseStorageAdapter({
      SUPABASE_URL: 'https://storage.test',
      SUPABASE_SERVICE_ROLE_KEY: 'secret',
    });

    const result = await adapter.download(
      'workspaces/w1/receipts/r1/receipt.jpg',
    );

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.toString('utf8')).toBe('binary-image-payload');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://storage.test/storage/v1/object/authenticated/exports/workspaces/w1/receipts/r1/receipt.jpg',
      expect.objectContaining({
        method: 'GET',
        headers: {
          authorization: 'Bearer secret',
          apikey: 'secret',
        },
      }),
    );
  });

  it('propagates abort signal to fetch and cancels request', async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((_url, init) => {
        return new Promise((_, reject) => {
          if (init?.signal?.aborted) {
            reject(init.signal.reason ?? new Error('Aborted'));
            return;
          }
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? new Error('Aborted'));
          });
        });
      });

    const adapter = new SupabaseStorageAdapter({
      SUPABASE_URL: 'https://storage.test',
      SUPABASE_SERVICE_ROLE_KEY: 'secret',
    });

    const downloadPromise = adapter.download(
      'workspaces/w1/receipts/r1/receipt.jpg',
      controller.signal,
    );

    controller.abort(new Error('Operation cancelled'));

    await expect(downloadPromise).rejects.toThrow('Operation cancelled');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: controller.signal,
      }),
    );
  });

  it('maps 404 response to permanent ArtifactStorageClientError and not transient unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Object not found', { status: 404 }),
    );

    const adapter = new SupabaseStorageAdapter({
      SUPABASE_URL: 'https://storage.test',
      SUPABASE_SERVICE_ROLE_KEY: 'secret',
    });

    let caughtError: unknown;
    try {
      await adapter.download('workspaces/w1/receipts/r1/missing.jpg');
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(ArtifactStorageClientError);
    expect((caughtError as ArtifactStorageClientError).status).toBe(404);
    expect(caughtError).not.toBeInstanceOf(ArtifactStorageUnavailableError);
  });

  it('maps 5xx responses and transport failures to transient ArtifactStorageUnavailableError', async () => {
    const adapter = new SupabaseStorageAdapter({
      SUPABASE_URL: 'https://storage.test',
      SUPABASE_SERVICE_ROLE_KEY: 'secret',
    });

    // 500
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );
    await expect(
      adapter.download('workspaces/w1/receipts/r1/receipt.jpg'),
    ).rejects.toBeInstanceOf(ArtifactStorageUnavailableError);

    // 503
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Service Unavailable', { status: 503 }),
    );
    await expect(
      adapter.download('workspaces/w1/receipts/r1/receipt.jpg'),
    ).rejects.toBeInstanceOf(ArtifactStorageUnavailableError);

    // Transport error
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Connection reset by peer'),
    );
    await expect(
      adapter.download('workspaces/w1/receipts/r1/receipt.jpg'),
    ).rejects.toBeInstanceOf(ArtifactStorageUnavailableError);
  });
});
