import type { ExportStorage } from './export.port.js';
interface StorageConfig {
  readonly url: string;
  readonly key: string;
}
export class SupabaseStorageConfigurationError extends Error {}
export class SupabaseStorageAdapter implements ExportStorage {
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
  ): Promise<void> {
    const c = this.getConfig();
    const response = await fetch(
      `${c.url}/storage/v1/object/${encodeURIComponent('exports')}/${path.split('/').map(encodeURIComponent).join('/')}`,
      {
        method: 'POST',
        headers: {
          ...this.headers(),
          'content-type': contentType,
          'x-upsert': 'false',
        },
        body: new Uint8Array(content),
      },
    );
    if (!response.ok)
      throw new Error(`Storage upload failed with status ${response.status}.`);
  }
  public async sign(
    path: string,
    expiresAt: Date,
  ): Promise<{ url: string; expiresAt: Date }> {
    const c = this.getConfig();
    const seconds = Math.max(
      1,
      Math.ceil((expiresAt.getTime() - Date.now()) / 1000),
    );
    const response = await fetch(
      `${c.url}/storage/v1/object/sign/exports/${path.split('/').map(encodeURIComponent).join('/')}`,
      {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ expiresIn: seconds }),
      },
    );
    if (!response.ok)
      throw new Error(`Storage signing failed with status ${response.status}.`);
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
  public async remove(path: string): Promise<void> {
    const c = this.getConfig();
    const response = await fetch(
      `${c.url}/storage/v1/object/exports/${path.split('/').map(encodeURIComponent).join('/')}`,
      { method: 'DELETE', headers: this.headers() },
    );
    if (!response.ok)
      throw new Error(`Storage removal failed with status ${response.status}.`);
  }
}

function jwtExpiry(token: string): Date | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    return typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}
