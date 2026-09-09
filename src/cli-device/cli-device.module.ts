import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { CliDeviceConfig } from './cli-device.config.js';
import { CLI_DEVICE_PORT } from './cli-device.port.js';
import { CliDeviceService } from './cli-device.service.js';
import { CliDeviceController } from './cli-device.controller.js';
import { PostgresCliDeviceAdapter } from './postgres-cli-device.adapter.js';

@Module({
  imports: [PlatformModule],
  controllers: [CliDeviceController],
  providers: [
    PostgresCliDeviceAdapter,
    {
      provide: CliDeviceConfig,
      useFactory: () => CliDeviceConfig.fromEnvironment(process.env),
    },
    {
      provide: CliDeviceService,
      inject: [PgTransaction, PostgresCliDeviceAdapter, CliDeviceConfig],
      useFactory: (
        tx: PgTransaction,
        store: PostgresCliDeviceAdapter,
        config: CliDeviceConfig,
      ) => new CliDeviceService(tx, store, config),
    },
    { provide: CLI_DEVICE_PORT, useExisting: CliDeviceService },
  ],
})
export class CliDeviceModule {}
