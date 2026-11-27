import type { McpWeeklyWindow } from './mcp-grant.port.js';
import { MCP_TOOL_ANNOTATIONS } from './mcp-tools.js';

export const MCP_LOCAL_TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
export const MCP_MINOR_UNITS = /^-?[0-9]+$/;

type Validation<T> =
  | { readonly value: T }
  | { readonly code: string; readonly message: string };

const duplicate = {
  code: 'unique-items',
  message: 'must not contain duplicates',
};

export function parseToolAllowlist(input: unknown): Validation<string[]> {
  if (!Array.isArray(input))
    return { code: 'invalid-type', message: 'must be an array' };
  const tools = Array.from(input, (entry: unknown) => entry).filter(
    (entry): entry is string =>
      typeof entry === 'string' && MCP_TOOL_ANNOTATIONS.has(entry),
  );
  if (tools.length !== input.length)
    return {
      code: 'unsupported',
      message: 'must contain only exact annotated MCP tool names',
    };
  return new Set(tools).size === tools.length ? { value: tools } : duplicate;
}

export function parseGrantSchedule(
  input: unknown,
): Validation<McpWeeklyWindow[]> {
  if (!Array.isArray(input))
    return { code: 'invalid-type', message: 'must be an array' };
  const windows: McpWeeklyWindow[] = [];
  const keys = new Set<string>();
  const invalid = {
    code: 'invalid-value',
    message: 'must contain valid same-day ISO weekday windows',
  };
  for (const entry of input as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return invalid;
    const window = entry as Record<string, unknown>;
    const { dayOfWeek, startTime, endTime } = window;
    if (
      Object.keys(window).length !== 3 ||
      !['dayOfWeek', 'startTime', 'endTime'].every((key) =>
        Object.hasOwn(window, key),
      ) ||
      typeof dayOfWeek !== 'number' ||
      !Number.isInteger(dayOfWeek) ||
      dayOfWeek < 1 ||
      dayOfWeek > 7 ||
      typeof startTime !== 'string' ||
      !MCP_LOCAL_TIME.test(startTime) ||
      typeof endTime !== 'string' ||
      (endTime !== '24:00' && !MCP_LOCAL_TIME.test(endTime)) ||
      startTime >= endTime
    )
      return invalid;
    const key = `${dayOfWeek}/${startTime}/${endTime}`;
    if (keys.has(key)) return duplicate;
    keys.add(key);
    windows.push({ dayOfWeek, startTime, endTime });
  }
  return { value: windows };
}
