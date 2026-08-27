import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findFinancialTableViolations } from '../../scripts/verify-financial-tables.mjs';
import { findIdempotencyViolations } from '../../scripts/verify-financial-idempotency.mjs';

const root = process.cwd();

describe('architecture fitness tripwires', () => {
  describe('financial table workspace_id tripwire (rule 5)', () => {
    it('rejects a financial table lacking workspace_id using inline SQL fixture (RED fixture)', () => {
      const violatingSql = `
        create table public.financial_ledgers (
          id uuid primary key default gen_random_uuid(),
          amount numeric not null,
          created_at timestamptz not null default now()
        );
        comment on table public.financial_ledgers is 'fitness:financial ledgers';
      `;

      const violations = findFinancialTableViolations(violatingSql);

      expect(violations).toHaveLength(1);
      expect(violations).toEqual(['public.financial_ledgers']);
    });

    it('accepts a financial table containing workspace_id', () => {
      const validSql = `
        create table public.financial_ledgers (
          id uuid primary key default gen_random_uuid(),
          workspace_id uuid not null references public.workspaces(id),
          amount numeric not null
        );
        comment on table public.financial_ledgers is 'fitness:financial ledgers';
      `;

      const violations = findFinancialTableViolations(validSql);

      expect(violations).toEqual([]);
    });

    // Ordinary SQL escaping doubles a literal quote (''). The verifier used to
    // stop matching at any quote character, so an apostrophe in the comment
    // silently un-tagged the table and the rule went blind to exactly the
    // regression it exists to catch.
    const escapedApostropheComment =
      "comment on table public.financial_ledgers is 'Workspace''s financial account. fitness:financial';";

    it('recognises a fitness:financial tag written with an SQL-escaped apostrophe: a compliant table yields no violations', () => {
      const compliantSql = `
        create table public.financial_ledgers (
          id uuid primary key default gen_random_uuid(),
          workspace_id uuid not null references public.workspaces(id),
          amount numeric not null
        );
        ${escapedApostropheComment}
      `;

      const violations = findFinancialTableViolations(compliantSql);

      expect(violations).toEqual([]);
    });

    it('reports a workspace_id violation for a financial table whose fitness:financial comment contains an SQL-escaped apostrophe', () => {
      const violatingSql = `
        create table public.financial_ledgers (
          id uuid primary key default gen_random_uuid(),
          amount numeric not null
        );
        ${escapedApostropheComment}
      `;

      const violations = findFinancialTableViolations(violatingSql);

      expect(violations).toEqual(['public.financial_ledgers']);
    });

    it('verifies real migrations have no financial table violations (vacuous today)', () => {
      const migrationsDir = resolve(root, 'supabase/migrations');
      const files = readdirSync(migrationsDir)
        .filter((file) => file.endsWith('.sql'))
        .sort();
      const sqlSources = files.map((file) =>
        readFileSync(join(migrationsDir, file), 'utf8'),
      );

      const violations = findFinancialTableViolations(sqlSources);

      expect(violations).toEqual([]);
    });
  });

  describe('financial operation idempotency tripwire (rule 6)', () => {
    it('rejects a financial operation lacking Idempotency-Key header using inline OpenAPI fixture (RED fixture)', () => {
      const violatingDoc = {
        openapi: '3.1.1',
        paths: {
          '/transactions': {
            post: {
              operationId: 'createTransaction',
              'x-financial': true,
              responses: {
                '201': { description: 'Created' },
              },
            },
          },
        },
      };

      const violations = findIdempotencyViolations(violatingDoc);

      expect(violations).toHaveLength(1);
      expect(violations).toEqual(['POST /transactions (createTransaction)']);
    });

    it('accepts a financial operation with Idempotency-Key header parameter', () => {
      const validDoc = {
        openapi: '3.1.1',
        paths: {
          '/transactions': {
            post: {
              operationId: 'createTransaction',
              'x-financial': true,
              parameters: [
                {
                  name: 'Idempotency-Key',
                  in: 'header',
                  required: true,
                  schema: { type: 'string' },
                },
              ],
              responses: {
                '201': { description: 'Created' },
              },
            },
          },
        },
      };

      const violations = findIdempotencyViolations(validDoc);

      expect(violations).toEqual([]);
    });

    it('verifies real OpenAPI contract has no financial idempotency violations', () => {
      const contractPath = 'openapi/savia.openapi.yaml';
      const directory = mkdtempSync(join(tmpdir(), 'savia-tripwire-'));
      const output = join(directory, 'contract.json');

      let bundledDocument: object;
      try {
        execFileSync(
          resolve(root, 'node_modules/.bin/redocly'),
          [
            'bundle',
            resolve(root, contractPath),
            '--ext',
            'json',
            '--output',
            output,
          ],
          { cwd: root, stdio: 'pipe' },
        );
        bundledDocument = JSON.parse(readFileSync(output, 'utf8'));
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }

      const violations = findIdempotencyViolations(bundledDocument);

      expect(violations).toEqual([]);
    });
  });
});
