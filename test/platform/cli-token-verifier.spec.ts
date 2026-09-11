import { describe, expect, it, vi } from 'vitest';
import { CliTokenVerifier } from '../../src/platform/cli-token-verifier.js';

describe('CliTokenVerifier', () => {
  // Covers migration 202609100014_cli_token_scopes.sql.
  it('returns the subject and scopes from the active token record', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ subject_id: 'subject', scopes: ['accounts:read'] }],
    });
    const transaction = {
      runAnonymous: vi.fn(async (callback: (client: unknown) => unknown) =>
        callback({ query }),
      ),
    };

    await expect(
      new CliTokenVerifier(transaction as never).verify('svt_token'),
    ).resolves.toEqual({
      subject: 'subject',
      authMethod: 'cli_token',
      scopes: ['accounts:read'],
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('subject_id, scopes'),
      [expect.any(String)],
    );
  });
});
