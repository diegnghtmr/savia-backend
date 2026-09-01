import { describe, expect, it } from 'vitest';
import { validateCommitImportCommand } from '../../src/imports/import-command.js';

describe('validateCommitImportCommand', () => {
  const valid = {
    accountId: '00000000-0000-4000-8000-000000000001',
    columnMapping: {
      date: 'date',
      amount: 'amount',
      description: 'description',
    },
  };

  it.each([
    ['unknown top-level property', { ...valid, extra: true }],
    ['invalid account UUID', { ...valid, accountId: 'not-a-uuid' }],
  ])('rejects %s at the boundary', (_name, value) => {
    expect(() => validateCommitImportCommand(value)).toThrow();
  });

  it('accepts the published command shape', () => {
    expect(validateCommitImportCommand(valid)).toMatchObject(valid);
  });
});
