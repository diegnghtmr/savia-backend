export class TransactionSplitsUnsupportedError extends Error {
  public constructor(message = 'Transaction splits are unsupported.') {
    super(message);
    this.name = 'TransactionSplitsUnsupportedError';
  }
}

export function ensureNoSplits(splits: unknown): void {
  if (Array.isArray(splits) && splits.length > 0) {
    throw new TransactionSplitsUnsupportedError();
  }
}
