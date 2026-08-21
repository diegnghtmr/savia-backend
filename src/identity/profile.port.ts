export const PROFILE_PORT = Symbol('ProfilePort');
export interface UserProfile {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: string;
  readonly timezone: string;
  readonly defaultCurrency: string;
  readonly privacyModeEnabled: boolean;
}
export interface ProfilePort {
  read(subject: string): Promise<UserProfile | undefined>;
}
