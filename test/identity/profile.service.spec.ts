import { describe, expect, it, vi } from 'vitest';

import {
  ProfileService,
  type ProfileReadTransaction,
  type ProfileTransaction,
  type ProfileStore,
} from '../../src/identity/profile.service.js';
import {
  PROFILE_UPDATE_OUTCOMES,
  type UserProfile,
} from '../../src/identity/profile.port.js';
import type { TransactionClient } from '../../src/identity/pg-transaction.js';
import type { ProfileUpdateCommand } from '../../src/identity/profile-update-command.js';

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
      update: vi.fn(),
      readVersion: vi.fn(),
    };

    const service = new ProfileService(
      fakeTransaction as unknown as ProfileTransaction,
      fakeStore,
    );
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
      privacyModeEnabled: false,
    };
    const fakeTransaction: ProfileReadTransaction = {
      runRead: vi.fn(async (_subject, callback) => callback(dummyClient)),
    };
    const fakeStore: ProfileStore = {
      read: vi.fn(async () => profile),
      update: vi.fn(),
      readVersion: vi.fn(),
    };

    const service = new ProfileService(
      fakeTransaction as unknown as ProfileTransaction,
      fakeStore,
    );
    const result = await service.read(dummySubject);

    expect(result).toEqual(profile);
  });

  describe('update', () => {
    const command: ProfileUpdateCommand = {
      displayName: 'Ada Lovelace Updated',
    };
    const storeRow = {
      id: dummySubject,
      email: 'ada@example.test',
      displayName: 'Ada Lovelace Updated',
      locale: 'en-US',
      timezone: 'America/Bogota',
      defaultCurrency: 'USD',
      privacyModeEnabled: false,
      version: 2,
    };

    it('runs inside PgTransaction.run and never runRead', async () => {
      const fakeTransaction: ProfileTransaction = {
        runRead: vi.fn(async (_subject, callback) => callback(dummyClient)),
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
      };
      const fakeStore: ProfileStore = {
        read: vi.fn(),
        update: vi.fn(async () => storeRow),
        readVersion: vi.fn(),
      };

      const service = new ProfileService(fakeTransaction, fakeStore);
      const result = await service.update(dummySubject, command, 1);

      expect(fakeTransaction.run).toHaveBeenCalledTimes(1);
      expect(fakeTransaction.run).toHaveBeenCalledWith(
        dummySubject,
        expect.any(Function),
      );
      expect(fakeTransaction.runRead).not.toHaveBeenCalled();
      expect(fakeStore.update).toHaveBeenCalledWith(
        dummyClient,
        dummySubject,
        command,
        1,
      );
      expect(result).toEqual({
        kind: PROFILE_UPDATE_OUTCOMES.OK,
        profile: {
          id: dummySubject,
          email: 'ada@example.test',
          displayName: 'Ada Lovelace Updated',
          locale: 'en-US',
          timezone: 'America/Bogota',
          defaultCurrency: 'USD',
          privacyModeEnabled: false,
        },
        version: 2,
      });
    });

    it('returns not-found when update returns undefined and readVersion returns undefined', async () => {
      const fakeTransaction: ProfileTransaction = {
        runRead: vi.fn(),
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
      };
      const fakeStore: ProfileStore = {
        read: vi.fn(),
        update: vi.fn(async () => undefined),
        readVersion: vi.fn(async () => undefined),
      };

      const service = new ProfileService(fakeTransaction, fakeStore);
      const result = await service.update(dummySubject, command, 1);

      expect(fakeStore.update).toHaveBeenCalledWith(
        dummyClient,
        dummySubject,
        command,
        1,
      );
      expect(fakeStore.readVersion).toHaveBeenCalledWith(
        dummyClient,
        dummySubject,
      );
      expect(result).toEqual({
        kind: PROFILE_UPDATE_OUTCOMES.NOT_FOUND,
      });
    });

    it('returns version-conflict when update returns undefined and readVersion returns a number', async () => {
      const fakeTransaction: ProfileTransaction = {
        runRead: vi.fn(),
        run: vi.fn(async (_subject, callback) => callback(dummyClient)),
      };
      const fakeStore: ProfileStore = {
        read: vi.fn(),
        update: vi.fn(async () => undefined),
        readVersion: vi.fn(async () => 5),
      };

      const service = new ProfileService(fakeTransaction, fakeStore);
      const result = await service.update(dummySubject, command, 1);

      expect(fakeStore.update).toHaveBeenCalledWith(
        dummyClient,
        dummySubject,
        command,
        1,
      );
      expect(fakeStore.readVersion).toHaveBeenCalledWith(
        dummyClient,
        dummySubject,
      );
      expect(result).toEqual({
        kind: PROFILE_UPDATE_OUTCOMES.VERSION_CONFLICT,
      });
    });
  });
});
