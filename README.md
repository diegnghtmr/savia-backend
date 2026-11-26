# Savia Backend

Savia Backend is the HTTP API and background worker for Savia, a personal finance app. It covers workspaces and members, accounts and a double-entry ledger, transfers with fees, budgets, sinking funds, debts, subscriptions and recurring rules, imports (CSV, XLSX, QIF, OFX) and exports with full backups, receipts with OCR, notifications (email, push, digests), FX rates, forecasts, scenarios, reports and analytics, AI assistant tools, MCP grants with approval-gated proposals, and CLI device sign-in. PostgreSQL with row-level security stores financial records, and the API verifies the caller's access token and live session before serving authenticated routes.

## Repositories

- [savia-web](https://github.com/diegnghtmr/savia-web) — Next.js web app that calls the API for workspace setup.
- [savia-mobile](https://github.com/diegnghtmr/savia-mobile) — Expo mobile app.
- [savia-mcp](https://github.com/diegnghtmr/savia-mcp) — MCP server (stdio and Streamable HTTP).
- [savia-cli](https://github.com/diegnghtmr/savia-cli) — command-line client.

## Requirements

- Node.js 24.18.0
- pnpm 11.13.0
- NestJS 11.1.28, Fastify 5.10.0, and TypeScript 5.9.3
- PostgreSQL 17 in the local Supabase configuration; `pg` 8.22.0
- Vitest 4.1.10 and Redocly CLI 2.39.0

## Run locally

Authenticated requests need a PostgreSQL database with the migrations in
`supabase/migrations/` applied. Set `DATABASE_URL` and configure the token
issuer, audience, algorithms, and HTTPS key endpoint with `JWT_ISSUER`,
`JWT_AUDIENCE`, `JWT_ALGORITHMS`, and `JWT_JWKS_URI`.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

The API defaults to port 3000 (`PORT` overrides it). `GET /health` checks that
it is running; unknown routes return `404`. To run background jobs, start the
worker separately with `pnpm start:worker`.

## Tests

```sh
pnpm test
pnpm openapi:verify
pnpm check
```

`pnpm test` runs the Vitest suite. `pnpm check` also runs formatting, linting,
architecture checks, type checking, the build, and OpenAPI checks. The separate
`test:database*` and `test:integration:*` scripts cover database-backed behavior;
see `package.json` for their entry points.

## API contract

The committed contract includes `GET /health` and the 120 implemented operations
under `/v1`, published from planning revision `9785033`.

`openapi/savia.openapi.yaml` is the client-generation input. Its provenance records
the local planning source constants. Backend CI cannot access, authenticate, or independently
re-hash that local source; it validates only committed constants and executable contract identity.

## Repository structure

- `src/main.ts` and `src/worker.ts` — HTTP server and worker entry points.
- `src/identity/` — profile, workspace setup, and membership.
- `src/accounts/`, `src/ledger/`, `src/budgets/`, `src/funds/`, `src/debts/`, `src/recurring/` and related modules — financial operations.
- `src/imports/`, `src/exports/`, `src/receipts/`, `src/reports/`, `src/analytics/`, `src/forecasts/` — data and insight features.
- `src/notifications/`, `src/jobs/`, `src/currencies/` — background work run by the worker.
- `src/mcp*`, `src/approvals/`, `src/agent/`, `src/ai/`, `src/cli-device/` — AI, MCP and CLI integrations.
- `src/platform/` — shared PostgreSQL, storage, and token verification adapters.
- `supabase/` — local configuration, SQL migrations, and database tests.
- `openapi/` — contract, operation manifest, and provenance.
- `test/` — unit, HTTP, and integration tests.

## License

MIT, see [LICENSE](LICENSE).
