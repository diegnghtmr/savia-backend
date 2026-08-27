import type { TransactionClient } from './pg-transaction.js';

export async function enforceDeferredConstraints(
  client: TransactionClient,
  savepointName?: string,
): Promise<void> {
  await client.query(`
      do $$
      begin
        set constraints all immediate;
      exception
        when check_violation then
          perform set_config('app.check_violation', '23514', true);
      end;
      $$;
    `);
  const check = await client.query<{ code: string | null }>(
    "select nullif(current_setting('app.check_violation', true), '') as code",
  );
  if (check.rows[0]?.code === '23514') {
    await client.query("select set_config('app.check_violation', '', true)");
    if (savepointName !== undefined) {
      await client
        .query(`rollback to savepoint ${savepointName}`)
        .catch(() => undefined);
    }
    const err = new Error('check_violation: deferred constraint violation');
    Object.assign(err, { code: '23514' });
    throw err;
  }
  if (savepointName !== undefined) {
    await client
      .query(`release savepoint ${savepointName}`)
      .catch(() => undefined);
  }
}
