import type { BootstrapCommand } from './bootstrap-command.js';
export const BOOTSTRAP_RESULT_KINDS = {
  CREATED: 'created',
  REPLAYED: 'replayed',
} as const;
export const BOOTSTRAP_CONFLICT_KINDS = {
  DIFFERENT_REQUEST: 'different-request',
} as const;
export const BOOTSTRAP_PARTIAL_KINDS = {
  INCOMPLETE_AGGREGATE: 'incomplete-aggregate',
} as const;
export type BootstrapResultKind =
  (typeof BOOTSTRAP_RESULT_KINDS)[keyof typeof BOOTSTRAP_RESULT_KINDS];
export type BootstrapConflictKind =
  (typeof BOOTSTRAP_CONFLICT_KINDS)[keyof typeof BOOTSTRAP_CONFLICT_KINDS];
export type BootstrapPartialKind =
  (typeof BOOTSTRAP_PARTIAL_KINDS)[keyof typeof BOOTSTRAP_PARTIAL_KINDS];
export interface BootstrapAggregate {
  readonly profileId: string;
  readonly workspaceId: string;
}
export interface BootstrapSuccess {
  readonly kind: BootstrapResultKind;
  readonly aggregate: BootstrapAggregate;
}
export interface BootstrapConflict {
  readonly kind: BootstrapConflictKind;
}
export interface BootstrapPartial {
  readonly kind: BootstrapPartialKind;
}
export type BootstrapOutcome =
  | BootstrapSuccess
  | BootstrapConflict
  | BootstrapPartial;
export interface BootstrapPort {
  execute(command: BootstrapCommand): Promise<BootstrapOutcome>;
}
