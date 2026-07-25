import {
  isExactBootstrapReplay,
  type BootstrapCommand,
} from './bootstrap-command.js';

export const BOOTSTRAP_CLASSIFICATIONS = {
  CREATE: 'create',
  REPLAY: 'replay',
  CONFLICT: 'conflict',
  INCOMPLETE: 'incomplete',
} as const;
export type BootstrapClassification =
  (typeof BOOTSTRAP_CLASSIFICATIONS)[keyof typeof BOOTSTRAP_CLASSIFICATIONS];
export interface BootstrapProfileEvidence {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: string;
  readonly countryCode: string;
  readonly timezone: string;
  readonly dateFormat: BootstrapCommand['dateFormat'];
  readonly weekStartsOn: number;
  readonly numberFormat: BootstrapCommand['numberFormat'];
  readonly defaultCurrency: string;
  readonly privacyModeEnabled: boolean;
}
export interface BootstrapWorkspaceEvidence {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly baseCurrency: string;
  readonly personalOwnerProfileId: string | null;
}
export interface BootstrapMembershipEvidence {
  readonly workspaceId: string;
  readonly profileId: string;
  readonly role: string;
  readonly status: string;
}
export interface BootstrapEvidence {
  readonly profiles: readonly BootstrapProfileEvidence[];
  readonly workspaces: readonly BootstrapWorkspaceEvidence[];
  readonly memberships: readonly BootstrapMembershipEvidence[];
}

export function classifyBootstrap(
  command: BootstrapCommand,
  evidence: BootstrapEvidence,
): BootstrapClassification {
  const { profiles, workspaces, memberships } = evidence;
  if (!(profiles.length || workspaces.length || memberships.length))
    return BOOTSTRAP_CLASSIFICATIONS.CREATE;
  if (
    profiles.length !== 1 ||
    workspaces.length !== 1 ||
    memberships.length !== 1
  )
    return BOOTSTRAP_CLASSIFICATIONS.INCOMPLETE;
  const [profile] = profiles;
  const [workspace] = workspaces;
  const [membership] = memberships;
  if (
    !profile ||
    !workspace ||
    !membership ||
    profile.id !== command.subject ||
    workspace.kind !== 'personal' ||
    workspace.personalOwnerProfileId !== profile.id ||
    membership.workspaceId !== workspace.id ||
    membership.profileId !== profile.id ||
    membership.role !== 'owner' ||
    membership.status !== 'active'
  )
    return BOOTSTRAP_CLASSIFICATIONS.INCOMPLETE;
  const persisted: BootstrapCommand = {
    subject: profile.id,
    email: profile.email,
    displayName: profile.displayName,
    locale: profile.locale,
    countryCode: profile.countryCode,
    timezone: profile.timezone,
    dateFormat: profile.dateFormat,
    weekStartsOn: profile.weekStartsOn,
    numberFormat: profile.numberFormat,
    defaultCurrency: profile.defaultCurrency,
    privacyModeEnabled: profile.privacyModeEnabled,
    workspaceName: workspace.name,
    baseCurrency: workspace.baseCurrency,
  };
  // Reuse the command module's replay comparator rather than restating the
  // field list here: it is driven by REPLAY_FIELDS, so a field added to
  // BootstrapCommand is compared automatically instead of being silently
  // omitted from replay equality.
  return isExactBootstrapReplay(command, persisted)
    ? BOOTSTRAP_CLASSIFICATIONS.REPLAY
    : BOOTSTRAP_CLASSIFICATIONS.CONFLICT;
}
