import { describe, expect, it, vi } from 'vitest';
import { PostgresMcpGrantAdapter } from '../../src/mcp/postgres-mcp-grant.adapter.js';
const subject = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
describe('PostgresMcpGrantAdapter', () => {
  describe('authorizeMcpGrant', () => {
    const amount = (amountMinor: string, currency = 'USD') => ({
      amountMinor,
      currency,
    });
    const call = {
      grantId: id,
      subject,
      workspaceId: subject,
      toolName: 'create_transfer',
      accountIds: [subject, id],
      amounts: [amount('9007199254740993')],
    };
    const read = {
      ...call,
      toolName: 'get_account_balance',
      accountIds: [subject],
      amounts: [],
    };
    const policy = {
      localDay: 7,
      localTime: '09:00',
      role: 'editor',
      toolAllowlist: ['create_transfer'],
      schedule: [{ dayOfWeek: 7, startTime: '09:00', endTime: '17:00' }],
      maxWriteAmountMinor: '9007199254740993',
      maxWriteCurrency: 'USD',
    };
    const invalidWindow = {
      dayOfWeek: 8,
      startTime: '00:00',
      endTime: '24:00',
    };
    const invalidSchedule = [...policy.schedule, invalidWindow];
    const readOnly = { ...policy, toolAllowlist: [] };
    const withAmounts = (...amounts: (typeof call)['amounts']) => ({
      ...call,
      amounts,
    });
    it.each([
      ['inclusive start at exact limit', policy, call, true],
      ['exclusive end', { ...policy, localTime: '17:00' }, call, false],
      ['wrong weekday', { ...policy, localDay: 1 }, call, false],
      ['empty schedule', { ...policy, schedule: [] }, call, false],
      [
        'invalid stored window',
        { ...policy, schedule: invalidSchedule },
        call,
        false,
      ],
      ['read-only grant', readOnly, call, false],
      ['omitted listed read', policy, read, false],
      ['read under a read-only grant', readOnly, read, true],
      [
        'amount over by a minor unit',
        policy,
        withAmounts(amount('9007199254740994')),
        false,
      ],
      [
        'negative amount over by a minor unit',
        policy,
        withAmounts(amount('-9007199254740994')),
        false,
      ],
      [
        'multiple amounts cannot exceed the cap in aggregate',
        policy,
        withAmounts(...call.amounts, amount('-1')),
        false,
      ],
      ['different currency', policy, withAmounts(amount('1', 'EUR')), false],
      ['no resolved amount', policy, withAmounts(), false],
      [
        'only one transfer account',
        policy,
        { ...call, accountIds: [subject] },
        false,
      ],
      [
        'duplicate transfer account',
        policy,
        { ...call, accountIds: [subject, subject] },
        false,
      ],
      ['unknown annotation', policy, { ...call, toolName: '__proto__' }, false],
      ['missing DB authorization context', undefined, call, false],
    ] as const)('%s', async (_name, row, input, allowed) => {
      const query = vi.fn().mockResolvedValue({ rows: row ? [row] : [] });
      await expect(
        new PostgresMcpGrantAdapter().authorizeMcpGrant(
          { query } as never,
          input,
        ),
      ).resolves.toBe(allowed);
    });
  });
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
  it('returns the database minting decision for every workspace', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ allowed: false }] });
    await expect(
      new PostgresMcpGrantAdapter().canMint(
        { query } as never,
        subject,
        ['accounts:read'],
        [id, subject],
      ),
    ).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('asks PostgreSQL whether the requested grant fits every minter role', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ allowed: false }] });

    await expect(
      new PostgresMcpGrantAdapter().canMint(
        { query } as never,
        subject,
        ['accounts:write'],
        [id],
      ),
    ).resolves.toBe(false);

    expect(query).toHaveBeenCalledWith(
      'select public.mcp_grant_within_minter_role($1::text[], $2::uuid[]) as allowed',
      [['accounts:write'], [id]],
    );
  });
  it('asks PostgreSQL whether every requested account fits the named workspaces', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ allowed: false }] });

    await expect(
      new PostgresMcpGrantAdapter().accountsBelongToWorkspaces(
        { query } as never,
        [id],
        [subject],
      ),
    ).resolves.toBe(false);

    expect(query).toHaveBeenCalledWith(
      'select public.mcp_grant_accounts_within_workspaces($1::uuid[], $2::uuid[]) as allowed',
      [[id], [subject]],
    );
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
        toolAllowlist: [],
        schedule: [],
        maxWriteAmount: null,
        expiresAt: '2026-01-01T00:00:00.000Z',
      },
    );
    expect(query.mock.calls[0][1][8]).toEqual(
      new Date('2026-01-01T00:00:00.000Z'),
    );
  });
});
