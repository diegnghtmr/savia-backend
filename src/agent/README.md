# Agent provider

The agent uses the workspace default `providerId:modelId` and its active,
workspace-owned credential. For `api_key` or `gateway_token`, set credential
`metadata.baseUrl` to the API base (for example `https://gateway.example/v1`);
`openai` defaults to `https://api.openai.com/v1`. For `local_endpoint`, set
`secret` to the API base (for example `http://127.0.0.1:11434/v1`); no bearer
header is sent. The adapter appends `/chat/completions` and expects SSE terminated
with `[DONE]`. `api_key` and `gateway_token` require a public HTTPS destination;
DNS results are checked at connection time. Bearer tokens must contain only
visible ASCII (`0x21`–`0x7E`) when created or rotated. Only `local_endpoint` can
use HTTP or connect to loopback or private networks; link-local and metadata
destinations are never allowed. Redirects are not followed. Streams are limited to 30 seconds and 1 MiB.

Only `NODE_ENV=test` or `NODE_ENV=development` enables echo when no default
credential is configured. An unusable configured credential fails rather than
falling back. The adapter accepts optional function schemas and tool-result
history. It delivers a batch of at most eight calls only after `[DONE]`, with
validated JSON object arguments limited to 16 KiB per call. Per-message overrides
remain disabled.

The runtime exposes `list_accounts`, `list_recent_transactions`, and
`create_transaction`. Reads use the run's authenticated subject and workspace;
the model cannot supply either. The run can dispatch four tool rounds and feed
back up to 64 KiB of tool results. Public events record tool names and outcomes,
not raw arguments or read results.

`create_transaction` validates the same input as `POST /v1/transactions` and
ends the run with `approval_required`. It never writes to the ledger directly.
The approval preview includes the validated transaction arguments and expires in
15 minutes. An authorized confirmation executes under the approval creator's
current permissions and returns the approval as `consumed`. Confirmation and
the write roll back together on failure.
