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
validated JSON object arguments limited to 16 KiB per call. The message service
does not yet register or dispatch tools. Per-message overrides remain disabled.
