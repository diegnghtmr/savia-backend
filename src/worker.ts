import { NestFactory } from '@nestjs/core';
import { JobRunner } from './platform/job-runner.js';
import { WorkerModule } from './worker.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();

  const runner = app.get(JobRunner);
  await runner.start();
}

void bootstrap();
