export function extractHostPorts(config: string): number[];
export function shouldRetryStart(log: string, attempt: number): boolean;
export function waitForHostPorts(
  ports: number[],
  timeoutMs?: number,
): Promise<void>;
