import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { AGENT_CONVERSATIONS_PORT } from './agent-conversation.port.js';
import { AgentConversationService } from './agent-conversation.service.js';
import { PostgresAgentConversationAdapter } from './postgres-agent-conversation.adapter.js';
import { AgentConversationsController } from './agent-conversations.controller.js';
@Module({
  imports: [PlatformModule],
  controllers: [AgentConversationsController],
  providers: [
    PostgresAgentConversationAdapter,
    {
      provide: AgentConversationService,
      inject: [
        PgTransaction,
        PostgresAgentConversationAdapter,
        PostgresIdempotencyAdapter,
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresAgentConversationAdapter,
        idempotency: PostgresIdempotencyAdapter,
      ) => new AgentConversationService(tx, store, idempotency),
    },
    {
      provide: AGENT_CONVERSATIONS_PORT,
      useExisting: AgentConversationService,
    },
  ],
})
export class AgentConversationsModule {}
