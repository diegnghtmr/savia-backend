import { describe, expect, it, vi } from 'vitest';
import { PostgresAICredentialAdapter } from '../../src/ai/postgres-ai-credential.adapter.js';

const workspace = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const row = {
  id,
  ownerType: 'user' as const,
  ownerSubjectId: '33333333-3333-4333-8333-333333333333',
  providerId: 'openai',
  credentialType: 'api_key',
  maskedIdentifier: '••••1234',
  alias: null,
  status: 'active' as const,
  lastUsedAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  version: 7,
};

describe('PostgresAICredentialAdapter', () => {
  it('uses workspace and ordered SQL for list and find', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const adapter = new PostgresAICredentialAdapter();
    await adapter.list({ query } as never, workspace);
    expect(query.mock.calls[0]?.[0]).toContain('workspace_id=$1::uuid');
    expect(query.mock.calls[0]?.[0]).toContain('order by created_at,id');
    await adapter.find({ query } as never, workspace, id);
    expect(query.mock.calls[1]?.[0]).toContain('id=$2::uuid');
    expect(query.mock.calls[1]?.[1]).toEqual([workspace, id]);
  });

  it('maps PostgreSQL runtime timestamptz Date and integer version without coercing them incorrectly', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const result = await new PostgresAICredentialAdapter().find(
      { query } as never,
      workspace,
      id,
    );
    expect(result).toMatchObject({
      id,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: '2026-01-01T00:00:00.000Z',
      version: 7,
    });
    expect(typeof row.createdAt).toBe('object');
    expect(typeof row.version).toBe('number');
  });

  it('writes create values in the expected SQL shape and masks by default', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    await new PostgresAICredentialAdapter().create(
      { query } as never,
      workspace,
      id,
      {
        ownerType: 'workspace',
        providerId: 'openai',
        credentialType: 'api_key',
        secret: 'encrypted',
        alias: null,
        metadata: { region: 'us' },
      },
    );
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('insert into public.ai_credentials');
    expect(sql).toContain('encrypted_secret');
    expect(values).toEqual([
      id,
      workspace,
      'workspace',
      'openai',
      'api_key',
      'encrypted',
      '••••',
      null,
      '{"region":"us"}',
    ]);
  });

  it('keeps update version and revoked status guards', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    await new PostgresAICredentialAdapter().update(
      { query } as never,
      workspace,
      id,
      { status: 'disabled' },
      7,
    );
    const updateSql = query.mock.calls[0]?.[0] as string;
    expect(updateSql).toContain('workspace_id=$1::uuid');
    expect(updateSql).toContain('id=$2::uuid');
    expect(updateSql).toContain('version=$7');
    expect(updateSql).toContain("status<>'revoked'");
    await new PostgresAICredentialAdapter().revoke(
      { query } as never,
      workspace,
      id,
    );
    const clearDefaultSql = query.mock.calls[1]?.[0] as string;
    expect(clearDefaultSql).toContain('delete from public.ai_default_models');
    const revokeSql = query.mock.calls[2]?.[0] as string;
    expect(revokeSql).toContain('workspace_id=$1::uuid');
    expect(revokeSql).toContain('id=$2::uuid');
    expect(revokeSql).toContain("status<>'revoked'");
  });

  it('sends explicit null as a clear-alias operation while omission preserves it', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    await new PostgresAICredentialAdapter().update(
      { query } as never,
      workspace,
      id,
      { alias: null },
      7,
    );
    expect(query.mock.calls[0]?.[0]).toContain(
      'case when $3 then $4 else alias end',
    );
    expect((query.mock.calls[0]?.[1] as unknown[]).slice(2, 4)).toEqual([
      true,
      null,
    ]);
    await new PostgresAICredentialAdapter().update(
      { query } as never,
      workspace,
      id,
      { status: 'disabled' },
      7,
    );
    expect((query.mock.calls[1]?.[1] as unknown[]).slice(2, 4)).toEqual([
      false,
      null,
    ]);
  });

  it('checks provider/workspace/active credential compatibility for defaults', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    await expect(
      new PostgresAICredentialAdapter().setDefault(
        { query } as never,
        workspace,
        'openai:gpt-5',
        id,
      ),
    ).resolves.toBe(true);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('workspace_id=$1::uuid');
    expect(sql).toContain('provider_id=$4');
    expect(sql).toContain("status='active'");
    expect(sql).toContain("owner_type='workspace'");
    expect(values).toEqual([workspace, 'openai:gpt-5', id, 'openai']);
  });

  it('projects the owner subject only for user-owned credentials', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ ...row, ownerSubjectId: row.ownerSubjectId }],
    });
    const result = await new PostgresAICredentialAdapter().find(
      { query } as never,
      workspace,
      id,
    );
    expect(result?.ownerSubjectId).toBe(row.ownerSubjectId);
    expect(query.mock.calls[0]?.[0]).toContain(
      'case when owner_type = \'user\' then created_by_subject_id end as "ownerSubjectId"',
    );
  });
});
