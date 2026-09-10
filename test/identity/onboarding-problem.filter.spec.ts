import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';

import { CommitOutcomeUnknownError } from '../../src/platform/pg-transaction.js';
import { OnboardingProblemFilter } from '../../src/identity/onboarding-problem.filter.js';

describe('OnboardingProblemFilter', () => {
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
