import { Module } from '@nestjs/common';

import { BOOTSTRAP_PORT } from './bootstrap.port.js';
import { BootstrapService } from './bootstrap.service.js';
import { OnboardingController } from './onboarding.controller.js';
import { PostgresBootstrapAdapter } from './postgres-bootstrap.adapter.js';
import { PostgresProfileAdapter } from './postgres-profile.adapter.js';
import { PostgresWorkspaceAdapter } from './postgres-workspace.adapter.js';
import { ProfileController } from './profile.controller.js';
import { PROFILE_PORT } from './profile.port.js';
import { ProfileService } from './profile.service.js';
import { IDEMPOTENCY_PORT } from './idempotency.port.js';
import { IdempotencyService } from './idempotency.service.js';
import { PostgresIdempotencyAdapter } from './postgres-idempotency.adapter.js';
import { WorkspaceController } from './workspace.controller.js';
import { WORKSPACE_PORT } from './workspace.port.js';
import { WorkspaceService } from './workspace.service.js';
import { PostgresWorkspaceMemberAdapter } from './postgres-workspace-member.adapter.js';
import { WORKSPACE_MEMBER_PORT } from './workspace-member.port.js';
import { WorkspaceMemberService } from './workspace-member.service.js';
import { PostgresWorkspaceInvitationAdapter } from './postgres-workspace-invitation.adapter.js';
import { WORKSPACE_INVITATION_PORT } from './workspace-invitation.port.js';
import { WorkspaceInvitationService } from './workspace-invitation.service.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PlatformModule } from '../platform/platform.module.js';

@Module({
  imports: [PlatformModule],
  controllers: [OnboardingController, ProfileController, WorkspaceController],
  providers: [
    PostgresBootstrapAdapter,
    {
      provide: BootstrapService,
      inject: [PgTransaction, PostgresBootstrapAdapter],
      useFactory: (
        transaction: PgTransaction,
        adapter: PostgresBootstrapAdapter,
      ) => new BootstrapService(transaction, adapter),
    },
    { provide: BOOTSTRAP_PORT, useExisting: BootstrapService },
    PostgresProfileAdapter,
    {
      provide: ProfileService,
      inject: [PgTransaction, PostgresProfileAdapter],
      useFactory: (
        transaction: PgTransaction,
        adapter: PostgresProfileAdapter,
      ) => new ProfileService(transaction, adapter),
    },
    { provide: PROFILE_PORT, useExisting: ProfileService },
    PostgresWorkspaceAdapter,
    PostgresIdempotencyAdapter,
    {
      provide: WorkspaceService,
      inject: [
        PgTransaction,
        PostgresWorkspaceAdapter,
        PostgresIdempotencyAdapter,
      ],
      useFactory: (
        transaction: PgTransaction,
        adapter: PostgresWorkspaceAdapter,
        idempotency: PostgresIdempotencyAdapter,
      ) => new WorkspaceService(transaction, adapter, idempotency),
    },
    { provide: WORKSPACE_PORT, useExisting: WorkspaceService },
    PostgresWorkspaceMemberAdapter,
    {
      provide: WorkspaceMemberService,
      inject: [
        PgTransaction,
        PostgresWorkspaceMemberAdapter,
        PostgresIdempotencyAdapter,
      ],
      useFactory: (
        transaction: PgTransaction,
        adapter: PostgresWorkspaceMemberAdapter,
        idempotency: PostgresIdempotencyAdapter,
      ) => new WorkspaceMemberService(transaction, adapter, idempotency),
    },
    { provide: WORKSPACE_MEMBER_PORT, useExisting: WorkspaceMemberService },
    PostgresWorkspaceInvitationAdapter,
    {
      provide: WorkspaceInvitationService,
      inject: [
        PgTransaction,
        PostgresWorkspaceInvitationAdapter,
        PostgresIdempotencyAdapter,
      ],
      useFactory: (
        transaction: PgTransaction,
        adapter: PostgresWorkspaceInvitationAdapter,
        idempotency: PostgresIdempotencyAdapter,
      ) => new WorkspaceInvitationService(transaction, adapter, idempotency),
    },
    {
      provide: WORKSPACE_INVITATION_PORT,
      useExisting: WorkspaceInvitationService,
    },
    {
      provide: IdempotencyService,
      inject: [PgTransaction, PostgresIdempotencyAdapter],
      useFactory: (
        transaction: PgTransaction,
        adapter: PostgresIdempotencyAdapter,
      ) => new IdempotencyService(transaction, adapter),
    },
    { provide: IDEMPOTENCY_PORT, useExisting: IdempotencyService },
  ],
  exports: [
    BOOTSTRAP_PORT,
    PROFILE_PORT,
    WORKSPACE_PORT,
    WORKSPACE_MEMBER_PORT,
    WORKSPACE_INVITATION_PORT,
    IDEMPOTENCY_PORT,
  ],
})
export class IdentityModule {}
