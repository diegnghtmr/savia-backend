import { NestFactory } from '@nestjs/core';
import { JobRunner } from './platform/job-runner.js';
import { WorkerConfig } from './platform/worker-config.js';
import { WorkerModule } from './worker.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();

  const runner = app.get(JobRunner);
  const config = app.get(WorkerConfig);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const drainTimer = setTimeout(() => {
      process.exit(1);
    }, config.drainTimeoutSeconds * 1_000);
    drainTimer.unref();

    try {
      await runner.stop();
      await app.close();
    } finally {
      clearTimeout(drainTimer);
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await runner.start();
}

void bootstrap();
