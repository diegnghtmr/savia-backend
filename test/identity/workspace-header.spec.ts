import { describe, expect, it } from 'vitest';

import { parseWorkspaceHeader } from '../../src/platform/workspace-header.js';

describe('parseWorkspaceHeader', () => {
  it('accepts a canonical uuid', () => {
    expect(
      parseWorkspaceHeader('7c9e6679-7425-40de-944b-e07fc1f90ae7'),
    ).toEqual({
      kind: 'ok',
      workspaceId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    });
  });

  it('accepts an uppercase uuid and lowercases it', () => {
    expect(
      parseWorkspaceHeader('7C9E6679-7425-40DE-944B-E07FC1F90AE7'),
    ).toEqual({
      kind: 'ok',
      workspaceId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    });
  });

  it('reports missing when the header is absent', () => {
    expect(parseWorkspaceHeader(undefined)).toEqual({ kind: 'missing' });
  });

  it('reports malformed for an empty or whitespace header', () => {
    expect(parseWorkspaceHeader('')).toEqual({ kind: 'malformed' });
    expect(parseWorkspaceHeader('   ')).toEqual({ kind: 'malformed' });
  });

  it('reports malformed for a non-uuid value', () => {
    expect(parseWorkspaceHeader('not-a-uuid')).toEqual({ kind: 'malformed' });
    expect(parseWorkspaceHeader('1234')).toEqual({ kind: 'malformed' });
  });

  it('reports malformed for repeated header values', () => {
    // Mirrors if-match.ts: multiple values are joined and then fail the uuid
    // check, so a duplicated X-Workspace-Id can never silently pick one.
    expect(
      parseWorkspaceHeader([
        '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        '00000000-0000-4000-8000-000000000001',
      ]),
    ).toEqual({ kind: 'malformed' });
  });

  it('reports malformed for non-string input', () => {
    expect(parseWorkspaceHeader(42)).toEqual({ kind: 'malformed' });
    expect(parseWorkspaceHeader({})).toEqual({ kind: 'malformed' });
  });
});
