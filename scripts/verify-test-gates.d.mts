export interface FileSource {
  path: string;
  source: string;
}

export interface GateSite {
  path: string;
  line: number;
  callee: string;
  variables: string[];
}

export interface GateAnalysis {
  gates: GateSite[];
  violations: string[];
}

export function analyzeTestGates(
  testSources: FileSource[],
  setterSources: FileSource[],
): GateAnalysis;

export function isFixturePath(filePath: string): boolean;
export function collectTestSources(root: string): FileSource[];
export function collectSetterSources(root: string): FileSource[];
export function stripHashComments(source: string): string;
