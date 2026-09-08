import { randomUUID } from 'node:crypto';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type { AgentEvent, AgentMessageStore } from './agent-message.port.js';
export class PostgresAgentMessageAdapter implements AgentMessageStore {
  public createId(): string {
    return randomUUID();
  }
  public async conversationExists(
    client: TransactionClient,
    workspaceId: string,
    conversationId: string,
  ): Promise<boolean> {
    const r = await client.query(
      'select 1 from public.agent_conversations where workspace_id=$1::uuid and id=$2::uuid',
      [workspaceId, conversationId],
    );
    return r.rows.length > 0;
  }
  public async consumeRateLimit(
    client: TransactionClient,
    subject: string,
    workspaceId: string,
    conversationId: string,
    now: string,
  ): Promise<boolean> {
    const r = await client.query<{ allowed: boolean }>(
      'select public.consume_agent_message_rate_limit($1::uuid,$2::uuid,$3::uuid,$4::timestamptz) as allowed',
      [subject, workspaceId, conversationId, now],
    );
    return r.rows[0]?.allowed ?? false;
  }
  public async saveRun(
    client: TransactionClient,
    workspaceId: string,
    conversationId: string,
    subject: string,
    runId: string,
    message: string,
    events: readonly AgentEvent[],
  ): Promise<void> {
    await client.query(
      'insert into public.agent_message_runs (id,workspace_id,conversation_id,created_by_subject_id,message,events) values ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::jsonb)',
      [
        runId,
        workspaceId,
        conversationId,
        subject,
        message,
        JSON.stringify(events),
      ],
    );
  }
  public async readRun(): Promise<readonly AgentEvent[] | undefined> {
    return undefined;
  }
  public async saveIdempotency(
    client: TransactionClient,
    subject: string,
    workspaceId: string,
    conversationId: string,
    key: string,
    fingerprint: string,
    events: readonly AgentEvent[],
  ): Promise<boolean> {
    const r = await client.query(
      'insert into public.agent_message_idempotency(subject_id,workspace_id,conversation_id,idempotency_key,request_fingerprint,events) values ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb) on conflict do nothing returning conversation_id',
      [
        subject,
        workspaceId,
        conversationId,
        key,
        fingerprint,
        JSON.stringify(events),
      ],
    );
    return r.rows.length > 0;
  }
  public async readIdempotency(
    client: TransactionClient,
    subject: string,
    workspaceId: string,
    conversationId: string,
    key: string,
  ): Promise<
    { fingerprint: string; events: readonly AgentEvent[] } | undefined
  > {
    const r = await client.query<{
      fingerprint: string;
      events: readonly AgentEvent[];
    }>(
      'select request_fingerprint as fingerprint,events from public.agent_message_idempotency where subject_id=$1::uuid and workspace_id=$2::uuid and conversation_id=$3::uuid and idempotency_key=$4',
      [subject, workspaceId, conversationId, key],
    );
    return r.rows[0];
  }
}
