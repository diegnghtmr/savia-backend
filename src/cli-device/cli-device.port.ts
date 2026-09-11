import type { TransactionClient } from '../platform/pg-transaction.js';

export const CLI_DEVICE_PORT = Symbol('CliDevicePort');

export interface CliDeviceAuthorizationCommand {
  readonly clientId: string;
  readonly scopes: readonly string[];
}

export interface CliDeviceApprovalCommand {
  readonly userCode: string;
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
  consumeApprovalRateLimit(
    client: TransactionClient,
    now: Date,
  ): Promise<boolean>;
  approve(client: TransactionClient, userCode: string): Promise<boolean>;
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
  redeem(
    client: TransactionClient,
    deviceCodeHash: string,
    clientId: string,
    now: Date,
  ): Promise<
    | {
        readonly subjectId: string;
        readonly scopes: readonly string[];
        readonly expiresAt: Date;
      }
    | undefined
  >;
  createToken(
    client: TransactionClient,
    record: {
      readonly tokenHash: string;
      readonly subjectId: string;
      readonly scopes: readonly string[];
      readonly expiresAt: Date;
      readonly deviceCodeHash: string;
    },
  ): Promise<void>;
  verifyToken(
    client: TransactionClient,
    tokenHash: string,
  ): Promise<{ readonly subjectId: string } | undefined>;
}

export interface CliDeviceTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
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
  approve(
    subject: string,
    command: CliDeviceApprovalCommand,
  ): Promise<
    | { readonly kind: 'approved' }
    | { readonly kind: 'invalid' }
    | { readonly kind: 'rate_limited'; readonly retryAfter: number }
  >;
  poll(
    command: CliDeviceTokenCommand,
    ip: string,
  ): Promise<
    | CliDeviceTokenResponse
    | { readonly kind: 'rate_limited' }
    | { readonly kind: 'invalid' }
  >;
}

export interface CliDeviceTokenCommand {
  readonly clientId: string;
  readonly deviceCode: string;
}

export interface CliDeviceTokenResponse {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
  readonly scope: string;
}
