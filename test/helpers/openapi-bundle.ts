import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = process.cwd();
export const openapiMirror = resolve(root, 'openapi/savia.openapi.yaml');

export function bundleOpenApi(path: string): Record<string, unknown> {
  const directory = mkdtempSync(resolve(tmpdir(), 'savia-route-contract-'));
  const output = resolve(directory, 'contract.json');
  try {
    execFileSync(
      resolve(root, 'node_modules/.bin/redocly'),
      ['bundle', path, '--ext', 'json', '--output', output],
      { cwd: root, stdio: 'pipe' },
    );
    return JSON.parse(readFileSync(output, 'utf8')) as Record<string, unknown>;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export function authorityMcpReads(): ReadonlyMap<
  string,
  { name: string; requiredScopes: string[] }
> {
  const document = bundleOpenApi(
    process.env.SAVIA_MCP_READ_AUTHORITY ?? openapiMirror,
  );
  type Tool = { name: string; riskClass: string; requiredScopes: string[] };
  const paths = document.paths as Record<
    string,
    Record<string, { 'x-savia-mcp-tool'?: Tool }>
  >;
  const tools = new Map<string, Tool>();
  for (const [path, methods] of Object.entries(paths)) {
    for (const [verb, operation] of Object.entries(methods)) {
      const tool = operation['x-savia-mcp-tool'];
      if (tool?.riskClass === 'read') {
        tools.set(
          `${verb.toUpperCase()} ${path.replaceAll(/\{([^}]+)\}/g, ':$1')}`,
          tool,
        );
      }
    }
  }
  return tools;
}
