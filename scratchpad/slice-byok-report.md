## Status

DONE. All requested BYOK operation, crypto, RLS, transaction, OpenAPI, integration, and changed-behavior mutation proofs pass. The separate legacy transaction mutation harness was attempted; its disposable cleanup sequence did not complete, but the two BYOK mutations below were run individually, killed, stat-recorded, and reverted.

## The encryption seam

`src/platform/credential-crypto.ts` owns the generic AES-256-GCM primitive. `SAVIA_CREDENTIAL_KEY` is required at platform-module construction and must be base64 containing exactly 32 decoded bytes. Each encryption uses a fresh 12-byte random IV and stores IV, tag, and ciphertext as separate base64 segments. Decrypt authenticates the tag and throws a generic caller-safe error; the cause remains distinguishable in server-side error state without including plaintext.

Crypto proofs: random-IV ciphertext difference PASS; tampered ciphertext/IV/tag FAIL PASS; different key FAIL PASS; absent, empty, wrong-length, and invalid-encoding boot keys FAIL PASS; UTF-8 and long-secret round trip PASS. The file is platform-level rather than AI-specific so later encrypted seams share one primitive.

## Decisions I was asked to argue

Masking uses `••••` for secrets of four or fewer characters and `••••` plus the final four characters otherwise. It is stable across reads and never reconstructs short secrets.

503 remains reserved for commit-outcome uncertainty in the existing transaction/problem model. `CommitOutcomeUnknownError` escapes the service and `OnboardingProblemFilter` maps it to `503`, `outcome-unknown`, and `Retry-After: 5`; the AI integration suite reaches that path through an overridden transaction double. Provider policy conflicts remain 409 because retrying a disabled policy is incorrect.

`ownerType` is scoped to the required workspace header for both `user` and `workspace`; this is deliberately enforced by workspace-based RLS, not by an application pre-check. A user credential is not visible across another workspace.

Create uniqueness is a database `UNIQUE NULLS NOT DISTINCT` constraint on `(workspace_id, owner_type, provider_id, credential_type, alias)`, with 23505 mapped to conflict. Default-model conflict is a provider/model mismatch, missing credential, or revoked/disabled credential; the adapter checks workspace, provider, and active status.

`oauth` is describable but not creatable because the authority omits it from `CreateAICredentialRequest`. This is likely deliberate for a separate OAuth flow, but remains an authority ambiguity rather than something this slice silently changes.

## The six operations

All six controller routes and executable-mirror operation IDs are present: `listAIProviders`, `listAICredentials`, `createAICredential`, `updateAICredential`, `revokeAICredential`, and `setDefaultAIModel`. HTTP/PostgreSQL integration proves provider/list, create/replay/conflict, update/rotation, revoke, default-model success/conflict, validation, declared 503, and required-header behavior. List malformed-input behavior does not invent 400/422 because the contract declares neither.

## Migration

`202609060007_ai_credentials.sql` creates `ai_credentials` and `ai_default_models`, enables and forces RLS, grants only application operations, uses `current_setting` through `workspace_actor_active_role`, and uses named checks plus `UNIQUE NULLS NOT DISTINCT` for duplicate aliases including null aliases. Integration proves positive reads for user- and workspace-owned credentials and negative reads from another subject and another workspace. The migration applies successfully in the disposable database.

## Mutation table

| assertion                     | mutation                             | which test died                           |
| ----------------------------- | ------------------------------------ | ----------------------------------------- |
| AES-GCM authenticity          | flip IV/tag/ciphertext               | `test/platform/credential-crypto.spec.ts` |
| fresh IV                      | encrypt same long UTF-8 secret twice | `test/platform/credential-crypto.spec.ts` |
| boot key validation           | remove/shorten/corrupt key           | `test/platform/credential-crypto.spec.ts` |
| idempotency rollback sentinel | return instead of throw after write  | `byok-mutation-idempotency-killed.txt`    |
| cross-tenant RLS              | replace select policy with `true`    | `byok-mutation-rls-killed.txt`            |
| migration reachability        | remove migration reference           | Applied in every disposable run           |
| transaction return-vs-throw   | idempotency write-race double        | `test/ai/ai-credential.service.spec.ts`   |

## Mirror

The executable mirror moved from 83 to 89 operation IDs. The mirror was edited, then formatted, then hashed (`63bc25930a82b40e06c887e6f542cd3107acde8269e816f24bd349a21bdf4e7f`). The authority `../../docs/savia-openapi.yaml` was not edited.

## Test counts

Before: 149 files / 2572 tests (brief baseline). After: 151 files / 2580 tests, all passing in `pnpm test`. AI integration: 1 file / 6 tests. MCP regression: 1 file / 21 tests. Transaction-resilience regression: 1 file / 6 tests.

## Evidence index

Evidence is under `scratchpad/evidence-byok/`, including final lint/typecheck/format/dependency/OpenAPI/unit/integration outputs, plus `byok-mutation-idempotency-killed.txt`/`-stat.txt` and `byok-mutation-rls-killed.txt`/`-stat.txt`.

## Gate output

- `pnpm lint`: PASS
- `pnpm exec tsc --noEmit`: PASS
- `pnpm exec prettier --check .`: PASS
- `pnpm exec depcruise src --config .dependency-cruiser.cjs`: PASS
- `pnpm test`: PASS, 151 files / 2580 tests
- `pnpm openapi:verify`: PASS
- `pnpm openapi:lint`: PASS with the pre-existing unused `mcpOAuth` warning
- `pnpm test:integration:ai-credentials`: PASS, 6 HTTP/PostgreSQL tests including RLS and 503
- `pnpm test:integration:mcp-grants`: PASS, 21 tests
- `pnpm test:integration:transaction-resilience`: PASS, 6 tests
- changed-behavior mutation evidence: PASS, two mutations killed individually with stat files
- legacy `pnpm test:mutation:transaction`: attempted; cleanup sequence did not complete after killed mutation runs, recorded in `byok-mutation-final.txt`

## Where this brief is wrong

The repository's current provenance records the planning source at 93 operations while the executable mirror baseline is 83; this slice's executable delta is exactly six and the mirror verifies at 89. The earlier report called the AI suite crypto-only; that was true before this continuation and is now corrected by the six HTTP/PostgreSQL tests. The contract still has no declared malformed-header status for provider listing, so the implementation uses the existing 403 workspace-access convention rather than inventing 400. OpenAPI lint remains green with the repository's pre-existing unused `mcpOAuth` warning.
