import type { BootstrapCommand } from './bootstrap-command.js';
import {
  BOOTSTRAP_CONFLICT_KINDS,
  BOOTSTRAP_PARTIAL_KINDS,
  BOOTSTRAP_RESULT_KINDS,
  type BootstrapAggregate,
  type BootstrapOutcome,
  type BootstrapPort,
} from './bootstrap.port.js';
import {
  CommitOutcomeUnknownError,
  type TransactionClient,
} from './pg-transaction.js';
import {
  BOOTSTRAP_CLASSIFICATIONS,
  classifyBootstrap,
  type BootstrapEvidence,
} from './bootstrap-classification.js';

export interface BootstrapTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}
export interface BootstrapStore {
  read(client: TransactionClient, subject: string): Promise<BootstrapEvidence>;
  create(
    client: TransactionClient,
    command: BootstrapCommand,
  ): Promise<BootstrapAggregate>;
}
export class BootstrapService implements BootstrapPort {
  public constructor(
    private readonly transaction: BootstrapTransaction,
    private readonly store: BootstrapStore,
  ) {}

  public async execute(command: BootstrapCommand): Promise<BootstrapOutcome> {
    try {
      return await this.attempt(command);
    } catch (error) {
      if (
        error instanceof Error &&
        error.constructor === CommitOutcomeUnknownError
      )
        return this.attempt(command);
      throw error;
    }
  }

  private attempt(command: BootstrapCommand): Promise<BootstrapOutcome> {
    return this.transaction.run(command.subject, async (client) => {
      const evidence = await this.store.read(client, command.subject);
      const classification = classifyBootstrap(command, evidence);
      if (classification === BOOTSTRAP_CLASSIFICATIONS.CREATE)
        return {
          kind: BOOTSTRAP_RESULT_KINDS.CREATED,
          aggregate: await this.store.create(client, command),
        };
      if (classification === BOOTSTRAP_CLASSIFICATIONS.REPLAY)
        return {
          kind: BOOTSTRAP_RESULT_KINDS.REPLAYED,
          aggregate: {
            profileId: evidence.profiles[0]!.id,
            workspaceId: evidence.workspaces[0]!.id,
          },
        };
      return classification === BOOTSTRAP_CLASSIFICATIONS.CONFLICT
        ? { kind: BOOTSTRAP_CONFLICT_KINDS.DIFFERENT_REQUEST }
        : { kind: BOOTSTRAP_PARTIAL_KINDS.INCOMPLETE_AGGREGATE };
    });
  }
}
