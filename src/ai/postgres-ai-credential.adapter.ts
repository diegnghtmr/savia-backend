import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  CredentialMetadata,
  Store,
  CreateCredentialCommand,
  UpdateCredentialCommand,
} from './ai-credential.port.js';
interface Row extends Record<string, unknown> {
  id: string;
  ownerType: 'user' | 'workspace';
  ownerSubjectId: string | null;
  providerId: string;
  credentialType: string;
  maskedIdentifier: string;
  alias: string | null;
  status: 'active' | 'disabled' | 'revoked';
  lastUsedAt: Date | string | null;
  expiresAt: Date | string | null;
  createdAt: Date | string;
  version: number;
}
const map = (
  r: Row,
): CredentialMetadata & { version: number; providerId: string } => ({
  ...r,
  lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : null,
  expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
  createdAt: new Date(r.createdAt).toISOString(),
  credentialType: r.credentialType as CredentialMetadata['credentialType'],
});
export class PostgresAICredentialAdapter implements Store {
  public createId(): string {
    return crypto.randomUUID();
  }
  public async list(c: TransactionClient, w: string) {
    const r = await c.query<Row>(
      'select id, owner_type as "ownerType", case when owner_type = \'user\' then created_by_subject_id end as "ownerSubjectId", provider_id as "providerId", credential_type as "credentialType", masked_identifier as "maskedIdentifier", alias, status, last_used_at as "lastUsedAt", expires_at as "expiresAt", created_at as "createdAt", version from public.ai_credentials where workspace_id=$1::uuid order by created_at,id',
      [w],
    );
    return r.rows.map(map);
  }
  public async create(
    c: TransactionClient,
    w: string,
    id: string,
    x: CreateCredentialCommand,
  ) {
    const masked = x.maskedIdentifier ?? '••••';
    const r = await c.query<Row>(
      'insert into public.ai_credentials (id,workspace_id,owner_type,provider_id,credential_type,encrypted_secret,masked_identifier,alias,metadata,created_by_subject_id) values ($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,nullif(current_setting(\'app.subject_id\', true), \'\')::uuid) returning id,owner_type as "ownerType",case when owner_type = \'user\' then created_by_subject_id end as "ownerSubjectId",provider_id as "providerId",credential_type as "credentialType",masked_identifier as "maskedIdentifier",alias,status,last_used_at as "lastUsedAt",expires_at as "expiresAt",created_at as "createdAt",version',
      [
        id,
        w,
        x.ownerType,
        x.providerId,
        x.credentialType,
        x.secret,
        masked,
        x.alias,
        JSON.stringify(x.metadata),
      ],
    );
    return map(r.rows[0]);
  }
  public async find(c: TransactionClient, w: string, id: string) {
    const r = await c.query<Row>(
      'select id,owner_type as "ownerType",case when owner_type = \'user\' then created_by_subject_id end as "ownerSubjectId",provider_id as "providerId",credential_type as "credentialType",masked_identifier as "maskedIdentifier",alias,status,last_used_at as "lastUsedAt",expires_at as "expiresAt",created_at as "createdAt",version from public.ai_credentials where workspace_id=$1::uuid and id=$2::uuid',
      [w, id],
    );
    return r.rows[0] ? map(r.rows[0]) : undefined;
  }
  public async update(
    c: TransactionClient,
    w: string,
    id: string,
    x: UpdateCredentialCommand,
    v: number,
  ) {
    const r = await c.query<Row>(
      'update public.ai_credentials set alias=case when $3 then $4 else alias end,status=coalesce($5,status),encrypted_secret=coalesce($6,encrypted_secret),masked_identifier=coalesce($8,masked_identifier),version=version+1,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid and version=$7 and status<>\'revoked\' returning id,owner_type as "ownerType",case when owner_type = \'user\' then created_by_subject_id end as "ownerSubjectId",provider_id as "providerId",credential_type as "credentialType",masked_identifier as "maskedIdentifier",alias,status,last_used_at as "lastUsedAt",expires_at as "expiresAt",created_at as "createdAt",version',
      [
        w,
        id,
        'alias' in x,
        x.alias ?? null,
        x.status ?? null,
        x.replacementSecret ?? null,
        v,
        x.maskedIdentifier ?? null,
      ],
    );
    return r.rows[0] ? map(r.rows[0]) : undefined;
  }
  public async revoke(c: TransactionClient, w: string, id: string) {
    const r = await c.query(
      "update public.ai_credentials set status='revoked',version=version+1,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid and status<>'revoked'",
      [w, id],
    );
    return r.rowCount === 1;
  }
  public async setDefault(
    c: TransactionClient,
    w: string,
    m: string,
    id: string | null,
  ) {
    const provider = m.split(':', 1)[0];
    const r = await c.query(
      "insert into public.ai_default_models (workspace_id,model_ref,credential_id) select $1::uuid,$2,$3::uuid where $3 is null or exists(select 1 from public.ai_credentials where id=$3::uuid and workspace_id=$1::uuid and provider_id=$4 and owner_type='workspace' and status='active') on conflict (workspace_id) do update set model_ref=excluded.model_ref,credential_id=excluded.credential_id",
      [w, m, id, provider],
    );
    return r.rowCount === 1;
  }
}
