import { describe, expect, it, vi } from 'vitest';
import { PostgresCatalogsAdapter } from '../../src/catalogs/postgres-catalogs.adapter.js';
import {
  CategoryNameConflictError,
  CategoryParentNotFoundError,
  PayeeNameConflictError,
  TagNameConflictError,
} from '../../src/catalogs/catalogs.service.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';

describe('PostgresCatalogsAdapter', () => {
  const adapter = new PostgresCatalogsAdapter();
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const subject = '00000000-0000-0000-0000-000000000901';

  describe('readActiveRole', () => {
    it('queries workspace_actor_active_role with workspaceId', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockResolvedValue({ rows: [{ role: 'editor' }] }),
      };

      const role = await adapter.readActiveRole(client, workspaceId);

      expect(client.query).toHaveBeenCalledTimes(1);
      const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, unknown[]];
      expect(sql).toContain(
        'select public.workspace_actor_active_role($1::uuid) as role',
      );
      expect(values).toEqual([workspaceId]);
      expect(role).toBe('editor');
    });

    it('returns undefined when role is null or missing', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockResolvedValue({ rows: [{ role: null }] }),
      };

      const role = await adapter.readActiveRole(client, workspaceId);
      expect(role).toBeUndefined();
    });
  });

  describe('createTag', () => {
    it('inserts into public.tags and returns projection (id, name, archived)', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: '00000000-0000-0000-0000-000000001001',
              name: 'Groceries',
              archived: false,
            },
          ],
        }),
      };

      const tag = await adapter.createTag(client, workspaceId, subject, {
        name: 'Groceries',
      });

      expect(tag).toEqual({
        id: '00000000-0000-0000-0000-000000001001',
        name: 'Groceries',
        archived: false,
      });

      const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, unknown[]];
      expect(sql).toContain('insert into public.tags');
      expect(sql).toContain('workspace_id');
      expect(sql).toContain('name');
      expect(sql).toContain('created_by');
      expect(values).toEqual([workspaceId, 'Groceries', subject]);
    });

    it('catches 23505 with tags_workspace_id_name_key constraint and throws TagNameConflictError', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockRejectedValue({
          code: '23505',
          constraint: 'tags_workspace_id_name_key',
        }),
      };

      await expect(
        adapter.createTag(client, workspaceId, subject, { name: 'Groceries' }),
      ).rejects.toThrow(TagNameConflictError);
    });

    it('rethrows 23505 if constraint name does not match tags_workspace_id_name_key', async () => {
      const otherError = {
        code: '23505',
        constraint: 'tags_other_constraint_key',
      };
      const client: TransactionClient = {
        query: vi.fn().mockRejectedValue(otherError),
      };

      await expect(
        adapter.createTag(client, workspaceId, subject, { name: 'Groceries' }),
      ).rejects.toEqual(otherError);
    });
  });

  describe('listTags', () => {
    it('queries public.tags with workspace_id, cursorAt, ordering and limit', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: '00000000-0000-0000-0000-000000001001',
              name: 'Groceries',
              archived: false,
              cursorAt: '2026-08-28T12:00:00.000000Z',
            },
          ],
        }),
      };

      const result = await adapter.listTags(client, workspaceId, undefined, 51);

      expect(client.query).toHaveBeenCalledTimes(1);
      const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, unknown[]];

      expect(sql).toContain('from public.tags');
      expect(sql).toContain('workspace_id = $1::uuid');
      expect(sql).toContain('order by created_at, id');
      expect(sql).toContain('limit $4');
      expect(values).toEqual([workspaceId, null, null, 51]);

      expect(result).toEqual([
        {
          tag: {
            id: '00000000-0000-0000-0000-000000001001',
            name: 'Groceries',
            archived: false,
          },
          cursorAt: '2026-08-28T12:00:00.000000Z',
        },
      ]);
    });

    it('passes cursor timestamp and id to keyset condition', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };

      const cursor = {
        workspaceId,
        createdAt: '2026-08-28T12:00:00.000000Z',
        id: '00000000-0000-0000-0000-000000001001',
      };

      await adapter.listTags(client, workspaceId, cursor, 51);

      const [, values] = (client.query as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, unknown[]];
      expect(values).toEqual([
        workspaceId,
        '2026-08-28T12:00:00.000000Z',
        '00000000-0000-0000-0000-000000001001',
        51,
      ]);
    });
  });

  describe('createPayee', () => {
    it('inserts into public.payees and returns projection (id, name, archived)', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: '00000000-0000-0000-0000-000000002001',
              name: 'Acme Supermarket',
              archived: false,
            },
          ],
        }),
      };

      const payee = await adapter.createPayee(client, workspaceId, subject, {
        name: 'Acme Supermarket',
      });

      expect(payee).toEqual({
        id: '00000000-0000-0000-0000-000000002001',
        name: 'Acme Supermarket',
        archived: false,
      });

      const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, unknown[]];
      expect(sql).toContain('insert into public.payees');
      expect(sql).toContain('workspace_id');
      expect(sql).toContain('name');
      expect(sql).toContain('created_by');
      expect(values).toEqual([workspaceId, 'Acme Supermarket', subject]);
    });

    it('catches 23505 with payees_workspace_id_name_key constraint and throws PayeeNameConflictError', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockRejectedValue({
          code: '23505',
          constraint: 'payees_workspace_id_name_key',
        }),
      };

      await expect(
        adapter.createPayee(client, workspaceId, subject, {
          name: 'Acme Supermarket',
        }),
      ).rejects.toThrow(PayeeNameConflictError);
    });

    it('rethrows 23505 if constraint name does not match payees_workspace_id_name_key', async () => {
      const otherError = {
        code: '23505',
        constraint: 'payees_other_constraint_key',
      };
      const client: TransactionClient = {
        query: vi.fn().mockRejectedValue(otherError),
      };

      await expect(
        adapter.createPayee(client, workspaceId, subject, {
          name: 'Acme Supermarket',
        }),
      ).rejects.toEqual(otherError);
    });
  });

  describe('listPayees', () => {
    it('queries public.payees with workspace_id, cursorAt, ordering and limit', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: '00000000-0000-0000-0000-000000002001',
              name: 'Acme Supermarket',
              archived: false,
              cursorAt: '2026-08-28T12:00:00.000000Z',
            },
          ],
        }),
      };

      const result = await adapter.listPayees(
        client,
        workspaceId,
        undefined,
        51,
      );

      expect(client.query).toHaveBeenCalledTimes(1);
      const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, unknown[]];

      expect(sql).toContain('from public.payees');
      expect(sql).toContain('workspace_id = $1::uuid');
      expect(sql).toContain('order by created_at, id');
      expect(sql).toContain('limit $4');
      expect(values).toEqual([workspaceId, null, null, 51]);

      expect(result).toEqual([
        {
          payee: {
            id: '00000000-0000-0000-0000-000000002001',
            name: 'Acme Supermarket',
            archived: false,
          },
          cursorAt: '2026-08-28T12:00:00.000000Z',
        },
      ]);
    });
  });

  describe('createCategory', () => {
    it('inserts root category into public.categories and returns projection', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: '00000000-0000-0000-0000-000000003001',
              name: 'Food & Dining',
              archived: false,
              parentId: null,
              kind: 'expense',
              icon: 'fork-knife',
              colorToken: 'emerald-500',
            },
          ],
        }),
      };

      const category = await adapter.createCategory(
        client,
        workspaceId,
        subject,
        {
          name: 'Food & Dining',
          kind: 'expense',
          parentId: null,
          icon: 'fork-knife',
          colorToken: 'emerald-500',
        },
      );

      expect(category).toEqual({
        id: '00000000-0000-0000-0000-000000003001',
        name: 'Food & Dining',
        archived: false,
        parentId: null,
        kind: 'expense',
        icon: 'fork-knife',
        colorToken: 'emerald-500',
      });

      const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, unknown[]];
      expect(sql).toContain('insert into public.categories');
      expect(sql).toContain('workspace_id');
      expect(sql).toContain('parent_id');
      expect(sql).toContain('name');
      expect(sql).toContain('kind');
      expect(sql).toContain('icon');
      expect(sql).toContain('color_token');
      expect(sql).toContain('created_by');
      expect(values).toEqual([
        workspaceId,
        null,
        'Food & Dining',
        'expense',
        'fork-knife',
        'emerald-500',
        subject,
      ]);
    });

    it('catches 23505 with categories_workspace_top_level_name_idx and throws CategoryNameConflictError', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockRejectedValue({
          code: '23505',
          constraint: 'categories_workspace_top_level_name_idx',
        }),
      };

      await expect(
        adapter.createCategory(client, workspaceId, subject, {
          name: 'Food & Dining',
          kind: 'expense',
          parentId: null,
          icon: null,
          colorToken: null,
        }),
      ).rejects.toThrow(CategoryNameConflictError);
    });

    it('catches 23505 with categories_workspace_parent_name_key and throws CategoryNameConflictError', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockRejectedValue({
          code: '23505',
          constraint: 'categories_workspace_parent_name_key',
        }),
      };

      await expect(
        adapter.createCategory(client, workspaceId, subject, {
          name: 'Groceries',
          kind: 'expense',
          parentId: '00000000-0000-0000-0000-000000003001',
          icon: null,
          colorToken: null,
        }),
      ).rejects.toThrow(CategoryNameConflictError);
    });

    it('rethrows 23505 if constraint name does not match expected unique index/constraint', async () => {
      const otherError = {
        code: '23505',
        constraint: 'categories_other_key',
      };
      const client: TransactionClient = {
        query: vi.fn().mockRejectedValue(otherError),
      };

      await expect(
        adapter.createCategory(client, workspaceId, subject, {
          name: 'Food & Dining',
          kind: 'expense',
          parentId: null,
          icon: null,
          colorToken: null,
        }),
      ).rejects.toEqual(otherError);
    });

    it('catches 23503 with categories_parent_workspace_fkey and throws CategoryParentNotFoundError', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockRejectedValue({
          code: '23503',
          constraint: 'categories_parent_workspace_fkey',
        }),
      };

      await expect(
        adapter.createCategory(client, workspaceId, subject, {
          name: 'Groceries',
          kind: 'expense',
          parentId: '00000000-0000-0000-0000-000000009999',
          icon: null,
          colorToken: null,
        }),
      ).rejects.toThrow(CategoryParentNotFoundError);
    });

    it('rethrows 23503 if constraint name does not match categories_parent_workspace_fkey', async () => {
      const otherFkError = {
        code: '23503',
        constraint: 'categories_created_by_fkey',
      };
      const client: TransactionClient = {
        query: vi.fn().mockRejectedValue(otherFkError),
      };

      await expect(
        adapter.createCategory(client, workspaceId, subject, {
          name: 'Groceries',
          kind: 'expense',
          parentId: '00000000-0000-0000-0000-000000009999',
          icon: null,
          colorToken: null,
        }),
      ).rejects.toEqual(otherFkError);
    });
  });

  describe('listCategories', () => {
    it('queries public.categories with workspace_id, cursorAt, ordering and limit', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: '00000000-0000-0000-0000-000000003001',
              name: 'Food & Dining',
              archived: false,
              parentId: null,
              kind: 'expense',
              icon: 'fork-knife',
              colorToken: 'emerald-500',
              cursorAt: '2026-08-28T12:00:00.000000Z',
            },
          ],
        }),
      };

      const result = await adapter.listCategories(
        client,
        workspaceId,
        undefined,
        51,
      );

      expect(client.query).toHaveBeenCalledTimes(1);
      const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, unknown[]];

      expect(sql).toContain('from public.categories');
      expect(sql).toContain('workspace_id = $1::uuid');
      expect(sql).toContain('order by created_at, id');
      expect(sql).toContain('limit $4');
      expect(values).toEqual([workspaceId, null, null, 51]);

      expect(result).toEqual([
        {
          category: {
            id: '00000000-0000-0000-0000-000000003001',
            name: 'Food & Dining',
            archived: false,
            parentId: null,
            kind: 'expense',
            icon: 'fork-knife',
            colorToken: 'emerald-500',
          },
          cursorAt: '2026-08-28T12:00:00.000000Z',
        },
      ]);
    });
  });
});
