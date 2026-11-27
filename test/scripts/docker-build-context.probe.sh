#!/usr/bin/env bash
set -euo pipefail
probe=$(mktemp -d)
trap 'rm -rf "$probe"' EXIT
mkdir -p "$probe/context/src/nested" "$probe/context/src/platform" "$probe/context/src/ai" "$probe/context/test/fixtures" "$probe/out"
cp .dockerignore "$probe/context/"
printf 'FROM scratch\nCOPY . /\n' > "$probe/context/Dockerfile"
cd "$probe/context"
# Empty synthetic markers only. The probe never builds from the real source tree.
markers=(
  credential-example.txt Credentials-themed-dummy.txt app-cReDeNtIaLs-themed-dummy.txt
  CREDENTIAL-demo.json Secret-demo.txt SeCrEt-demo.json
  test.PEM test.Key test.P12 test.pFx .EnV-local AuTh.JsOn
)
# Application TypeScript stays in the context even when its name mentions credentials.
sources=(src/nested/app.ts src/platform/credential-crypto.ts src/ai/ai-credential.service.ts)
touch "${sources[@]}"
for marker in "${markers[@]}"; do touch "src/nested/$marker" "test/fixtures/$marker"; done
# Outside src, TypeScript with a credential-like name is still excluded.
touch test/fixtures/CREDENTIAL-demo.ts test/fixtures/SECRET-demo.ts
docker build --network none --output "type=local,dest=$probe/out" .
status=0
for source in "${sources[@]}"; do
  [[ -f "$probe/out/$source" ]] || { printf 'Missing application source: %s\n' "$source" >&2; status=1; }
done
for path in "${markers[@]/#/src/nested/}" "${markers[@]/#/test/fixtures/}" test/fixtures/CREDENTIAL-demo.ts test/fixtures/SECRET-demo.ts; do
  if [[ -e "$probe/out/$path" ]]; then
    printf 'Unexpected Docker context entry: %s\n' "$path" >&2
    status=1
  fi
done
exit "$status"
