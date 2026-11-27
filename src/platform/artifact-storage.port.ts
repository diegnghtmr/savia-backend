export const ARTIFACT_STORAGE = Symbol('ArtifactStorage');

export class ArtifactStorageUnavailableError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ArtifactStorageUnavailableError';
  }
}

export class ArtifactStorageClientError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactStorageClientError';
  }
}

export interface ListedArtifact {
  readonly path: string;
  readonly createdAt: Date;
}

export interface ArtifactStorageListOptions {
  readonly after?: string;
  readonly before: Date;
  readonly limit: number;
  readonly signal: AbortSignal;
}

export interface ArtifactStorage {
  /**
   * Stores `content` at `path`, overwriting any existing object at that key.
   * Retry-safe: a second upload to the same path replaces the first.
   */
  upload(
    path: string,
    content: Buffer,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void>;
  sign(
    path: string,
    expiresAt: Date,
    signal?: AbortSignal,
  ): Promise<{ url: string; expiresAt: Date }>;
  download(path: string, signal?: AbortSignal): Promise<Buffer>;
  remove(path: string, signal?: AbortSignal): Promise<void>;
  /** Optional recursive listing, sorted by key, excluding `after` and objects created at or after `before`. */
  list?(
    prefix: string,
    options: ArtifactStorageListOptions,
  ): Promise<readonly ListedArtifact[]>;
}
