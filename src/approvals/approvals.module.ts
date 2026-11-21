import {
  Module,
  type DynamicModule,
  type FactoryProvider,
  type ModuleMetadata,
} from '@nestjs/common';
import { ApprovalsController } from './approvals.controller.js';
import {
  APPROVALS_PORT,
  APPROVAL_STORE,
  type ApprovalExecutors,
} from './approval.port.js';
import { ApprovalService } from './approval.service.js';
import { PostgresApprovalAdapter } from './postgres-approval.adapter.js';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';

const APPROVAL_EXECUTORS = Symbol('ApprovalExecutors');

@Module({
  imports: [PlatformModule],
  controllers: [ApprovalsController],
  providers: [
    PostgresApprovalAdapter,
    { provide: APPROVAL_STORE, useExisting: PostgresApprovalAdapter },
    {
      provide: ApprovalService,
      inject: [
        PgTransaction,
        PostgresApprovalAdapter,
        PostgresIdempotencyAdapter,
        { token: APPROVAL_EXECUTORS, optional: true },
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresApprovalAdapter,
        idempotency: PostgresIdempotencyAdapter,
        executors?: ApprovalExecutors,
      ) => new ApprovalService(tx, store, idempotency, undefined, executors),
    },
    { provide: APPROVALS_PORT, useExisting: ApprovalService },
  ],
  exports: [APPROVALS_PORT],
})
export class ApprovalsModule {
  public static withExecutors(
    imports: ModuleMetadata['imports'],
    factory: Omit<FactoryProvider<ApprovalExecutors>, 'provide'>,
  ): DynamicModule {
    return {
      module: ApprovalsModule,
      imports,
      providers: [{ ...factory, provide: APPROVAL_EXECUTORS }],
    };
  }
}
