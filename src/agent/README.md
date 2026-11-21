# Agent provider

The agent uses the workspace default `providerId:modelId` and its active,
workspace-owned credential. For `api_key` or `gateway_token`, set credential
`metadata.baseUrl` to the API base (for example `https://gateway.example/v1`);
`openai` defaults to `https://api.openai.com/v1`. For `local_endpoint`, set
`secret` to the API base (for example `http://127.0.0.1:11434/v1`); no bearer
header is sent. The adapter appends `/chat/completions` and expects SSE terminated
with `[DONE]`. URLs must use HTTPS except for loopback and explicit local
endpoints. Redirects are not followed. Streams are limited to 30 seconds and 1 MiB.

Only `NODE_ENV=test` or `NODE_ENV=development` enables echo when no default
credential is configured. An unusable configured credential fails rather than
falling back. Tool calling and per-message overrides are not enabled here.
