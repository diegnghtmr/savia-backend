import type { Cursor } from '../platform/cursor.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  AgentConversation,
  AgentConversationStore,
  CreateAgentConversationCommand,
} from './agent-conversation.port.js';
interface Row extends Record<string, unknown> {
  id: string;
  title: string;
  modelRef: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}
const map = (r: Row): AgentConversation => ({
  id: r.id,
  title: r.title,
  modelRef: r.modelRef,
  createdAt: new Date(r.createdAt)
    .toISOString()
    .replace(/\.(\d{3})Z$/, '.$1000Z'),
  updatedAt: new Date(r.updatedAt)
    .toISOString()
    .replace(/\.(\d{3})Z$/, '.$1000Z'),
});
export class PostgresAgentConversationAdapter
  implements AgentConversationStore
{
  public createId(): string {
    return crypto.randomUUID();
  }
  public async hasActiveMembership(
    c: TransactionClient,
    workspaceId: string,
  ): Promise<boolean> {
    const r = await c.query<{ role: string | null }>(
      'select public.workspace_actor_active_role($1::uuid) as role',
      [workspaceId],
    );
    return r.rows[0]?.role !== null && r.rows[0]?.role !== undefined;
  }
  public async credentialUsable(
    c: TransactionClient,
    workspaceId: string,
    credentialId: string,
  ): Promise<boolean> {
    const r = await c.query<{ ok: boolean }>(
      "select exists(select 1 from public.ai_credentials where id=$1::uuid and workspace_id=$2::uuid and status='active') as ok",
      [credentialId, workspaceId],
    );
    return r.rows[0]?.ok === true;
  }
  public async create(
    c: TransactionClient,
    workspaceId: string,
    subject: string,
    id: string,
    x: CreateAgentConversationCommand,
  ): Promise<AgentConversation> {
    const r = await c.query<Row>(
      'insert into public.agent_conversations (id,workspace_id,created_by_subject_id,title,model_ref) values ($1,$2::uuid,$3::uuid,$4,$5) returning id,title,model_ref as "modelRef",created_at as "createdAt",updated_at as "updatedAt"',
      [id, workspaceId, subject, x.title, x.modelRef],
    );
    return map(r.rows[0]);
  }
  public async list(
    c: TransactionClient,
    workspaceId: string,
    limit: number,
    cursor?: Cursor,
  ): Promise<readonly AgentConversation[]> {
    const q = cursor
      ? 'select id,title,model_ref as "modelRef",created_at as "createdAt",updated_at as "updatedAt" from public.agent_conversations where workspace_id=$1::uuid and (created_at,id)>($2::timestamptz,$3::uuid) order by created_at,id limit $4'
      : 'select id,title,model_ref as "modelRef",created_at as "createdAt",updated_at as "updatedAt" from public.agent_conversations where workspace_id=$1::uuid order by created_at,id limit $2';
    const r = await c.query<Row>(
      q,
      cursor
        ? [workspaceId, cursor.createdAt, cursor.id, limit]
        : [workspaceId, limit],
    );
    return r.rows.map(map);
  }
}
