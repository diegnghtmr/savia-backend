import { NestFactory } from '@nestjs/core';
import { NotificationDeliverySweep } from './notifications/notification-delivery-sweep.js';
import { JobRunner } from './platform/job-runner.js';
import { WorkerModule } from './worker.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks([], { useProcessExit: true });

  const runner = app.get(JobRunner);
  await runner.start();
  app.get(NotificationDeliverySweep).start();
}

void bootstrap();
