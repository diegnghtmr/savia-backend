#!/usr/bin/env bash
set -euo pipefail

if [[ "${SAVIA_TRANSACTION_MUTATION:-}" == 1 && "${SAVIA_MUTATION_SIGNAL_CHILD:-}" != 1 ]]; then exit 70; fi
trap - INT TERM
export SAVIA_TRANSACTION_MUTATION=1
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
workdir="$(mktemp -d)"
disposable_pid=""
cleanup() {
  if [[ -n "$disposable_pid" ]]; then kill -TERM "$disposable_pid" 2>/dev/null || true; wait "$disposable_pid" || true; fi
  rm -rf "$workdir"
}
# Propagate the signal as the conventional 128+N status; the signal self-test
# below asserts these exact values. `trap cleanup EXIT` still fires, so the copy
# and any child suite are torn down either way.
trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup EXIT
mkdir -m 700 "$workdir/copy"
tar --exclude=.git --exclude=node_modules -cf - -C "$root" . | tar -xf - -C "$workdir/copy"
ln -s "$root/node_modules" "$workdir/copy/node_modules"

if [[ "${SAVIA_MUTATION_SIGNAL_CHILD:-}" == 1 ]]; then
  record="$workdir/cleanup-record"
  (cd "$workdir/copy" && exec env SAVIA_DISPOSABLE_CLEANUP_PROBE=1 SAVIA_CLEANUP_RECORD="$record" \
  bash scripts/run-disposable-database-suite.sh test/identity/pg-transaction-resilience.integration-spec.ts >/dev/null 2>&1) & disposable_pid=$!
  deadline=$((SECONDS + 90)); until [[ -s "$record" ]]; do kill -0 "$disposable_pid" 2>/dev/null && (( SECONDS < deadline )) || exit 70; sleep .05; done
  printf '%s:%s\n' "$workdir" "$(<"$record")"
  [[ "${SAVIA_MUTATION_SIGNAL:-}" == EXIT ]] && exit 0
  while :; do sleep 1; done
fi

restore() { cp "$1.original" "$1"; }
mutate() {
  local path="$1" expression="$2"
  local marker="$workdir/proof-$(basename "$path")-$RANDOM" status=0
  cp "$path" "$path.original"
  perl -0pi -e "$expression" "$path"
  (cd "$workdir/copy" && SAVIA_MUTATION_PROOF_FILE="$marker" pnpm test:integration:transaction-resilience) || status=$?
  restore "$path"
  # The marker is written when the spec module loads. Its absence means the
  # disposable database never came up, which must not be reported as a surviving
  # mutation: infrastructure flakiness and a real coverage gap need different
  # signatures or every Docker hiccup reads as a test-quality regression.
  if [[ ! -f "$marker" ]]; then
    printf 'Disposable database never reached the spec for %s (status %s); infrastructure failure, mutation unproven.\n' "$path" "$status" >&2
    return 70
  fi
  if (( status == 0 )); then
    printf 'Mutation survived undetected in %s; the resilience suite does not cover it.\n' "$path" >&2
    return 1
  fi
}
# Each mutation names the invariant it must kill. If the suite still passes with
# the mutation applied, that invariant is unprotected.
# Invariant: connecting after the pool ended is rejected rather than reopening it.
mutate "$workdir/copy/src/identity/postgres-pool.ts" 's/if \(this\.endPromise\)/if (false)/'
# Invariant: pool configuration is resolved from the environment at first use.
mutate "$workdir/copy/src/identity/identity.module.ts" 's/PostgresConfig\.fromEnvironment\(process\.env\)/PostgresConfig.fromEnvironment({ ...process.env, DATABASE_URL: undefined })/'
# Invariant: only a transaction that actually began is rolled back.
mutate "$workdir/copy/src/identity/pg-transaction.ts" 's/let began = false;/let began = true;/'
# Invariant: a client broken during rollback is destroyed, not returned to the pool.
mutate "$workdir/copy/src/identity/pg-transaction.ts" 's/client\.release\(rollbackError instanceof Error \? rollbackError : undefined\);/client.release();/'

for signal in EXIT INT TERM; do
  record="$(mktemp)"
  SAVIA_MUTATION_SIGNAL_CHILD=1 SAVIA_MUTATION_SIGNAL="$signal" env --default-signal=INT bash "$0" > "$record" & pid=$!
  deadline=$((SECONDS + 90)); while [[ ! -s "$record" ]]; do kill -0 "$pid" 2>/dev/null && (( SECONDS < deadline )) || exit 70; sleep .05; done
  [[ "$signal" == EXIT ]] || kill -s "$signal" "$pid"
  # Assert the exact propagated status. Accepting any status here, or requiring
  # 0, is what previously let a signalled run masquerade as a clean one.
  case "$signal" in EXIT) expected=0 ;; INT) expected=130 ;; TERM) expected=143 ;; esac
  status=0; wait "$pid" || status=$?
  (( status == expected )) || { printf 'Cleanup on %s exited %s, expected %s.\n' "$signal" "$status" "$expected" >&2; exit 70; }
  IFS=: read -r mutation_workdir disposable_workdir container < "$record"
  test ! -e "$mutation_workdir/copy" && test ! -e "$disposable_workdir"
  ! docker container inspect "$container" >/dev/null 2>&1
  rm -f "$record"
done
