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
    const body = (await response.json()) as { signedURL?: string };
    if (!body.signedURL) throw new Error('Storage signing returned no URL.');
    return {
      url: body.signedURL.startsWith('http')
        ? body.signedURL
        : `${c.url}/storage/v1${body.signedURL}`,
      expiresAt: new Date(Date.now() + seconds * 1000),
    };
  }
  public async remove(path: string): Promise<void> {
    const c = this.getConfig();
    await fetch(
      `${c.url}/storage/v1/object/exports/${path.split('/').map(encodeURIComponent).join('/')}`,
      { method: 'DELETE', headers: this.headers() },
    );
  }
}
