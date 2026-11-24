import { Global, Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { MCP_READ_ADMISSION } from '../platform/mcp-read-auth.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { MCP_GRANTS_PORT } from './mcp-grant.port.js';
import { McpGrantService } from './mcp-grant.service.js';
import { PostgresMcpGrantAdapter } from './postgres-mcp-grant.adapter.js';
import { McpGrantsController } from './mcp-grants.controller.js';
import { mcpReadAdmission } from './mcp-read-admission.js';
@Global()
@Module({
  imports: [PlatformModule],
  controllers: [McpGrantsController],
  providers: [
    PostgresMcpGrantAdapter,
    {
      provide: MCP_READ_ADMISSION,
      inject: [PgTransaction, PostgresMcpGrantAdapter],
      useFactory: mcpReadAdmission,
    },
    {
      provide: McpGrantService,
      inject: [
        PgTransaction,
        PostgresMcpGrantAdapter,
        PostgresIdempotencyAdapter,
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresMcpGrantAdapter,
        idempotency: PostgresIdempotencyAdapter,
      ) => new McpGrantService(tx, store, idempotency),
    },
    { provide: MCP_GRANTS_PORT, useExisting: McpGrantService },
  ],
  exports: [PostgresMcpGrantAdapter, MCP_READ_ADMISSION],
})
export class McpGrantsModule {}
