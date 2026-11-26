# Savia Backend

A minimal NestJS/Fastify backend service.

## Requirements

- Node.js 24.18.0
- pnpm 11.13.0

## Commands

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm start
```

`openapi/savia.openapi.yaml` is the client-generation input. It publishes the
120 implemented operations from planning revision `9785033`. Its provenance records
the local planning source constants. Backend CI cannot access, authenticate, or independently
re-hash that local source; it validates only committed constants and executable contract identity.

## Integration tests

Run these commands from the checkout on a Linux host with Docker, `flock`, and
this project's Node and pnpm dependencies installed:

```sh
pnpm test:integration:all --list
pnpm test:integration:all
pnpm test:integration:all postgres-pool workspace
pnpm test:integration:ocr
```

`test:integration:all` runs every `test:integration:<name>` suite. It starts one
local Supabase stack and resets its database with all migrations and no seed
before each database suite. Suites run serially, and the runner prints a summary
and tears the stack down on exit, including after failure or interruption. The
standalone PDF renderer suite still requires Playwright Chromium on the host
(`pnpm exec playwright-core install chromium`). The schema contract and SQL
migration/rollback gates are separate because they build and check deliberately
different database states; CI still runs them separately.

The full run and `test:integration:ocr` run `forecasts`, `receipt-ocr`, and
`receipt-ocr-engine` in a Docker image with pinned Node, pnpm and Tesseract
English and Spanish data. No host Tesseract installation is required. The first
build downloads public packages; subsequent builds reuse cached layers. The OCR
DB suites use Linux Docker host networking to reach the disposable Supabase
stack. Run one OCR suite with `pnpm test:integration:ocr receipt-ocr-engine`.

The full and OCR runners hold `/tmp/savia-db.lock` through teardown. Existing
`pnpm run test:integration:<name>` commands are unchanged. If running a legacy
DB command alongside the full or OCR runner, acquire the same lock explicitly,
for example `flock /tmp/savia-db.lock pnpm run test:integration:workspace`.
Do not wrap the full or OCR command in a second `flock`.

On one Linux Docker host, five DB suites (pool, transaction resilience,
workspace, transaction creation and receipt foundation; 85 tests) took 7m25s
with separate stacks and 4m09s with the shared stack. Based on the four warm
resets, the 88 DB suites project to about 55 minutes, plus the OCR image build
and standalone suite runtime. This is a projection, not a full-run measurement.
CI still uses its existing per-suite steps and provisions OCR and Chromium
separately.
