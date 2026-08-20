import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';
import { registerProblemFilter } from './identity/onboarding-problem.filter.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ exposeHeadRoutes: false }),
  );
  registerProblemFilter(app);
  app.enableShutdownHooks();

  await app.listen({
    host: '0.0.0.0',
    port: Number(process.env.PORT ?? 3000),
  });
}

void bootstrap();
