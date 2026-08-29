import { describe, expect, it, vi } from 'vitest';
import { PostgresCatalogsAdapter } from '../../src/catalogs/postgres-catalogs.adapter.js';
import {
  TagNameConflictError,
  PayeeNameConflictError,
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
});
