import type { SaviaScope } from './savia-scopes.js';

export const CLI_SCOPE_POLICY: ReadonlyMap<string, readonly SaviaScope[]> =
  new Map();

export function routeKey(method: string, route: string): string {
  return `${method.toUpperCase()} ${route}`;
}
