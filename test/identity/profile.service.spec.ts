import { describe, expect, it, vi } from 'vitest';

import {
  ProfileService,
  type ProfileReadTransaction,
  type ProfileStore,
} from '../../src/identity/profile.service.js';
import type { UserProfile } from '../../src/identity/profile.port.js';
import type { TransactionClient } from '../../src/identity/pg-transaction.js';

describe('ProfileService', () => {
  const dummySubject = '3f084ac5-18a6-4e09-920d-2e3da29df7c8';
  const dummyClient = {} as TransactionClient;

  it('returns undefined when the store resolves undefined and calls runRead and not run', async () => {
    const fakeTransaction: ProfileReadTransaction & {
      run?: ReturnType<typeof vi.fn>;
    } = {
      runRead: vi.fn(async (_subject, callback) => callback(dummyClient)),
      run: vi.fn(),
    };
    const fakeStore: ProfileStore = {
      read: vi.fn(async () => undefined),
    };

    const service = new ProfileService(fakeTransaction, fakeStore);
    const result = await service.read(dummySubject);

    expect(result).toBeUndefined();
    expect(fakeTransaction.runRead).toHaveBeenCalledTimes(1);
    expect(fakeTransaction.runRead).toHaveBeenCalledWith(
      dummySubject,
      expect.any(Function),
    );
    expect(fakeTransaction.run).not.toHaveBeenCalled();
    expect(fakeStore.read).toHaveBeenCalledWith(dummyClient, dummySubject);
  });

  it("returns the store's UserProfile unchanged when found", async () => {
    const profile: UserProfile = {
      id: dummySubject,
      email: 'ada@example.test',
      displayName: 'Ada Lovelace',
      locale: 'en-US',
      timezone: 'America/Bogota',
      defaultCurrency: 'USD',
    };
    const fakeTransaction: ProfileReadTransaction = {
      runRead: vi.fn(async (_subject, callback) => callback(dummyClient)),
    };
    const fakeStore: ProfileStore = {
      read: vi.fn(async () => profile),
    };

    const service = new ProfileService(fakeTransaction, fakeStore);
    const result = await service.read(dummySubject);

    expect(result).toEqual(profile);
  });
});
