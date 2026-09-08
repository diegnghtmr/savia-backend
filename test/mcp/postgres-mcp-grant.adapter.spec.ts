import { describe, expect, it, vi } from 'vitest';
import { PostgresMcpGrantAdapter } from '../../src/mcp/postgres-mcp-grant.adapter.js';
const subject = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
describe('PostgresMcpGrantAdapter', () => {
  it('uses subject-bound total-order cursor comparison and ordering', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await new PostgresMcpGrantAdapter().list({ query } as never, subject, 2, {
      createdAt: '2026-01-01T00:00:00.000000Z',
      id,
    });
    expect(query.mock.calls[0][0]).toContain('(created_at, id) >');
    expect(query.mock.calls[0][0]).toContain('order by created_at, id');
    expect(query.mock.calls[0][1]).toEqual([
      '2026-01-01T00:00:00.000000Z',
      id,
      2,
    ]);
  });
  it('checks every workspace membership', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ role: 'owner' }] })
      .mockResolvedValueOnce({ rows: [{ role: null }] });
    await expect(
      new PostgresMcpGrantAdapter().hasActiveMemberships(
        { query } as never,
        subject,
        [id, subject],
      ),
    ).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('uses all revoke preconditions and returns row-count success', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    await expect(
      new PostgresMcpGrantAdapter().revoke(
        { query } as never,
        subject,
        id,
        new Date(0),
      ),
    ).resolves.toBe(true);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('subject_id = $1::uuid');
    expect(sql).toContain('id = $2::uuid');
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain('expires_at');
    query.mockResolvedValue({ rowCount: 0 });
    await expect(
      new PostgresMcpGrantAdapter().revoke(
        { query } as never,
        subject,
        id,
        new Date(0),
      ),
    ).resolves.toBe(false);
  });
  it('maps database rows and amount values', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id,
          clientName: 'client',
          scopes: ['accounts:read'],
          workspaceIds: [subject],
          accountIds: null,
          maxWriteAmountMinor: '9007199254740993',
          maxWriteCurrency: 'USD',
          status: 'active',
          expiresAt: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    await expect(
      new PostgresMcpGrantAdapter().find({ query } as never, subject, id),
    ).resolves.toMatchObject({
      id,
      maxWriteAmount: { amountMinor: '9007199254740993', currency: 'USD' },
    });
  });
  it('converts the validated wire expiry string to a Date at the database boundary', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id,
          clientName: 'client',
          scopes: ['accounts:read'],
          workspaceIds: [subject],
          accountIds: null,
          maxWriteAmountMinor: null,
          maxWriteCurrency: null,
          status: 'active',
          expiresAt: '2026-01-01T00:00:00Z',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    await new PostgresMcpGrantAdapter().create(
      { query } as never,
      subject,
      id,
      {
        clientName: 'client',
        scopes: ['accounts:read'],
        workspaceIds: [subject],
        maxWriteAmount: null,
        expiresAt: '2026-01-01T00:00:00.000Z',
      },
    );
    expect(query.mock.calls[0][1][8]).toEqual(
      new Date('2026-01-01T00:00:00.000Z'),
    );
  });
});
