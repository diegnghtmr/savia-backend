import { encodeCursor } from '../platform/cursor.js';
import type { Cursor } from '../platform/cursor.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  CATALOG_CREATE_OUTCOMES,
  CATALOG_LIST_OUTCOMES,
  type CatalogsPort,
  type CreatePayeeCommand,
  type CreateTagCommand,
  type Payee,
  type PayeeCreateOutcome,
  type PayeeListOutcome,
  type PayeeListQuery,
  type Tag,
  type TagCreateOutcome,
  type TagListOutcome,
  type TagListQuery,
} from './catalogs.port.js';

export interface CatalogsTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export class CatalogNameConflictError extends Error {
  public constructor(
    message = 'Named resource with this name already exists in the workspace.',
  ) {
    super(message);
    this.name = 'CatalogNameConflictError';
  }
}

export class TagNameConflictError extends CatalogNameConflictError {
  public constructor() {
    super('Tag with this name already exists in the workspace.');
    this.name = 'TagNameConflictError';
  }
}

export class PayeeNameConflictError extends CatalogNameConflictError {
  public constructor() {
    super('Payee with this name already exists in the workspace.');
    this.name = 'PayeeNameConflictError';
  }
}

export interface TagItem {
  readonly tag: Tag;
  readonly cursorAt: string;
}

export interface PayeeItem {
  readonly payee: Payee;
  readonly cursorAt: string;
}

export interface CatalogsStore {
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;

  createTag(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateTagCommand,
  ): Promise<Tag>;

  listTags(
    client: TransactionClient,
    workspaceId: string,
    cursor: Cursor | undefined,
    limit: number,
  ): Promise<readonly TagItem[]>;

  createPayee(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreatePayeeCommand,
  ): Promise<Payee>;

  listPayees(
    client: TransactionClient,
    workspaceId: string,
    cursor: Cursor | undefined,
    limit: number,
  ): Promise<readonly PayeeItem[]>;
}

export class CatalogsService implements CatalogsPort {
  public constructor(
    private readonly transaction: CatalogsTransaction,
    private readonly store: CatalogsStore,
    private readonly idempotencyStore: IdempotencyStore,
  ) {}

