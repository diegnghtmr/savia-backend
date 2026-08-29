import { describe, expect, it } from 'vitest';

import {
  createNamedResourceCommand,
  createPayeeCommand,
  createTagCommand,
  CatalogCommandValidationError,
} from '../../src/catalogs/catalog-command.js';

describe('createNamedResourceCommand validation', () => {
  it('parses valid input with name', () => {
    const cmd = createNamedResourceCommand({ name: 'Groceries' });
    expect(cmd).toEqual({ name: 'Groceries' });
  });

  it('trims leading and trailing whitespace from name', () => {
    const cmd = createNamedResourceCommand({ name: '  Utilities  ' });
    expect(cmd).toEqual({ name: 'Utilities' });
  });

  it('accepts name up to 120 characters', () => {
    const name = 'a'.repeat(120);
    const cmd = createNamedResourceCommand({ name });
    expect(cmd).toEqual({ name });
  });

  it('rejects non-object body', () => {
    expect(() => createNamedResourceCommand(null)).toThrow(
      CatalogCommandValidationError,
    );
    expect(() => createNamedResourceCommand('invalid')).toThrow(
      CatalogCommandValidationError,
    );
    expect(() => createNamedResourceCommand([])).toThrow(
      CatalogCommandValidationError,
    );
  });

  it('rejects unknown fields (additionalProperties: false)', () => {
    try {
      createNamedResourceCommand({
        name: 'Groceries',
        extra: 'not allowed',
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as CatalogCommandValidationError;
      expect(err.violations.some((v) => v.field === 'extra')).toBe(true);
      const violation = err.violations.find((v) => v.field === 'extra');
      expect(violation?.code).toBe('not-allowed');
    }
  });

  it('rejects missing name field', () => {
    try {
      createNamedResourceCommand({});
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as CatalogCommandValidationError;
      expect(err.violations.some((v) => v.field === 'name')).toBe(true);
    }
  });

  it('rejects empty string or whitespace-only name', () => {
    for (const emptyName of ['', '   ']) {
      try {
        createNamedResourceCommand({ name: emptyName });
        expect.unreachable(`Should have thrown for name: "${emptyName}"`);
      } catch (error) {
        const err = error as CatalogCommandValidationError;
        const v = err.violations.find((vi) => vi.field === 'name');
        expect(v).toBeDefined();
        expect(v?.code).toBe('required');
      }
    }
  });

  it('rejects name exceeding 120 characters', () => {
    try {
      createNamedResourceCommand({ name: 'a'.repeat(121) });
      expect.unreachable('Should have thrown for name > 120 chars');
    } catch (error) {
      const err = error as CatalogCommandValidationError;
      const v = err.violations.find((vi) => vi.field === 'name');
      expect(v).toBeDefined();
      expect(v?.code).toBe('max-length');
      expect(v?.message).toContain('120');
    }
  });

  it('rejects name containing null characters', () => {
    try {
      createNamedResourceCommand({ name: 'tag\0name' });
      expect.unreachable('Should have thrown for null char in name');
    } catch (error) {
      const err = error as CatalogCommandValidationError;
      const v = err.violations.find((vi) => vi.field === 'name');
      expect(v).toBeDefined();
      expect(v?.code).toBe('invalid-characters');
    }
  });

  it('aliases createTagCommand and createPayeeCommand correctly', () => {
    expect(createTagCommand({ name: 'Tag1' })).toEqual({ name: 'Tag1' });
    expect(createPayeeCommand({ name: 'Payee1' })).toEqual({ name: 'Payee1' });
  });
});
