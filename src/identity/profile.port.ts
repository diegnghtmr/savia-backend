import type { ProfileUpdateCommand } from './profile-update-command.js';

export const PROFILE_PORT = Symbol('ProfilePort');

export const PROFILE_UPDATE_OUTCOMES = {
  OK: 'ok',
  NOT_FOUND: 'not-found',
  VERSION_CONFLICT: 'version-conflict',
} as const;

export type ProfileUpdateOutcomeKind =
  (typeof PROFILE_UPDATE_OUTCOMES)[keyof typeof PROFILE_UPDATE_OUTCOMES];

export interface UserProfile {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: string;
  readonly timezone: string;
  readonly defaultCurrency: string;
  readonly privacyModeEnabled: boolean;
}

export interface ProfileUpdateSuccess {
  readonly kind: typeof PROFILE_UPDATE_OUTCOMES.OK;
  readonly profile: UserProfile;
  readonly version: number;
}

export interface ProfileUpdateNotFound {
  readonly kind: typeof PROFILE_UPDATE_OUTCOMES.NOT_FOUND;
}

export interface ProfileUpdateVersionConflict {
  readonly kind: typeof PROFILE_UPDATE_OUTCOMES.VERSION_CONFLICT;
}

export type ProfileUpdateOutcome =
  | ProfileUpdateSuccess
  | ProfileUpdateNotFound
  | ProfileUpdateVersionConflict;

export interface ProfilePort {
  read(subject: string): Promise<UserProfile | undefined>;
  update(
    subject: string,
    command: ProfileUpdateCommand,
    expectedVersion?: number | readonly number[],
  ): Promise<ProfileUpdateOutcome>;
}
