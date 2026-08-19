export interface FileSource {
  path: string;
  source: string;
}

export interface AllowListEntry {
  script: string;
  reason: string;
}

export interface ReachabilityAnalysis {
  checkedScripts: string[];
  reachable: string[];
  allowListed: string[];
  violations: string[];
}

export const COVERAGE_ALLOWLIST: AllowListEntry[];

export function analyzeTestScriptReachability(
  scripts: Record<string, string>,
  workflowSources: FileSource[],
  allowList: AllowListEntry[],
): ReachabilityAnalysis;

export function collectPackageScripts(root: string): Record<string, string>;
export function collectWorkflowSources(root: string): FileSource[];
