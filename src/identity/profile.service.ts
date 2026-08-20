import type { TransactionClient } from './pg-transaction.js';
import type { ProfilePort, UserProfile } from './profile.port.js';

export interface ProfileReadTransaction {
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export interface ProfileStore {
  read(
    client: TransactionClient,
    subject: string,
  ): Promise<UserProfile | undefined>;
}

export class ProfileService implements ProfilePort {
  public constructor(
    private readonly transaction: ProfileReadTransaction,
    private readonly store: ProfileStore,
  ) {}

  public read(subject: string): Promise<UserProfile | undefined> {
    return this.transaction.runRead(subject, (client) =>
      this.store.read(client, subject),
    );
  }
}
