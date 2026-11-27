import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';

import { CommitOutcomeUnknownError } from '../../src/platform/pg-transaction.js';
import { OnboardingProblemFilter } from '../../src/identity/onboarding-problem.filter.js';

describe('OnboardingProblemFilter', () => {
  const privateMarker = 'synthetic-request-value-B8';

  it.each([
    [new BadRequestException(privateMarker), 'bad-request', 400],
    [
      new CommitOutcomeUnknownError(new Error(privateMarker)),
      'outcome-unknown',
      503,
    ],
    [new Error(privateMarker), 'internal', 500],
  ] as const)(
    'logs only a sanitized code for %p',
    (exception, code, status) => {
      const logger = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => {});
      try {
        const reply = {
          request: {
            id: 'trace-id',
            url: `/v1/accounts?test=${privateMarker}`,
          },
          header: vi.fn().mockReturnThis(),
          status: vi.fn().mockReturnThis(),
          type: vi.fn().mockReturnThis(),
          send: vi.fn().mockReturnThis(),
        };
        const host = {
          switchToHttp: () => ({
            getResponse: () => reply,
            getRequest: () => ({ identity: { subject: privateMarker } }),
          }),
        };
        new OnboardingProblemFilter().catch(exception, host as never);
        expect(JSON.stringify(logger.mock.calls)).not.toContain(privateMarker);
        expect(logger.mock.calls).toEqual([[code]]);
        expect(reply.status).toHaveBeenCalledWith(status);
        expect(reply.type).toHaveBeenCalledWith('application/problem+json');
        expect(reply.send).toHaveBeenCalledWith(
          expect.objectContaining({ code, status }),
        );
        expect(reply.header.mock.calls).toEqual(
          status === 503 ? [['retry-after', '5']] : [],
        );
      } finally {
        logger.mockRestore();
      }
    },
  );
  it('maps a forbidden exception to a 403 problem detail', () => {
    const reply = {
      request: { id: 'trace-id', url: '/v1/mcp/grants' },
      header: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => reply,
        getRequest: () => ({ identity: { subject: 'subject-id' } }),
      }),
    };

    new OnboardingProblemFilter().catch(
      new ForbiddenException(),
      host as never,
    );

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ status: 403 }),
    );
  });

  it('uses a neutral outcome-unknown title outside onboarding routes', () => {
    const reply = {
      request: { id: 'trace-id', url: '/v1/accounts' },
      header: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => reply,
        getRequest: () => ({ identity: { subject: 'subject-id' } }),
      }),
    };

    new OnboardingProblemFilter().catch(
      new CommitOutcomeUnknownError(new Error('connection reset')),
      host as never,
    );

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Operation outcome is unknown',
        status: 503,
      }),
    );
  });
});
