#!/usr/bin/env bash
set -euo pipefail

if (( $# != 1 )); then
  exit 64
fi

spec="$1"
case "$spec" in
  test/identity/postgres-pool.integration-spec.ts) ;;
  test/identity/pg-transaction.integration-spec.ts) ;;
  test/identity/pg-transaction-resilience.integration-spec.ts) ;;
  test/identity/bootstrap.integration-spec.ts) ;;
  test/identity/profile.integration-spec.ts) ;;
  test/identity/workspace.integration-spec.ts) ;;
  test/identity/workspace-write-rls.integration-spec.ts) ;;
  test/identity/command-idempotency.integration-spec.ts) ;;
  test/identity/membership-write-rls.integration-spec.ts) ;;
  test/identity/last-owner-guard.integration-spec.ts) ;;
  test/identity/workspace-members.integration-spec.ts) ;;
  test/identity/update-workspace-member.integration-spec.ts) ;;
  *) exit 64 ;;
esac

workdir="$(mktemp -d)"
project_id="savia-postgres-pool-${CI_RUN_ID:-local}-$$"
diagnostic_dir=""
source_config_hash="$(sha256sum supabase/config.toml)"
redact() { perl -0pe 's{postgres(?:ql)?://\S+}{postgresql://[REDACTED]}ig; s{\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}\b}{[REDACTED_JWT]}g; s{\bsb_secret_[A-Za-z0-9_-]+}{[REDACTED_SECRET]}ig; s{-----BEGIN [^-]+-----.*?-----END [^-]+-----}{[REDACTED_KEY]}gs; s{(?i)\b([A-Z_]*(?:PASSWORD|SECRET|TOKEN|KEY)[A-Z_]*=)\S+}{$1[REDACTED]}g; s{(?i)\b(authorization:\s*)\S+}{$1[REDACTED]}g'; }
retain_errors() { grep -Eim 40 'error|fail|fatal|unique|reset|migration|realtime' || true; }
# grep exits 0 on match, 1 on no match, and >1 when the scan itself fails. Only
# an explicit "no match" may be trusted; an execution error must read as "may
# contain credentials" so a scan that never ran cannot cause unscanned
# diagnostics to be retained.
has_credentials() { local status=0; grep -R -Eiqi 'eyJ[A-Za-z0-9_-]+\.|sb_secret_|-----BEGIN |postgres(ql)?://[^[:space:]\[]|(password|secret|token|key)=[^[]' "$diagnostic_dir" || status=$?; (( status != 1 )); }
owned_realtime_running() { docker ps --filter "label=com.supabase.cli.project=$project_id" --format '{{.Names}} {{.Label "com.supabase.cli.service"}}' | grep -Eq "^supabase_realtime_${project_id} |^[^[:space:]]+ realtime$"; }
cleanup() {
  [[ -z "${realtime_guard_pid:-}" ]] || { kill "$realtime_guard_pid" 2>/dev/null || true; wait "$realtime_guard_pid" 2>/dev/null || true; }
  # -k escalates to SIGKILL. Plain `timeout` sends SIGTERM plus SIGCONT, which
  # frees an ordinary stopped child -- but a child that stops itself again on
  # resume (a background process looping on SIGTTOU while touching the tty) is
  # never released, and the bound silently stops bounding: an observed local run
  # sat in this line for over eleven minutes. SIGKILL cannot be caught, blocked,
  # or re-stopped, so it is the only escalation that makes the 30s a real limit.
  [[ "${SAVIA_DISPOSABLE_CLEANUP_PROBE:-}" == 1 ]] || timeout -k 5 30 pnpm exec supabase --workdir "$workdir" stop --no-backup || true
  # A killed `supabase stop` leaves its containers running, so removing only
  # "$project_id" would leak the whole stack -- which then holds port 54322 and
  # fails the next run's start with status 70. Reap by the CLI's own project
  # label instead, which is scoped to this run and cannot touch another project.
  docker ps -aq --filter "label=com.supabase.cli.project=$project_id" | xargs -r timeout -k 5 30 docker rm -f >/dev/null 2>&1 || true
  timeout -k 5 30 docker rm -f "$project_id" >/dev/null 2>&1 || true
  # The stack owns a bridge network too, and a killed teardown leaks it. Docker's
  # default address pool is finite, so accumulated networks exhaust it and a later
  # run fails to allocate a subnet -- observed after four consecutive runs. A
  # network only detaches once its containers are gone, so this must follow the
  # container reaping above.
  docker network ls -q --filter "label=com.supabase.cli.project=$project_id" | xargs -r timeout -k 5 30 docker network rm >/dev/null 2>&1 || true
  rm -rf "$workdir"
  if [[ -n "$diagnostic_dir" ]]; then
    { ! docker ps -aq --filter "label=com.supabase.cli.project=$project_id" | grep -q . && [[ ! -e "$workdir" ]]; } \
      && printf 'owned_containers=absent\nworkdir=removed\n' >> "$diagnostic_dir/cleanup-status" \
      || printf 'cleanup=uncertain\n' >> "$diagnostic_dir/cleanup-status"
  fi
}
# Propagate the signal as the conventional 128+N status. `trap cleanup EXIT`
# still fires, so resources are released either way, but exiting 0 here would
# report a cancelled or timed-out CI run as a passing gate.
trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup EXIT

