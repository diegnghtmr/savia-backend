import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { AGENT_CONVERSATIONS_PORT } from './agent-conversation.port.js';
import { AgentConversationService } from './agent-conversation.service.js';
import { PostgresAgentConversationAdapter } from './postgres-agent-conversation.adapter.js';
import { AgentConversationsController } from './agent-conversations.controller.js';
import { AgentMessagesController } from './agent-messages.controller.js';
import {
  AGENT_MESSAGE_PORT,
  AGENT_PROVIDER_PORT,
} from './agent-message.port.js';
import { AgentMessageService } from './agent-message.service.js';
import { LocalAgentProviderAdapter } from './agent-provider.adapter.js';
import { PostgresAgentMessageAdapter } from './postgres-agent-message.adapter.js';
@Module({
  imports: [PlatformModule],
  controllers: [AgentConversationsController, AgentMessagesController],
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
    PostgresAgentMessageAdapter,
    { provide: AGENT_PROVIDER_PORT, useClass: LocalAgentProviderAdapter },
    {
      provide: AgentMessageService,
      inject: [PgTransaction, PostgresAgentMessageAdapter, AGENT_PROVIDER_PORT],
      useFactory: (
        tx: PgTransaction,
        store: PostgresAgentMessageAdapter,
        provider: LocalAgentProviderAdapter,
      ) => new AgentMessageService(tx, store, provider),
    },
    { provide: AGENT_MESSAGE_PORT, useExisting: AgentMessageService },
  ],
})
export class AgentConversationsModule {}
