import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { JOB_WRITER } from '../src/platform/job-writer.port.js';
import { RECEIPTS_PORT } from '../src/receipts/receipt.port.js';

describe('AppModule', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('resolves ReceiptsModule with RECEIPTS_PORT through the real import graph', async () => {
    process.env.DATABASE_URL =
      'postgresql://postgres:postgres@127.0.0.1:5432/test';
    process.env.JWT_ISSUER = 'https://issuer.example.test';
    process.env.JWT_AUDIENCE = 'savia-api';
    process.env.JWT_JWKS_URI =
      'https://issuer.example.test/.well-known/jwks.json';
    process.env.JWT_ALGORITHMS = 'RS256';
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const receiptsPort = moduleRef.get(RECEIPTS_PORT);
    expect(receiptsPort).toBeDefined();
    expect(moduleRef.get(JOB_WRITER)).toBeDefined();
  });
});
