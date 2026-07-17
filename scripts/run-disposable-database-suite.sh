#!/usr/bin/env bash
set -euo pipefail

if (( $# != 1 )); then
  exit 64
fi

spec="$1"
case "$spec" in
  test/identity/postgres-pool.integration-spec.ts) ;;
  test/identity/pg-transaction.integration-spec.ts) ;;
  *) exit 64 ;;
esac

workdir="$(mktemp -d)"
project_id="savia-postgres-pool-${CI_RUN_ID:-local}-$$"
cleanup() {
  pnpm exec supabase --workdir "$workdir" stop --no-backup || true
  rm -rf "$workdir"
}
trap cleanup EXIT INT TERM

mkdir -p "$workdir/supabase/migrations"
cp supabase/config.toml "$workdir/supabase/config.toml"
cp supabase/migrations/*.sql "$workdir/supabase/migrations/"
sed -i "s/^project_id = .*/project_id = \"$project_id\"/" "$workdir/supabase/config.toml"
pnpm exec supabase --workdir "$workdir" start
eval "$(pnpm exec supabase --workdir "$workdir" status -o env)"
: "${DB_URL:?Supabase status did not export DB_URL}"
pnpm exec supabase --workdir "$workdir" db reset --no-seed
DATABASE_URL="$DB_URL" pnpm exec vitest run --config vitest.integration.config.ts "$spec"
