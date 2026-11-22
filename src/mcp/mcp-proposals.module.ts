import {
  Module,
  type DynamicModule,
  type FactoryProvider,
  type ModuleMetadata,
} from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import {
  MCP_PROPOSALS_PORT,
  McpProposalsController,
  type McpProposalsPort,
} from './mcp-proposals.controller.js';

@Module({ imports: [PlatformModule], controllers: [McpProposalsController] })
export class McpProposalsModule {
  public static withPort(
    imports: ModuleMetadata['imports'],
    factory: Omit<FactoryProvider<McpProposalsPort>, 'provide'>,
  ): DynamicModule {
    return {
      module: McpProposalsModule,
      imports,
      providers: [{ ...factory, provide: MCP_PROPOSALS_PORT }],
    };
  }
}