if [[ "${SAVIA_DISPOSABLE_CLEANUP_PROBE:-}" == 1 ]]; then
  : "${SAVIA_CLEANUP_RECORD:?}"
  docker create --name "$project_id" --label savia.cleanup.proof=1 alpine:latest >/dev/null
  printf '%s:%s\n' "$workdir" "$project_id" > "$SAVIA_CLEANUP_RECORD"
  while :; do sleep 1; done
fi

mkdir -p "$workdir/supabase/migrations"
cp supabase/config.toml "$workdir/supabase/config.toml"
cp supabase/migrations/*.sql "$workdir/supabase/migrations/"
sed -i "s/^project_id = .*/project_id = \"$project_id\"/" "$workdir/supabase/config.toml"
config="$workdir/supabase/config.toml"
(( $(grep -Ec '^\[realtime\]$' "$config" || true) == 0 )) || { printf 'Disposable config already defines Realtime.\n' >&2; exit 70; }
perl -0pi -e 's/\z/\n[realtime]\nenabled = false\n/ or die "Cannot disable Realtime\n"' "$config"
(( $(perl -0777 -ne '$count = () = /^\[realtime\]\nenabled = false$/mg; print $count' "$config") == 1 )) && [[ "$source_config_hash" == "$(sha256sum supabase/config.toml)" ]] || { printf 'Disposable Realtime disablement proof failed.\n' >&2; exit 70; }
start_log="$workdir/start.log"
pnpm exec supabase --workdir "$workdir" start > "$start_log" 2>&1 || { start_status=$?; diagnostic_dir="$(mktemp -d "${TMPDIR:-/tmp}/savia-start-failure-${project_id}-XXXXXX")"; { printf 'supabase_start_status=%s\n' "$start_status"; redact < "$start_log" | retain_errors; } > "$diagnostic_dir/start-errors.log"; if has_credentials; then rm -rf "$diagnostic_dir"; diagnostic_dir=""; printf 'Supabase start failed; unsafe diagnostics deleted.\n' >&2; else printf 'Supabase start failed (status %s); sanitized diagnostics retained at %s\n' "$start_status" "$diagnostic_dir" >&2; fi; exit "$start_status"; }
rm -f "$start_log"
eval "$(pnpm exec supabase --workdir "$workdir" status -o env)"
: "${DB_URL:?Supabase status did not export DB_URL}"
if owned_realtime_running; then printf 'Realtime must be stopped before reset.\n' >&2; exit 70; fi
reset_log="$workdir/reset.log"
realtime_guard="$workdir/realtime-guard"
(while :; do owned_realtime_running && { : > "$realtime_guard"; exit; }; sleep .05; done) & realtime_guard_pid=$!
set +e
pnpm exec supabase --workdir "$workdir" db reset --no-seed 2>&1 | redact | tee "$reset_log"
reset_status=${PIPESTATUS[0]}
set -e
kill "$realtime_guard_pid" 2>/dev/null || true; wait "$realtime_guard_pid" 2>/dev/null || true; realtime_guard_pid=""
[[ ! -e "$realtime_guard" ]] && ! owned_realtime_running || { printf 'Realtime started during reset.\n' >&2; exit 70; }
if (( reset_status != 0 )); then
  diagnostic_dir="$(mktemp -d "${TMPDIR:-/tmp}/savia-reset-failure-${project_id}-XXXXXX")"
  retain_errors < "$reset_log" > "$diagnostic_dir/reset-errors.log"
  mapfile -t owned_containers < <(docker ps -aq --filter "label=com.supabase.cli.project=$project_id")
  for container in "${owned_containers[@]}"; do
    docker inspect --format '{{.Name}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} project={{index .Config.Labels "com.supabase.cli.project"}}' "$container" | redact > "$diagnostic_dir/container-$container-state" || true
    docker logs --timestamps "$container" 2>&1 | redact | retain_errors > "$diagnostic_dir/container-$container-errors.log" || true
  done
  if has_credentials; then rm -rf "$diagnostic_dir"; diagnostic_dir=""; printf 'Supabase reset failed; unsafe diagnostics deleted.\n' >&2
  else printf 'Supabase reset failed; sanitized diagnostics retained at %s\n' "$diagnostic_dir" >&2; fi
  exit "$reset_status"
fi
if [[ -n "${VITEST_PATTERN:-}" ]]; then
  DATABASE_URL="$DB_URL" pnpm exec vitest run --config vitest.integration.config.ts "$spec" --testNamePattern "$VITEST_PATTERN"
else
  DATABASE_URL="$DB_URL" pnpm exec vitest run --config vitest.integration.config.ts "$spec"
fi
