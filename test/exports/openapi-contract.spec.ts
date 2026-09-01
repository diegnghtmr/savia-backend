import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('export OpenAPI transport contract', () => {
  it('publishes the exact response-code sets for create and get', () => {
    const dir = mkdtempSync(join(tmpdir(), 'savia-openapi-'));
    const output = join(dir, 'contract.json');
    try {
      execFileSync(
        resolve('node_modules/.bin/redocly'),
        [
          'bundle',
          resolve('openapi/savia.openapi.yaml'),
          '--ext',
          'json',
          '--output',
          output,
        ],
        { stdio: 'pipe' },
      );
      const document = JSON.parse(readFileSync(output, 'utf8')) as {
        paths: Record<
          string,
          {
            post?: { responses: Record<string, unknown> };
            get?: { responses: Record<string, unknown> };
          }
        >;
      };
      expect(
        Object.keys(document.paths['/v1/export-jobs'].post!.responses).sort(),
      ).toEqual(['202', '400', '401', '403', '409', '422', '500']);
      expect(
        Object.keys(
          document.paths['/v1/export-jobs/{exportJobId}'].get!.responses,
        ).sort(),
      ).toEqual(['200', '400', '401', '403', '404', '500']);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
