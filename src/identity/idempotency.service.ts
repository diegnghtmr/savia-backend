import { createHash } from 'node:crypto';

import type { TransactionClient } from './pg-transaction.js';
import {
  IDEMPOTENCY_OUTCOME_KINDS,
  type IdempotencyOutcome,
  type IdempotencyPort,
  type IdempotencyRequest,
  type IdempotencyStore,
  type StoredResponse,
} from './idempotency.port.js';

export interface IdempotencyTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const val = obj[key];
    if (val !== undefined) {
      result[key] = canonicalizeValue(val);
    }
  }
  return result;
}

export function canonicalJson(value: unknown): string {
  const canonical = canonicalizeValue(value);
  return JSON.stringify(canonical);
}

export function computeRequestFingerprint(payload: unknown): string {
  const serialized = canonicalJson(payload);
  return createHash('sha256').update(serialized).digest('hex');
}

export class IdempotencyService implements IdempotencyPort {
  public constructor(
    private readonly transaction: IdempotencyTransaction,
    private readonly store: IdempotencyStore,
  ) {}

  public execute<TResult extends StoredResponse>(
    request: IdempotencyRequest,
    operation: (client: TransactionClient) => Promise<TResult>,
  ): Promise<IdempotencyOutcome> {
    return this.transaction.run(request.subject, async (client) => {
      const workspaceId = request.workspaceId ?? null;
      const fingerprint = computeRequestFingerprint(request.payload);
      const existing = await this.store.read(
        client,
        request.subject,
        request.route,
        request.idempotencyKey,
        workspaceId,
      );

      if (existing !== undefined) {
        if (existing.requestFingerprint === fingerprint) {
          return {
            kind: IDEMPOTENCY_OUTCOME_KINDS.REPLAYED,
            response: {
              status: existing.responseStatus,
              etag: existing.responseEtag,
              body: existing.responseBody,
            },
          };
        }
        return {
          kind: IDEMPOTENCY_OUTCOME_KINDS.CONFLICT,
        };
      }

      const result = await operation(client);

      const written = await this.store.write(
        client,
        request.subject,
        request.route,
        request.idempotencyKey,
        fingerprint,
        result.status,
        result.etag,
        result.body,
        workspaceId,
      );

      if (!written) {
        // A zero-row returning from the write means a LIVE record won the race.
        // Treat it as "re-read and replay", NEVER as success.
        const reRead = await this.store.read(
          client,
          request.subject,
          request.route,
          request.idempotencyKey,
          workspaceId,
        );
        if (reRead !== undefined && reRead.requestFingerprint === fingerprint) {
          return {
            kind: IDEMPOTENCY_OUTCOME_KINDS.REPLAYED,
            response: {
              status: reRead.responseStatus,
              etag: reRead.responseEtag,
              body: reRead.responseBody,
            },
          };
        }
        return {
          kind: IDEMPOTENCY_OUTCOME_KINDS.CONFLICT,
        };
      }

      return {
        kind: IDEMPOTENCY_OUTCOME_KINDS.EXECUTED,
        response: result,
      };
    });
  }
}
