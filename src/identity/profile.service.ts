import type { TransactionClient } from './pg-transaction.js';
import type { ProfileUpdateCommand } from './profile-update-command.js';
import {
  PROFILE_UPDATE_OUTCOMES,
  type ProfilePort,
  type ProfileUpdateOutcome,
  type UserProfile,
} from './profile.port.js';

export interface ProfileReadTransaction {
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export interface ProfileTransaction extends ProfileReadTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export interface ProfileStoreRow extends UserProfile {
  readonly version: number;
}

export interface ProfileStore {
  read(
    client: TransactionClient,
    subject: string,
  ): Promise<UserProfile | undefined>;
  update(
    client: TransactionClient,
    subject: string,
    command: ProfileUpdateCommand,
    expectedVersion?: number,
  ): Promise<ProfileStoreRow | undefined>;
  readVersion(
    client: TransactionClient,
    subject: string,
  ): Promise<number | undefined>;
}

export class ProfileService implements ProfilePort {
  public constructor(
    private readonly transaction: ProfileTransaction,
    private readonly store: ProfileStore,
  ) {}

  public read(subject: string): Promise<UserProfile | undefined> {
    return this.transaction.runRead(subject, (client) =>
      this.store.read(client, subject),
    );
  }

  public update(
    subject: string,
    command: ProfileUpdateCommand,
    expectedVersion?: number,
  ): Promise<ProfileUpdateOutcome> {
    return this.transaction.run(subject, async (client) => {
      const row = await this.store.update(
        client,
        subject,
        command,
        expectedVersion,
      );
      if (row !== undefined) {
        const { version, ...profile } = row;
        return {
          kind: PROFILE_UPDATE_OUTCOMES.OK,
          profile,
          version,
        };
      }
      const version = await this.store.readVersion(client, subject);
      if (version === undefined) {
        return { kind: PROFILE_UPDATE_OUTCOMES.NOT_FOUND };
      }
      return { kind: PROFILE_UPDATE_OUTCOMES.VERSION_CONFLICT };
    });
  }
}
