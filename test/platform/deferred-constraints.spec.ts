import { describe, expect, it, vi } from 'vitest';
import { enforceDeferredConstraints } from '../../src/platform/deferred-constraints.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';

describe('enforceDeferredConstraints', () => {
  it('releases savepoint when no constraint violation occurs', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // DO $$ begin set constraints all immediate...
        .mockResolvedValueOnce({ rows: [{ code: null }] }) // select nullif(...)
        .mockResolvedValueOnce({ rows: [] }), // release savepoint
    };

    await enforceDeferredConstraints(client, 'test_savepoint');

    expect(client.query).toHaveBeenCalledTimes(3);
    const [sql1] = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
    ];
    expect(sql1).toContain('set constraints all immediate');
    const [sql2] = (client.query as ReturnType<typeof vi.fn>).mock.calls[1] as [
      string,
    ];
    expect(sql2).toContain('current_setting');
    const [sql3] = (client.query as ReturnType<typeof vi.fn>).mock.calls[2] as [
      string,
    ];
    expect(sql3).toBe('release savepoint test_savepoint');
  });

  it('rolls back to savepoint and throws 23514 error when check_violation is detected', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // DO $$ ...
        .mockResolvedValueOnce({ rows: [{ code: '23514' }] }) // check returns 23514
        .mockResolvedValueOnce({ rows: [] }) // clear config
        .mockResolvedValueOnce({ rows: [] }), // rollback to savepoint
    };

    let caughtError: unknown;
    try {
      await enforceDeferredConstraints(client, 'test_savepoint');
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as { code: string }).code).toBe('23514');
    expect(client.query).toHaveBeenCalledTimes(4);
    const [sql3] = (client.query as ReturnType<typeof vi.fn>).mock.calls[2] as [
      string,
    ];
    expect(sql3).toContain("set_config('app.check_violation', '', true)");
    const [sql4] = (client.query as ReturnType<typeof vi.fn>).mock.calls[3] as [
      string,
    ];
    expect(sql4).toBe('rollback to savepoint test_savepoint');
  });

  it('handles invocation without a savepoint name', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ code: null }] }),
    };

    await enforceDeferredConstraints(client);
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});
