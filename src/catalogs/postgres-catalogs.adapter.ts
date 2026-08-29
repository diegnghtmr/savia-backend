import type { Cursor } from '../platform/cursor.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  Category,
  CategoryKind,
  CreateCategoryCommand,
  CreatePayeeCommand,
  CreateTagCommand,
  Payee,
  Tag,
} from './catalogs.port.js';
import {
  CategoryNameConflictError,
  CategoryParentNotFoundError,
  PayeeNameConflictError,
  TagNameConflictError,
  type CatalogsStore,
  type CategoryItem,
  type PayeeItem,
  type TagItem,
} from './catalogs.service.js';

interface NamedResourceRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
  readonly cursorAt?: string;
}

interface CategoryRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
  readonly parentId: string | null;
  readonly kind: string;
  readonly icon: string | null;
  readonly colorToken: string | null;
  readonly cursorAt?: string;
}

export class PostgresCatalogsAdapter implements CatalogsStore {
  public async readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined> {
    const result = await client.query<{ role: string | null }>(
      'select public.workspace_actor_active_role($1::uuid) as role',
      [workspaceId],
    );
    const role = result.rows[0]?.role;
    return typeof role === 'string' ? role : undefined;
  }

  public async createTag(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateTagCommand,
  ): Promise<Tag> {
    const sql = `
insert into public.tags (
  workspace_id,
  name,
  created_by
)
values (
  $1::uuid,
  $2,
  $3::uuid
)
returning
  id::text,
  name,
  archived`;

    const values = [workspaceId, command.name, subject];

    try {
      const result = await client.query<NamedResourceRow>(sql, values);
      const row = result.rows[0];
      if (!row) {
        throw new Error('Created tag row could not be read.');
      }

      return {
        id: row.id,
        name: row.name,
        archived: row.archived,
      };
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: string }).code === '23505' &&
        (error as { constraint?: string }).constraint ===
          'tags_workspace_id_name_key'
      ) {
        throw new TagNameConflictError();
      }
      throw error;
    }
  }

  public async listTags(
    client: TransactionClient,
    workspaceId: string,
    cursor: Cursor | undefined,
    limit: number,
  ): Promise<readonly TagItem[]> {
    const sql = `
select id::text,
       name,
       archived,
       to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
  from public.tags
 where workspace_id = $1::uuid
   and ($2::timestamptz is null or (created_at, id) > ($2::timestamptz, $3::uuid))
 order by created_at, id
 limit $4`;

    const values = [
      workspaceId,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit,
    ];

    const result = await client.query<NamedResourceRow>(sql, values);

    return result.rows.map((row) => ({
      tag: {
        id: row.id,
        name: row.name,
        archived: row.archived,
      },
      cursorAt: row.cursorAt ?? '',
    }));
  }

  public async createPayee(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreatePayeeCommand,
  ): Promise<Payee> {
    const sql = `
insert into public.payees (
  workspace_id,
  name,
  created_by
)
values (
  $1::uuid,
  $2,
  $3::uuid
)
returning
  id::text,
  name,
  archived`;

    const values = [workspaceId, command.name, subject];

    try {
      const result = await client.query<NamedResourceRow>(sql, values);
      const row = result.rows[0];
      if (!row) {
        throw new Error('Created payee row could not be read.');
      }

      return {
        id: row.id,
        name: row.name,
        archived: row.archived,
      };
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: string }).code === '23505' &&
        (error as { constraint?: string }).constraint ===
          'payees_workspace_id_name_key'
      ) {
        throw new PayeeNameConflictError();
      }
      throw error;
    }
  }

  public async listPayees(
    client: TransactionClient,
    workspaceId: string,
    cursor: Cursor | undefined,
    limit: number,
  ): Promise<readonly PayeeItem[]> {
    const sql = `
select id::text,
       name,
       archived,
       to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
  from public.payees
 where workspace_id = $1::uuid
   and ($2::timestamptz is null or (created_at, id) > ($2::timestamptz, $3::uuid))
 order by created_at, id
 limit $4`;

    const values = [
      workspaceId,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit,
    ];

    const result = await client.query<NamedResourceRow>(sql, values);

    return result.rows.map((row) => ({
      payee: {
        id: row.id,
        name: row.name,
        archived: row.archived,
      },
      cursorAt: row.cursorAt ?? '',
    }));
  }

  public async createCategory(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateCategoryCommand,
  ): Promise<Category> {
    const sql = `
insert into public.categories (
  workspace_id,
  parent_id,
  name,
  kind,
  icon,
  color_token,
  created_by
)
values (
  $1::uuid,
  $2::uuid,
  $3,
  $4,
  $5,
  $6,
  $7::uuid
)
returning
  id::text,
  name,
  archived,
  parent_id::text as "parentId",
  kind,
  icon,
  color_token as "colorToken"`;

    const values = [
      workspaceId,
      command.parentId,
      command.name,
      command.kind,
      command.icon,
      command.colorToken,
      subject,
    ];

    try {
      const result = await client.query<CategoryRow>(sql, values);
      const row = result.rows[0];
      if (!row) {
        throw new Error('Created category row could not be read.');
      }

      return {
        id: row.id,
        name: row.name,
        archived: row.archived,
        parentId: row.parentId ?? null,
        kind: row.kind as CategoryKind,
        icon: row.icon ?? null,
        colorToken: row.colorToken ?? null,
      };
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        const pgError = error as { code: string; constraint?: string };
        if (
          pgError.code === '23505' &&
          (pgError.constraint === 'categories_workspace_parent_name_key' ||
            pgError.constraint === 'categories_workspace_top_level_name_idx')
        ) {
          throw new CategoryNameConflictError();
        }
        if (
          pgError.code === '23503' &&
          pgError.constraint === 'categories_parent_workspace_fkey'
        ) {
          throw new CategoryParentNotFoundError();
        }
      }
      throw error;
    }
  }

  public async listCategories(
    client: TransactionClient,
    workspaceId: string,
    cursor: Cursor | undefined,
    limit: number,
  ): Promise<readonly CategoryItem[]> {
    const sql = `
select id::text,
       name,
       archived,
       parent_id::text as "parentId",
       kind,
       icon,
       color_token as "colorToken",
       to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
  from public.categories
 where workspace_id = $1::uuid
   and ($2::timestamptz is null or (created_at, id) > ($2::timestamptz, $3::uuid))
 order by created_at, id
 limit $4`;

    const values = [
      workspaceId,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit,
    ];

    const result = await client.query<CategoryRow>(sql, values);

    return result.rows.map((row) => ({
      category: {
        id: row.id,
        name: row.name,
        archived: row.archived,
        parentId: row.parentId ?? null,
        kind: row.kind as CategoryKind,
        icon: row.icon ?? null,
        colorToken: row.colorToken ?? null,
      },
      cursorAt: row.cursorAt ?? '',
    }));
  }
}
