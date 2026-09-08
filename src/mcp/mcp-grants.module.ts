import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { MCP_GRANTS_PORT } from './mcp-grant.port.js';
import { McpGrantService } from './mcp-grant.service.js';
import { PostgresMcpGrantAdapter } from './postgres-mcp-grant.adapter.js';
import { McpGrantsController } from './mcp-grants.controller.js';
@Module({
  imports: [PlatformModule],
  controllers: [McpGrantsController],
  providers: [
    PostgresMcpGrantAdapter,
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
})
export class McpGrantsModule {}
