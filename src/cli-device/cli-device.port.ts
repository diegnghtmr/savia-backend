import type { TransactionClient } from '../platform/pg-transaction.js';

export const CLI_DEVICE_PORT = Symbol('CliDevicePort');

export interface CliDeviceAuthorizationCommand {
  readonly clientId: string;
  readonly scopes: readonly string[];
}

export interface CliDeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresIn: number;
  readonly interval: number;
}

export interface CliDeviceStore {
  consumeRateLimit(
    client: TransactionClient,
    clientId: string,
    ip: string,
    now: Date,
  ): Promise<boolean>;
  create(
    client: TransactionClient,
    record: {
      readonly deviceCodeHash: string;
      readonly userCode: string;
      readonly clientId: string;
      readonly scopes: readonly string[];
      readonly expiresAt: Date;
    },
  ): Promise<void>;
}

export interface CliDeviceTransaction {
  runAnonymous<T>(
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export interface CliDevicePort {
  authorize(
    command: CliDeviceAuthorizationCommand,
    ip: string,
  ): Promise<
    | CliDeviceAuthorization
    | { readonly kind: 'rate_limited'; readonly retryAfter: number }
  >;
}
