import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('excludes credentials after all the Docker context re-includes', () => {
  const rules = readFileSync('.dockerignore', 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const lastInclude = rules.findLastIndex((rule) => rule.startsWith('!'));
  expect(lastInclude).toBeGreaterThanOrEqual(0);
  expect(rules.slice(lastInclude + 1)).toEqual(
    expect.arrayContaining([
      '**/*.pem',
      '**/*.key',
      '**/*.p12',
      '**/*.pfx',
      '**/.env*',
      '**/*secret*',
      '**/credentials*',
      '**/auth.json',
    ]),
  );
});
