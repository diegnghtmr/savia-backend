import { describe, expect, it, vi } from 'vitest';
import { PostgresRecurringAdapter } from '../../src/recurring/postgres-recurring.adapter.js';
import { RecurringAccountNotFoundError } from '../../src/recurring/recurring.service.js';
import type { CreateRecurringRuleCommand } from '../../src/recurring/recurring.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';

describe('PostgresRecurringAdapter', () => {
  const adapter = new PostgresRecurringAdapter();
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const subject = '00000000-0000-0000-0000-000000000901';

  const CREATE_COMMAND: CreateRecurringRuleCommand = {
    name: 'Netflix',
    frequency: 'monthly',
    rrule: null,
    behavior: 'create_draft',
    template: {
      type: 'expense',
      accountId: '00000000-0000-0000-0000-000000000001',
      amount: {
        amountMinor: '1599',
        currency: 'USD',
      },
      occurredAt: '2026-08-29T12:00:00.000Z',
      status: 'draft',
      categoryId: null,
      payeeId: null,
      description: null,
      notes: null,
      tagIds: [],
      receiptId: null,
    },
    startsAt: '2026-08-29T12:00:00.000Z',
    endsAt: null,
    nextOccurrenceAt: '2026-09-29T12:00:00.000Z',
    anchorDayOfMonth: 29,
  };

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

  describe('categoryBelongsToWorkspace', () => {
    it('returns true when category exists in workspace', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockResolvedValue({ rowCount: 1 }),
      };

      const result = await adapter.categoryBelongsToWorkspace(
        client,
        workspaceId,
        '00000000-0000-0000-0000-000000000002',
      );
      expect(result).toBe(true);
    });

    it('returns false when category does not exist in workspace', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockResolvedValue({ rowCount: 0 }),
      };

      const result = await adapter.categoryBelongsToWorkspace(
        client,
        workspaceId,
        '00000000-0000-0000-0000-000000000002',
      );
      expect(result).toBe(false);
    });
  });

  describe('payeeBelongsToWorkspace', () => {
    it('returns true when payee exists in workspace', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockResolvedValue({ rowCount: 1 }),
      };

      const result = await adapter.payeeBelongsToWorkspace(
        client,
        workspaceId,
        '00000000-0000-0000-0000-000000000003',
      );
      expect(result).toBe(true);
    });

    it('returns false when payee does not exist in workspace', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockResolvedValue({ rowCount: 0 }),
      };

      const result = await adapter.payeeBelongsToWorkspace(
        client,
        workspaceId,
        '00000000-0000-0000-0000-000000000003',
      );
      expect(result).toBe(false);
    });
  });

  describe('tagsBelongToWorkspace', () => {
    it('returns true for empty tag list', async () => {
      const client: TransactionClient = {
        query: vi.fn(),
      };

      const result = await adapter.tagsBelongToWorkspace(
        client,
        workspaceId,
        [],
      );
      expect(result).toBe(true);
      expect(client.query).not.toHaveBeenCalled();
    });

    it('returns true when count matches tagIds length', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockResolvedValue({ rows: [{ count: 2 }] }),
      };

      const result = await adapter.tagsBelongToWorkspace(client, workspaceId, [
        'id1',
        'id2',
      ]);
      expect(result).toBe(true);
    });

    it('returns false when count is less than tagIds length', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockResolvedValue({ rows: [{ count: 1 }] }),
      };

      const result = await adapter.tagsBelongToWorkspace(client, workspaceId, [
        'id1',
        'id2',
      ]);
      expect(result).toBe(false);
    });
  });

  describe('createRecurringRule', () => {
    it('inserts into public.recurring_rules and returns rule projection', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: '00000000-0000-0000-0000-000000001001',
              name: 'Netflix',
              frequency: 'monthly',
              rrule: null,
              behavior: 'create_draft',
              template: CREATE_COMMAND.template,
              active: true,
              nextOccurrenceAt: new Date('2026-09-29T12:00:00.000Z'),
            },
          ],
        }),
      };

      const rule = await adapter.createRecurringRule(
        client,
        workspaceId,
        subject,
        CREATE_COMMAND,
      );

      expect(rule.id).toBe('00000000-0000-0000-0000-000000001001');
      expect(rule.name).toBe('Netflix');
      expect(rule.frequency).toBe('monthly');
      expect(rule.nextOccurrenceAt).toBe('2026-09-29T12:00:00.000Z');

      const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, unknown[]];
      expect(sql).toContain('insert into public.recurring_rules');
      expect(values).toContain(workspaceId);
      expect(values).toContain('Netflix');
      expect(values).toContain(subject);
    });

    it('catches 23503 on recurring_rules_account_workspace_fkey and throws RecurringAccountNotFoundError', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockRejectedValue({
          code: '23503',
          constraint: 'recurring_rules_account_workspace_fkey',
        }),
      };

      await expect(
        adapter.createRecurringRule(
          client,
          workspaceId,
          subject,
          CREATE_COMMAND,
        ),
      ).rejects.toThrow(RecurringAccountNotFoundError);
    });

    it('rethrows unexpected pg errors', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockRejectedValue(new Error('connection failure')),
      };

      await expect(
        adapter.createRecurringRule(
          client,
          workspaceId,
          subject,
          CREATE_COMMAND,
        ),
      ).rejects.toThrow('connection failure');
    });
  });

  describe('listRecurringRules', () => {
    it('executes select with total seek key', async () => {
      const client: TransactionClient = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: '00000000-0000-0000-0000-000000001001',
              name: 'Netflix',
              frequency: 'monthly',
              rrule: null,
              behavior: 'create_draft',
              template: CREATE_COMMAND.template,
              active: true,
              nextOccurrenceAt: '2026-09-29T12:00:00.000Z',
              cursorAt: '2026-08-29T12:00:00.000000Z',
            },
          ],
        }),
      };

      const result = await adapter.listRecurringRules(
        client,
        workspaceId,
        undefined,
        50,
      );

      expect(result).toHaveLength(1);
      expect(result[0]!.rule.id).toBe('00000000-0000-0000-0000-000000001001');
      expect(result[0]!.cursorAt).toBe('2026-08-29T12:00:00.000000Z');

      const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, unknown[]];
      expect(sql).toContain('select id::text');
      expect(sql).toContain('from public.recurring_rules');
      expect(sql).toContain('order by created_at, id');
      expect(values).toEqual([workspaceId, null, null, 50]);
    });
  });
});
