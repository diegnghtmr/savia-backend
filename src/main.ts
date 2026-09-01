import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';
import { registerProblemFilter } from './identity/onboarding-problem.filter.js';
import multipart from '@fastify/multipart';

export const IMPORT_MULTIPART_LIMITS = {
  fileSize: 5 * 1024 * 1024,
  files: 1,
  fields: 1,
  parts: 2,
} as const;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ exposeHeadRoutes: false }),
  );
  await app.getHttpAdapter().getInstance().register(multipart, {
    limits: IMPORT_MULTIPART_LIMITS,
    throwFileSizeLimit: false,
  });
  registerProblemFilter(app);
  app.enableShutdownHooks();

  await app.listen({
    host: '0.0.0.0',
    port: Number(process.env.PORT ?? 3000),
  });
}

void bootstrap();
