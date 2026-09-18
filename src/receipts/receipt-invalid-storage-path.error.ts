import { PROBLEM_TYPES } from '../platform/problem-details.js';

export class ReceiptInvalidStoragePathError extends Error {
  public readonly isDomainError = true;
  public readonly type = PROBLEM_TYPES.BAD_REQUEST;
  public readonly title = 'Invalid Storage Path';
  public readonly status = 400;
  public readonly code = 'invalid_storage_path';

  public constructor(detail: string) {
    super(detail);
    this.name = 'ReceiptInvalidStoragePathError';
  }
}
