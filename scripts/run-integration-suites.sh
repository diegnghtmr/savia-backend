#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ "$#" == 2 && ( "$2" == --list || "$2" == --help ) ]]; then
  exec node scripts/integration-suite-plan.mjs "$@"
fi
plan="$(node scripts/integration-suite-plan.mjs "$@")"
mapfile -t suites <<< "$plan"

# Other disposable runs use this same host-port lock. Keep it through cleanup.
exec 9>>/tmp/savia-db.lock
flock --exclusive 9
source scripts/run-disposable-database-suite.sh

project_id="savia-integration-$$-$RANDOM"
workdir=""
cleanup_mode=""
image="savia-test-runner:local"
image_ready=false
container_active=false
statuses=()
durations=()

finish() {
  local result=$? index name status passed=0 failed=0 pending=0
  if [[ -n "$workdir" ]]; then
    cleanup "$cleanup_mode"
  elif "$container_active"; then
    docker rm -f "$project_id" >/dev/null 2>&1 || true
  fi
  printf '\nIntegration summary:\n'
  for index in "${!suites[@]}"; do
    name="${suites[index]%%$'\t'*}"
    status="${statuses[index]:-}"
    if [[ "$status" == 0 ]]; then
      printf '  PASS %s (%ss)\n' "$name" "${durations[index]}"
      passed=$((passed + 1))
    elif [[ -n "$status" ]]; then
      printf '  FAIL %s (exit %s, %ss)\n' "$name" "$status" "${durations[index]}"
      failed=$((failed + 1))
    else
      printf '  NOT RUN %s\n' "$name"
      pending=$((pending + 1))
    fi
  done
  printf '%d passed, %d failed, %d not run\n' "$passed" "$failed" "$pending"
  exit "$result"
}
trap 'exit 130' INT
trap 'exit 143' TERM
trap finish EXIT

run_in_container() {
  local kind="$1" target="$2" result=0
  local -a runner=(docker run --rm --init --name "$project_id" --env CI=true)
  container_active=true
  if [[ "$kind" == container-db ]]; then
    # The disposable Supabase stack exposes its DB on the Linux host's loopback.
    local -a args=(run --config vitest.integration.config.ts "$target")
    if [[ -n "${VITEST_PATTERN:-}" ]]; then args+=(--testNamePattern "$VITEST_PATTERN"); fi
    DATABASE_URL="$DB_URL" "${runner[@]}" --network host --env DATABASE_URL "$image" pnpm exec vitest "${args[@]}" || result=$?
  else
    "${runner[@]}" --network none "$image" pnpm run "$target" || result=$?
  fi
  container_active=false
  return "$result"
}

reset_disposable_storage() {
  local storage="supabase_storage_$project_id" owned_mount volume_owner
  # db reset clears metadata, not file bytes. Only wipe the CLI's project-owned
  # volume: never treat an arbitrary environment path or bind mount as scratch.
  local mount_format='{{index .Config.Labels "com.supabase.cli.project"}} {{range .Mounts}}{{if eq .Destination "/mnt"}}{{.Type}}:{{.Name}}{{end}}{{end}}'
  # If ownership cannot be proven, avoid CLI stop --no-backup: cleanup must
  # select resources by project label rather than assuming names are owned.
  cleanup_mode=labels-only
  owned_mount="$(docker inspect --type container --format "$mount_format" "$storage")" || return
  if [[ "$owned_mount" != "$project_id volume:$storage" ]]; then
    printf 'Refusing to reset Storage: %s does not have the expected disposable volume.\n' "$storage" >&2
    return 70
  fi
  volume_owner="$(docker volume inspect --format '{{index .Labels "com.supabase.cli.project"}}' "$storage")" || return
  if [[ "$volume_owner" != "$project_id" ]]; then
    printf 'Refusing to reset Storage: the mounted volume is not owned by the disposable project.\n' >&2
    return 70
  fi
  cleanup_mode=""
  docker exec "$storage" sh -eu -c '
    backend=${FILE_STORAGE_BACKEND_PATH:?}
    if [ "$backend" != /mnt ] || [ ! -d "$backend" ] || [ -L "$backend" ]; then
      printf "Refusing to reset Storage: unexpected file backend path.\n" >&2
      exit 70
    fi
    find "$backend" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  '
}

failed=0
for index in "${!suites[@]}"; do
  IFS=$'\t' read -r name kind target <<< "${suites[index]}"
  printf '==> %s\n' "$name"
  started=$SECONDS
  status=0
  if [[ "$kind" == container-* ]] && ! "$image_ready"; then
    docker build --tag "$image" --file docker/test-runner/Dockerfile .
    image_ready=true
  fi
  if [[ "$kind" == *-db ]]; then
    if [[ -z "$workdir" ]]; then
      init_disposable_database "$project_id"
      start_disposable_database "${1:-}"
    fi
    if ! reset_disposable_database >/dev/null; then
      # No test may run against a failed or partially applied reset.
      printf 'Aborting: clean database reset failed before %s.\n' "$name" >&2
      exit 1
    fi
    if ! reset_disposable_storage; then
      printf 'Aborting: clean Storage reset failed before %s.\n' "$name" >&2
      exit 1
    fi
  fi
  case "$kind" in
    host-db) run_disposable_spec "$target" || status=$? ;;
    host-standalone) pnpm run "$target" || status=$? ;;
    container-*) run_in_container "$kind" "$target" || status=$? ;;
  esac
  statuses[index]="$status"
  durations[index]=$((SECONDS - started))
  if (( status != 0 )); then failed=1; fi
done
exit "$failed"
