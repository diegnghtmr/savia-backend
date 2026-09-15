export const ARTIFACT_STORAGE = Symbol('ArtifactStorage');

export interface ArtifactStorage {
  upload(path: string, content: Buffer, contentType: string): Promise<void>;
  sign(
    path: string,
    expiresAt: Date,
  ): Promise<{ url: string; expiresAt: Date }>;
  remove(path: string): Promise<void>;
}
