import { createHash } from 'node:crypto';
import type { RequestIdentity } from './request-identity.js';
import type { PgTransaction } from './pg-transaction.js';
import type { SaviaScope } from './savia-scopes.js';

export class CliTokenVerifier {
  public constructor(private readonly transaction: PgTransaction) {}
  public async verify(token: string): Promise<RequestIdentity> {
    const hash = createHash('sha256').update(token).digest('hex');
    const result = await this.transaction.runAnonymous(async (client) => {
      const rows = await client.query<{
        subject_id: string;
        scopes: SaviaScope[];
      }>('select subject_id, scopes from public.verify_cli_device_token($1)', [
        hash,
      ]);
      return rows.rows[0];
    });
    if (result === undefined) throw new Error('Invalid CLI token.');
    return {
      subject: result.subject_id,
      authMethod: 'cli_token',
      scopes: result.scopes,
    };
  }
}