  public async createTag(
    subject: string,
    workspaceId: string,
    command: CreateTagCommand,
    idempotencyKey: string,
  ): Promise<TagCreateOutcome> {
    const route = 'POST /v1/tags';
    const fingerprint = computeRequestFingerprint(command);

    return this.transaction.run(subject, async (client) => {
      // 1. Role check: owner, administrator, editor
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        role === undefined ||
        !['owner', 'administrator', 'editor'].includes(role)
      ) {
        return { kind: CATALOG_CREATE_OUTCOMES.FORBIDDEN };
      }

      // 2. Idempotency read
      const existing = await this.idempotencyStore.read(
        client,
        subject,
        route,
        idempotencyKey,
        workspaceId,
      );
      if (existing !== undefined) {
        if (existing.requestFingerprint !== fingerprint) {
          return { kind: CATALOG_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT };
        }
        return {
          kind: CATALOG_CREATE_OUTCOMES.REPLAYED,
          status: existing.responseStatus,
          etag: existing.responseEtag,
          body: existing.responseBody,
        };
      }

      // 3. Create tag in store
      let tag: Tag;
      try {
        tag = await this.store.createTag(client, workspaceId, subject, command);
      } catch (error) {
        if (
          error instanceof TagNameConflictError ||
          error instanceof CatalogNameConflictError
        ) {
          return { kind: CATALOG_CREATE_OUTCOMES.CONFLICT };
        }
        throw error;
      }

      // 4. Write idempotency record (NO ETag response header for tag creation)
      const written = await this.idempotencyStore.write(
        client,
        subject,
        route,
        idempotencyKey,
        fingerprint,
        201,
        null,
        tag,
        workspaceId,
      );

      if (!written) {
        const reread = await this.idempotencyStore.read(
          client,
          subject,
          route,
          idempotencyKey,
          workspaceId,
        );
        if (reread !== undefined) {
          if (reread.requestFingerprint !== fingerprint) {
            return { kind: CATALOG_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT };
          }
          return {
            kind: CATALOG_CREATE_OUTCOMES.REPLAYED,
            status: reread.responseStatus,
            etag: reread.responseEtag,
            body: reread.responseBody,
          };
        }
      }

      return {
        kind: CATALOG_CREATE_OUTCOMES.CREATED,
        tag,
      };
    });
  }

  public async listTags(
    subject: string,
    query: TagListQuery,
  ): Promise<TagListOutcome> {
    return this.transaction.runRead(subject, async (client) => {
      // 1. Role check: any active member (owner, administrator, editor, viewer)
      const role = await this.store.readActiveRole(client, query.workspaceId);
      if (
        role === undefined ||
        !['owner', 'administrator', 'editor', 'viewer'].includes(role)
      ) {
        return { kind: CATALOG_LIST_OUTCOMES.FORBIDDEN };
      }

      // 2. Query tags via store (fetch limit + 1 to compute hasNextPage)
      const rows = await this.store.listTags(
        client,
        query.workspaceId,
        query.cursor,
        query.limit + 1,
      );

      const hasNextPage = rows.length > query.limit;
      const visible = hasNextPage ? rows.slice(0, query.limit) : rows;
      const items = visible.map((entry) => entry.tag);
      const lastItem = visible[visible.length - 1];
      const nextCursor =
        hasNextPage && lastItem !== undefined
          ? encodeCursor({
              workspaceId: query.workspaceId,
              createdAt: lastItem.cursorAt,
              id: lastItem.tag.id,
            })
          : null;

      return {
        kind: CATALOG_LIST_OUTCOMES.OK,
        page: {
          items,
          pageInfo: {
            hasNextPage,
            nextCursor,
          },
        },
      };
    });
  }

  public async createPayee(
    subject: string,
    workspaceId: string,
    command: CreatePayeeCommand,
    idempotencyKey: string,
  ): Promise<PayeeCreateOutcome> {
    const route = 'POST /v1/payees';
    const fingerprint = computeRequestFingerprint(command);

    return this.transaction.run(subject, async (client) => {
      // 1. Role check: owner, administrator, editor
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        role === undefined ||
        !['owner', 'administrator', 'editor'].includes(role)
      ) {
        return { kind: CATALOG_CREATE_OUTCOMES.FORBIDDEN };
      }

      // 2. Idempotency read
      const existing = await this.idempotencyStore.read(
        client,
        subject,
        route,
        idempotencyKey,
        workspaceId,
      );
      if (existing !== undefined) {
        if (existing.requestFingerprint !== fingerprint) {
          return { kind: CATALOG_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT };
        }
        return {
          kind: CATALOG_CREATE_OUTCOMES.REPLAYED,
          status: existing.responseStatus,
          etag: existing.responseEtag,
          body: existing.responseBody,
        };
      }

      // 3. Create payee in store
      let payee: Payee;
      try {
        payee = await this.store.createPayee(
          client,
          workspaceId,
          subject,
          command,
        );
      } catch (error) {
        if (
          error instanceof PayeeNameConflictError ||
          error instanceof CatalogNameConflictError
        ) {
          return { kind: CATALOG_CREATE_OUTCOMES.CONFLICT };
        }
        throw error;
      }

      // 4. Write idempotency record (NO ETag response header for payee creation)
      const written = await this.idempotencyStore.write(
        client,
        subject,
        route,
        idempotencyKey,
        fingerprint,
        201,
        null,
        payee,
        workspaceId,
      );

      if (!written) {
        const reread = await this.idempotencyStore.read(
          client,
          subject,
          route,
          idempotencyKey,
          workspaceId,
        );
        if (reread !== undefined) {
          if (reread.requestFingerprint !== fingerprint) {
            return { kind: CATALOG_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT };
          }
          return {
            kind: CATALOG_CREATE_OUTCOMES.REPLAYED,
            status: reread.responseStatus,
            etag: reread.responseEtag,
            body: reread.responseBody,
          };
        }
      }

      return {
        kind: CATALOG_CREATE_OUTCOMES.CREATED,
        payee,
      };
    });
  }

  public async listPayees(
    subject: string,
    query: PayeeListQuery,
  ): Promise<PayeeListOutcome> {
    return this.transaction.runRead(subject, async (client) => {
      // 1. Role check: any active member (owner, administrator, editor, viewer)
      const role = await this.store.readActiveRole(client, query.workspaceId);
      if (
        role === undefined ||
        !['owner', 'administrator', 'editor', 'viewer'].includes(role)
      ) {
        return { kind: CATALOG_LIST_OUTCOMES.FORBIDDEN };
      }

      // 2. Query payees via store (fetch limit + 1 to compute hasNextPage)
      const rows = await this.store.listPayees(
        client,
        query.workspaceId,
        query.cursor,
        query.limit + 1,
      );

      const hasNextPage = rows.length > query.limit;
      const visible = hasNextPage ? rows.slice(0, query.limit) : rows;
      const items = visible.map((entry) => entry.payee);
      const lastItem = visible[visible.length - 1];
      const nextCursor =
        hasNextPage && lastItem !== undefined
          ? encodeCursor({
              workspaceId: query.workspaceId,
              createdAt: lastItem.cursorAt,
              id: lastItem.payee.id,
            })
          : null;

      return {
        kind: CATALOG_LIST_OUTCOMES.OK,
        page: {
          items,
          pageInfo: {
            hasNextPage,
            nextCursor,
          },
        },
      };
    });
  }
}
