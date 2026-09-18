import {
  ArtifactStorageClientError,
  ArtifactStorageUnavailableError,
  type ArtifactStorage,
} from './artifact-storage.port.js';
interface StorageConfig {
  readonly url: string;
  readonly key: string;
}
export class SupabaseStorageConfigurationError extends Error {}
export class SupabaseStorageAdapter implements ArtifactStorage {
  private config: StorageConfig | undefined;
  public constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}
  private getConfig(): StorageConfig {
    return (this.config ??= (() => {
      const url = this.environment.SUPABASE_URL?.trim();
      const key = this.environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
      if (!url || !key)
        throw new SupabaseStorageConfigurationError(
          'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured.',
        );
      return { url: url.replace(/\/$/, ''), key };
    })());
  }
  private headers(): HeadersInit {
    return {
      authorization: `Bearer ${this.getConfig().key}`,
      apikey: this.getConfig().key,
    };
  }
  public async upload(
    path: string,
    content: Buffer,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const c = this.getConfig();
    let response: Response;
    try {
      response = await fetch(
        `${c.url}/storage/v1/object/${encodeURIComponent('exports')}/${path.split('/').map(encodeURIComponent).join('/')}`,
        {
          method: 'POST',
          headers: {
            ...this.headers(),
            'content-type': contentType,
            'x-upsert': 'true',
          },
          body: new Uint8Array(content),
          signal,
        },
      );
    } catch (error) {
      throw new ArtifactStorageUnavailableError(
        'Storage upload failed.',
        error,
      );
    }
    if (!response.ok)
      if (response.status >= 500)
        throw new ArtifactStorageUnavailableError(
          `Storage upload failed with status ${response.status}.`,
        );
      else
        throw new ArtifactStorageClientError(
          response.status,
          `Storage upload failed with status ${response.status}.`,
        );
  }
  public async sign(
    path: string,
    expiresAt: Date,
    signal?: AbortSignal,
  ): Promise<{ url: string; expiresAt: Date }> {
    const c = this.getConfig();
    const seconds = Math.max(
      1,
      Math.ceil((expiresAt.getTime() - Date.now()) / 1000),
    );
    let response: Response;
    try {
      response = await fetch(
        `${c.url}/storage/v1/object/sign/exports/${path.split('/').map(encodeURIComponent).join('/')}`,
        {
          method: 'POST',
          headers: { ...this.headers(), 'content-type': 'application/json' },
          body: JSON.stringify({ expiresIn: seconds }),
          signal,
        },
      );
    } catch (error) {
      throw new ArtifactStorageUnavailableError(
        'Storage signing failed.',
        error,
      );
    }
    if (!response.ok)
      if (response.status >= 500)
        throw new ArtifactStorageUnavailableError(
          `Storage signing failed with status ${response.status}.`,
        );
      else
        throw new ArtifactStorageClientError(
          response.status,
          `Storage signing failed with status ${response.status}.`,
        );
    const body = (await response.json()) as {
      signedURL?: string;
      expiresAt?: string;
    };
    if (!body.signedURL) throw new Error('Storage signing returned no URL.');
    const signedUrl = new URL(body.signedURL, c.url);
    const token = signedUrl.searchParams.get('token');
    const tokenExpiry = token ? jwtExpiry(token) : undefined;
    const authoritativeExpiry = body.expiresAt
      ? new Date(body.expiresAt)
      : tokenExpiry;
    if (!authoritativeExpiry || Number.isNaN(authoritativeExpiry.getTime()))
      throw new Error('Storage signing returned no authoritative expiry.');
    return {
      url: body.signedURL.startsWith('http')
        ? body.signedURL
        : `${c.url}/storage/v1${body.signedURL}`,
      expiresAt: authoritativeExpiry,
    };
  }
  public async download(path: string, signal?: AbortSignal): Promise<Buffer> {
    const c = this.getConfig();
    let response: Response;
    try {
      response = await fetch(
        `${c.url}/storage/v1/object/authenticated/exports/${path.split('/').map(encodeURIComponent).join('/')}`,
        {
          method: 'GET',
          headers: this.headers(),
          signal,
        },
      );
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      throw new ArtifactStorageUnavailableError(
        'Storage download failed.',
        error,
      );
    }
    if (!response.ok) {
      if (response.status >= 500) {
        throw new ArtifactStorageUnavailableError(
          `Storage download failed with status ${response.status}.`,
        );
      } else {
        throw new ArtifactStorageClientError(
          response.status,
          `Storage download failed with status ${response.status}.`,
        );
      }
    }
    try {
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      throw new ArtifactStorageUnavailableError(
        'Storage download failed while reading response body.',
        error,
      );
    }
  }
  public async remove(path: string): Promise<void> {
    const c = this.getConfig();
    let response: Response;
    try {
      response = await fetch(
        `${c.url}/storage/v1/object/exports/${path.split('/').map(encodeURIComponent).join('/')}`,
        { method: 'DELETE', headers: this.headers() },
      );
    } catch (error) {
      throw new ArtifactStorageUnavailableError(
        'Storage removal failed.',
        error,
      );
    }
    if (!response.ok)
      if (response.status >= 500)
        throw new ArtifactStorageUnavailableError(
          `Storage removal failed with status ${response.status}.`,
        );
      else
        throw new ArtifactStorageClientError(
          response.status,
          `Storage removal failed with status ${response.status}.`,
        );
  }
}

function jwtExpiry(token: string): Date | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    return typeof payload.exp === 'number'
      ? new Date(payload.exp * 1000)
      : undefined;
  } catch {
    return undefined;
  }
}
