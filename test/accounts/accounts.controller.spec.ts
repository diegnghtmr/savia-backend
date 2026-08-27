import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';
import { AccountsController } from '../../src/accounts/accounts.controller.js';
import {
  ACCOUNT_BALANCE_OUTCOMES,
  type AccountsPort,
  type AccountBalance,
} from '../../src/accounts/accounts.port.js';

describe('AccountsController.getAccountBalance', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const accountId = '00000000-0000-0000-0000-000000000a01';
  const subject = '00000000-0000-0000-0000-000000000901';

  const mockBalance: AccountBalance = {
    accountId,
    nativeBalance: { amountMinor: '10000', currency: 'USD' },
    pendingBalance: { amountMinor: '2000', currency: 'USD' },
    reconciledBalance: { amountMinor: '3000', currency: 'USD' },
    baseCurrencyEquivalent: {
      original: { amountMinor: '10000', currency: 'USD' },
      converted: { amountMinor: '10000', currency: 'USD' },
      rate: '1',
      rateDate: '2026-07-01',
      rateSource: 'identity',
    },
    asOf: '2026-07-01T00:00:00.000Z',
  };

  function createMocks(accountsPortOverrides: Partial<AccountsPort> = {}) {
    const fakeAccountsPort: AccountsPort = {
      list: vi.fn(),
      read: vi.fn(),
      readBalance: vi.fn().mockResolvedValue({
        kind: ACCOUNT_BALANCE_OUTCOMES.OK,
        balance: mockBalance,
      }),
      create: vi.fn(),
      update: vi.fn(),
      ...accountsPortOverrides,
    };

    const controller = new AccountsController(fakeAccountsPort);

    const reply = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      request: {
        id: 'trace-123',
        url: `/v1/accounts/${accountId}/balance`,
      },
    } as unknown as FastifyReply;

    return { controller, fakeAccountsPort, reply };
  }

  it('answers 400 when X-Workspace-Id header is missing', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: {},
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.getAccountBalance(accountId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it('answers 400 when accountId is not a valid UUID', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: { 'x-workspace-id': workspaceId },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.getAccountBalance('invalid-uuid', request, reply);

    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it('answers 400 when asOf query parameter is not a valid date-time', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: { 'x-workspace-id': workspaceId },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.getAccountBalance(
      accountId,
      request,
      reply,
      'invalid-as-of',
    );

    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it('answers 403 when readBalance returns forbidden', async () => {
    const { controller, reply } = createMocks({
      readBalance: vi
        .fn()
        .mockResolvedValue({ kind: ACCOUNT_BALANCE_OUTCOMES.FORBIDDEN }),
    });
    const request = {
      headers: { 'x-workspace-id': workspaceId },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.getAccountBalance(accountId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it('answers 404 when readBalance returns not_found', async () => {
    const { controller, reply } = createMocks({
      readBalance: vi
        .fn()
        .mockResolvedValue({ kind: ACCOUNT_BALANCE_OUTCOMES.NOT_FOUND }),
    });
    const request = {
      headers: { 'x-workspace-id': workspaceId },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.getAccountBalance(accountId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(404);
  });

  it('answers 200 with balance payload on ok outcome', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: { 'x-workspace-id': workspaceId },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.getAccountBalance(
      accountId,
      request,
      reply,
      '2026-07-01T00:00:00.000Z',
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(mockBalance);
  });
});
