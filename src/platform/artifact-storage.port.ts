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
  remove(path: string): Promise<void>;
}
