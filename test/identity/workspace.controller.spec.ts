import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../src/identity/authenticated-request.js';
import { WorkspaceController } from '../../src/identity/workspace.controller.js';
import {
  WORKSPACE_INVITATION_REVOKE_OUTCOMES,
  type WorkspaceInvitationPort,
} from '../../src/identity/workspace-invitation.port.js';
import type { WorkspaceMemberPort } from '../../src/identity/workspace-member.port.js';
import type { WorkspacePort } from '../../src/identity/workspace.port.js';

describe('WorkspaceController', () => {
  describe('revokeWorkspaceInvitation', () => {
    it('fallback guard: replayed non-200 outcome without ProblemDetails type sends raw status and body', async () => {
      const replayedBody = {
        message: 'non-standard replay payload without type',
      };
      const fakeInvitations = {
        listWorkspaceInvitations: vi.fn(),
        createWorkspaceInvitation: vi.fn(),
        revokeWorkspaceInvitation: vi.fn().mockResolvedValue({
          kind: WORKSPACE_INVITATION_REVOKE_OUTCOMES.REPLAYED,
          status: 418,
          body: replayedBody,
        }),
      } as unknown as WorkspaceInvitationPort;
      const fakeWorkspace = {} as unknown as WorkspacePort;
      const fakeMembers = {} as unknown as WorkspaceMemberPort;

      const controller = new WorkspaceController(
        fakeWorkspace,
        fakeMembers,
        fakeInvitations,
      );

      const request = {
        headers: {
          'idempotency-key': '00000000-0000-0000-0000-000000000001',
        },
        identity: {
          subject: '00000000-0000-0000-0000-000000000002',
        },
      } as unknown as AuthenticatedRequest;

      const reply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await controller.revokeWorkspaceInvitation(
        '00000000-0000-0000-0000-000000000003',
        '00000000-0000-0000-0000-000000000004',
        request,
        reply,
      );

      expect(reply.status).toHaveBeenCalledWith(418);
      expect(reply.send).toHaveBeenCalledWith(replayedBody);
    });
  });
});
