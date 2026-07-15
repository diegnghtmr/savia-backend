# Savia Backend

A minimal NestJS/Fastify backend service.

## Requirements

- Node.js 24.18.0
- pnpm 11.13.0

## Commands

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm start
```

`GET /health` is the only executable OpenAPI operation; unknown routes return `404`.

`openapi/savia.openapi.yaml` is the client-generation input. Its provenance records
the local planning source constants. Backend CI cannot access, authenticate, or independently
re-hash that local source; it validates only committed constants and executable contract identity.
