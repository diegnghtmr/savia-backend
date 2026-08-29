import { describe, expect, it } from 'vitest';

import {
  createCategoryCommand,
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

describe('createCategoryCommand validation', () => {
  const validParentId = '00000000-0000-0000-0000-000000000001';

  it('parses valid input with all fields provided', () => {
    const cmd = createCategoryCommand({
      name: 'Food & Dining',
      kind: 'expense',
      parentId: validParentId,
      icon: 'fork-knife',
      colorToken: 'emerald-500',
    });
    expect(cmd).toEqual({
      name: 'Food & Dining',
      kind: 'expense',
      parentId: validParentId,
      icon: 'fork-knife',
      colorToken: 'emerald-500',
    });
  });

  it('parses minimal input with omitted parentId, icon, and colorToken (omitted -> null)', () => {
    const cmd = createCategoryCommand({
      name: 'Salary',
      kind: 'income',
    });
    expect(cmd).toEqual({
      name: 'Salary',
      kind: 'income',
      parentId: null,
      icon: null,
      colorToken: null,
    });
  });

  it('parses explicit null for parentId, icon, and colorToken (explicit null -> null)', () => {
    const cmd = createCategoryCommand({
      name: 'Internal Transfer',
      kind: 'transfer',
      parentId: null,
      icon: null,
      colorToken: null,
    });
    expect(cmd).toEqual({
      name: 'Internal Transfer',
      kind: 'transfer',
      parentId: null,
      icon: null,
      colorToken: null,
    });
  });

  it('accepts all valid enum values for kind', () => {
    for (const kind of ['income', 'expense', 'transfer', 'other'] as const) {
      const cmd = createCategoryCommand({ name: 'Category', kind });
      expect(cmd.kind).toBe(kind);
    }
  });

  it('rejects unsupported kind', () => {
    try {
      createCategoryCommand({ name: 'Invalid Kind', kind: 'investment' });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as CatalogCommandValidationError;
      const v = err.violations.find((vi) => vi.field === 'kind');
      expect(v).toBeDefined();
      expect(v?.code).toBe('unsupported');
    }
  });

  it('rejects missing kind', () => {
    try {
      createCategoryCommand({ name: 'No Kind' });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as CatalogCommandValidationError;
      const v = err.violations.find((vi) => vi.field === 'kind');
      expect(v).toBeDefined();
    }
  });

  it('rejects invalid parentId format (non-UUID string)', () => {
    try {
      createCategoryCommand({
        name: 'Child',
        kind: 'expense',
        parentId: 'not-a-uuid',
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as CatalogCommandValidationError;
      const v = err.violations.find((vi) => vi.field === 'parentId');
      expect(v).toBeDefined();
      expect(v?.code).toBe('invalid-format');
    }
  });

  it('rejects invalid parentId type (e.g. number)', () => {
    try {
      createCategoryCommand({
        name: 'Child',
        kind: 'expense',
        parentId: 12345,
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as CatalogCommandValidationError;
      const v = err.violations.find((vi) => vi.field === 'parentId');
      expect(v).toBeDefined();
      expect(v?.code).toBe('invalid-format');
    }
  });

  it('rejects invalid icon type (e.g. number)', () => {
    try {
      createCategoryCommand({
        name: 'Category',
        kind: 'expense',
        icon: 123,
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as CatalogCommandValidationError;
      const v = err.violations.find((vi) => vi.field === 'icon');
      expect(v).toBeDefined();
      expect(v?.code).toBe('invalid-type');
    }
  });

  it('rejects invalid colorToken type (e.g. boolean)', () => {
    try {
      createCategoryCommand({
        name: 'Category',
        kind: 'expense',
        colorToken: true,
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as CatalogCommandValidationError;
      const v = err.violations.find((vi) => vi.field === 'colorToken');
      expect(v).toBeDefined();
      expect(v?.code).toBe('invalid-type');
    }
  });

  it('rejects unknown fields (additionalProperties: false)', () => {
    try {
      createCategoryCommand({
        name: 'Category',
        kind: 'expense',
        unexpectedField: 'forbidden',
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as CatalogCommandValidationError;
      const v = err.violations.find((vi) => vi.field === 'unexpectedField');
      expect(v).toBeDefined();
      expect(v?.code).toBe('not-allowed');
    }
  });

  it('rejects non-object body', () => {
    expect(() => createCategoryCommand(null)).toThrow(
      CatalogCommandValidationError,
    );
    expect(() => createCategoryCommand('invalid')).toThrow(
      CatalogCommandValidationError,
    );
  });
});
