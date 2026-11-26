#!/usr/bin/env bash
set -euo pipefail
probe=$(mktemp -d)
trap 'rm -rf "$probe"' EXIT
mkdir -p "$probe/context/src/nested" "$probe/context/src/platform" "$probe/out"
cp .dockerignore "$probe/context/"
printf 'FROM scratch\nCOPY . /\n' > "$probe/context/Dockerfile"
cd "$probe/context"
# Empty synthetic markers only. The probe never builds from the real source tree.
markers=(
  credential-example.txt Credentials-themed-dummy.txt CREDENTIAL-demo.ts
  credential-crypto.ts
  Secret-demo.txt SECRET-demo.ts SeCrEt-demo.json
  test.PEM test.Key test.P12 test.pFx .EnV-local AuTh.JsOn
)
touch src/nested/app.ts src/platform/credential-crypto.ts
for marker in "${markers[@]}"; do touch "src/nested/$marker"; done
docker build --network none --output "type=local,dest=$probe/out" .
test -f "$probe/out/src/nested/app.ts"
test -f "$probe/out/src/platform/credential-crypto.ts"
status=0
for marker in "${markers[@]}"; do
  if [[ -e "$probe/out/src/nested/$marker" ]]; then
    printf 'Unexpected Docker context entry: %s\n' "$marker" >&2
    status=1
  fi
done
exit "$status"
