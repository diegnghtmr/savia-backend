#!/usr/bin/env bash
set -euo pipefail
probe=$(mktemp -d)
trap 'rm -f "$probe/pnpm" "$probe/workdir"; rmdir "$probe"' EXIT
export PROBE_DIR="$probe" REAL_PNPM="$(command -v pnpm)"
export PROBE_OBJECT="runner-isolation-$$.txt"

cat > "$probe/pnpm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-} ${2:-} ${3:-} ${5:-}" == 'exec supabase --workdir status' ]]; then
  printf '%s\n' "$4" > "$PROBE_DIR/workdir"
fi
if [[ "${1:-} ${2:-} ${3:-} ${4:-}" == 'exec vitest run --config' ]]; then
  wd=$(<"$PROBE_DIR/workdir")
  project=$(awk -F'"' '/^project_id = / {print $2}' "$wd/supabase/config.toml")
  container="supabase_storage_$project"
  backend=$(docker exec "$container" printenv FILE_STORAGE_BACKEND_PATH)
  marker_files() {
    docker exec "$container" find "$backend" -type f -path "*/$PROBE_OBJECT/*"
  }
  case "$6" in
    */postgres-pool.integration-spec.ts)
      "$REAL_PNPM" "$@"
      role=$("$REAL_PNPM" exec supabase --workdir "$wd" status -o env |
        awk -F'"' '/^SERVICE_ROLE_KEY=/{print $2}')
      : "${role:?missing disposable service role}"
      curl --fail --silent --show-error -o /dev/null \
        -H "Authorization: Bearer $role" -H 'Content-Type: text/plain' \
        --data-binary 'isolation marker' \
        "http://127.0.0.1:54321/storage/v1/object/exports/$PROBE_OBJECT"
      files=$(marker_files)
      [[ -n "$files" ]]
      exit 0
      ;;
    */workspace.integration-spec.ts)
      files=$(marker_files)
      [[ -z "$files" ]] || { printf 'Storage blob survived reset: %s\n' "$files" >&2; exit 1; }
      ;;
  esac
fi
exec "$REAL_PNPM" "$@"
SH
chmod +x "$probe/pnpm"
PATH="$probe:$PATH" pnpm test:integration:all postgres-pool workspace
