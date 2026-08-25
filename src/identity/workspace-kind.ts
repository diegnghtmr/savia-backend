// The workspace vocabulary lives here rather than in workspace.port.ts because
// the port's method signatures need the command types, and the commands need the
// kind: importing both directions made workspace-command.ts and workspace.port.ts
// mutually dependent. The cycle was type-only, so it stayed invisible until
// dependency-cruiser was taught to see pre-compilation dependencies.
//
// workspace.port.ts re-exports these so its existing importers keep one import
// site for the domain vocabulary; workspace-command.ts imports them from here.
export const WORKSPACE_KIND = {
  PERSONAL: 'personal',
  FAMILY: 'family',
  SHARED: 'shared',
} as const;

export type WorkspaceKind =
  (typeof WORKSPACE_KIND)[keyof typeof WORKSPACE_KIND];
