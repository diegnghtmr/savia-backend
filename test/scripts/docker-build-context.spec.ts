import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('excludes credentials after broad Docker re-includes with one exact source exception', () => {
  const rules = readFileSync('.dockerignore', 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  expect(rules.pop()).toBe('!src/platform/credential-crypto.ts');
  const lastInclude = rules.findLastIndex((rule) => rule.startsWith('!'));
  expect(lastInclude).toBeGreaterThanOrEqual(0);
  expect(rules.slice(lastInclude + 1)).toEqual(
    expect.arrayContaining([
      '**/*.[pP][eE][mM]',
      '**/*.[kK][eE][yY]',
      '**/*.[pP]12',
      '**/*.[pP][fF][xX]',
      '**/.[eE][nN][vV]*',
      '**/*[sS][eE][cC][rR][eE][tT]*',
      '**/[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL]*',
      '**/[aA][uU][tT][hH].[jJ][sS][oO][nN]',
    ]),
  );
});
