export const ARTIFACT_STORAGE = Symbol('ArtifactStorage');

export class ArtifactStorageUnavailableError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ArtifactStorageUnavailableError';
  }
}

export interface ArtifactStorage {
  /**
   * Stores `content` at `path`, overwriting any existing object at that key.
   * Retry-safe: a second upload to the same path replaces the first.
   */
  upload(path: string, content: Buffer, contentType: string): Promise<void>;
  sign(
    path: string,
    expiresAt: Date,
  ): Promise<{ url: string; expiresAt: Date }>;
  remove(path: string): Promise<void>;
}
