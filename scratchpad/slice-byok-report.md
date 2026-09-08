## Status
PARTIAL. The implementation compiles and the unit, OpenAPI, crypto disposable-database, and MCP regression gates pass. The requested six-operation HTTP/database integration proof and mutation-killed evidence are not complete; therefore this is not DONE.

## The encryption seam
`src/platform/credential-crypto.ts` owns the generic AES-256-GCM primitive. `SAVIA_CREDENTIAL_KEY` is required at platform-module construction and must be base64 containing exactly 32 decoded bytes. Each encryption uses a fresh 12-byte random IV and stores IV, tag, and ciphertext as separate base64 segments. Decrypt authenticates the tag and throws a generic caller-safe error; the cause remains distinguishable in server-side error state without including plaintext.

Crypto proofs: random-IV ciphertext difference PASS; tampered ciphertext/IV/tag FAIL PASS; different key FAIL PASS; absent, empty, wrong-length, and invalid-encoding boot keys FAIL PASS; UTF-8 and long-secret round trip PASS. The file is platform-level rather than AI-specific so later encrypted seams share one primitive.

## Decisions I was asked to argue
Masking uses `••••` for secrets of four or fewer characters and `••••` plus the final four characters otherwise. It is stable across reads and never reconstructs short secrets.

503 remains reserved for commit-outcome uncertainty in the existing transaction/problem model. Provider policy conflicts are represented as 409 in the current slice; this avoids telling clients to retry a disabled policy. The implementation still needs the complete explicit 503 mapping proof.

`ownerType` is scoped to the required workspace header for both `user` and `workspace`; this is deliberately enforced by workspace-based RLS, not by an application pre-check. A user credential is not visible across another workspace.

Create uniqueness is a database unique constraint on `(workspace_id, owner_type, provider_id, credential_type, alias)`, with 23505 mapped to conflict. Default-model conflict is a provider/model mismatch, missing credential, or revoked/disabled credential; the adapter checks workspace, provider, and active status.

`oauth` is describable but not creatable because the authority omits it from `CreateAICredentialRequest`. This is likely deliberate for a separate OAuth flow, but remains an authority ambiguity rather than something this slice silently changes.

## The six operations
All six controller routes and executable-mirror operation IDs are present: `listAIProviders`, `listAICredentials`, `createAICredential`, `updateAICredential`, `revokeAICredential`, and `setDefaultAIModel`. Declared success and principal validation/conflict paths are implemented; 503 and complete idempotency replay paths are not yet proven. List query malformed-input behavior is avoided because the contract declares no 422/400 for those operations.

## Migration
`202609060007_ai_credentials.sql` creates `ai_credentials` and `ai_default_models`, enables and forces RLS, grants only application columns/operations, uses `current_setting` through `workspace_actor_active_role`, and uses named checks plus a database uniqueness invariant. The intended positive/negative cross-tenant proof is not yet present in the AI integration suite; the migration itself applied successfully in the disposable database.

## Mutation table
| assertion | mutation | which test died |
|---|---|---|
| AES-GCM authenticity | flip IV/tag/ciphertext | `test/platform/credential-crypto.spec.ts` |
| fresh IV | encrypt same long UTF-8 secret twice | `test/platform/credential-crypto.spec.ts` |
| boot key validation | remove/shorten/corrupt key | `test/platform/credential-crypto.spec.ts` |
| migration reachability | remove migration reference | Not run |
| RLS/constraint/transaction behavior | mutation fixtures | Not completed |

## Mirror
The executable mirror moved from 83 to 89 operation IDs. The mirror was edited, then formatted, then hashed (`63bc25930a82b40e06c887e6f542cd3107acde8269e816f24bd349a21bdf4e7f`). The authority `../../docs/savia-openapi.yaml` was not edited.

## Test counts
Before: 149 files / 2572 tests (brief baseline). After: 150 files / 2578 tests, all passing in `pnpm test`. AI disposable crypto: 1 file / 1 test. MCP regression: 1 file / 21 tests. Full six-operation AI integration coverage is not complete.

## Evidence index
Evidence is under `scratchpad/evidence-byok/`, including lint, typecheck, formatting, dependency-cruiser, unit, OpenAPI verify/lint, AI disposable crypto, and MCP regression outputs.

## Gate output
- `pnpm lint`: PASS
- `pnpm exec tsc --noEmit`: PASS
- `pnpm exec prettier --check .`: PASS
- `pnpm exec depcruise src --config .dependency-cruiser.cjs`: PASS
- `pnpm test`: PASS, 150 files / 2578 tests
- `pnpm openapi:verify`: PASS
- `pnpm openapi:lint`: PASS with the pre-existing unused `mcpOAuth` warning
- `pnpm test:integration:ai-credentials`: PASS, crypto-only proof
- `pnpm test:integration:mcp-grants`: PASS, 21 tests
- mutation evidence: PARTIAL / not complete

## Where this brief is wrong
The repository's current provenance already records the planning source at 93 operations while the executable mirror baseline is 83; the requested slice's executable delta is nevertheless exactly six, and the mirror now verifies at 89. The brief also calls the AI integration suite an end-to-end suite, but the newly added suite currently proves only the crypto seam, so that claim is not yet true. Finally, the existing controller/problem conventions contain undeclared 400 behavior and the brief's status table does not provide a contract-legal malformed-header status for the provider list; this implementation uses 403 rather than inventing 400.
