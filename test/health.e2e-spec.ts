import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';

describe('health endpoint', () => {
  it('exposes only GET /health with the documented health payload', async () => {
    const routes: string[] = [];
    const adapter = new FastifyAdapter({ exposeHeadRoutes: false });
    adapter.getInstance().addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method)
        ? route.method
        : [route.method];
      routes.push(...methods.map((method) => `${method} ${route.url}`));
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app =
      moduleRef.createNestApplication<NestFastifyApplication>(adapter);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.headers['content-type']).toContain('application/json');
    expect(Object.keys(JSON.parse(health.payload)).sort()).toEqual([
      'status',
      'time',
    ]);
    expect(JSON.parse(health.payload)).toMatchObject({ status: 'ok' });
    expect(JSON.parse(health.payload).time).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(Date.parse(JSON.parse(health.payload).time)).not.toBeNaN();

    const unknown = await app.inject({ method: 'GET', url: '/unknown' });
    expect(unknown.statusCode).toBe(404);
    expect(routes).toEqual(['GET /health']);

    await app.close();
  });
});
