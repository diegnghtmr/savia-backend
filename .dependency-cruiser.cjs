/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const path = require('node:path');

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Warn or error when there is a circular dependency',
      from: {
        path: '^src',
      },
      to: {
        circular: true,
      },
    },
    {
      name: 'feature-isolation',
      severity: 'error',
      comment:
        'Feature modules must not import from each other; shared code belongs in src/platform',
      from: {
        path: '^src/(?!reconciliations/)([^/]+)/',
        pathNot: '^src/platform/',
      },
      to: {
        path: '^src/([^/]+)/',
        pathNot: [
          '^src/$1/',
          '^src/platform/',
          '^src/ledger/transaction-command\\.ts$',
          '^src/accounts/postgres-accounts\\.adapter\\.ts$',
          '^src/ledger/postgres-transaction\\.adapter\\.ts$',
        ],
      },
    },
    {
      name: 'reconciliations-feature-isolation',
      severity: 'error',
      comment:
        'Reconciliations may compose the ledger module, but no other feature may be imported',
      from: {
        path: '^src/reconciliations/',
      },
      to: {
        path: '^src/([^/]+)/',
        pathNot: [
          '^src/reconciliations/',
          '^src/platform/',
          '^src/ledger/ledger\\.module\\.ts$',
          '^src/accounts/postgres-accounts\\.adapter\\.ts$',
          '^src/ledger/postgres-transaction\\.adapter\\.ts$',
        ],
      },
    },
    {
      // src/app.module.ts and src/main.ts sit at the root, so they match neither
      // side of the two rules below (`^src/([^/]+)/` needs a second slash). Both
      // are legitimate composition roots, but any OTHER root-level file would be
      // an invisible tunnel: feature -> src/tunnel.ts -> other feature passes
      // both rules unmatched. Forbid features from importing root files at all;
      // composition flows one way, from the root into the features.
      name: 'no-root-level-tunnel',
      severity: 'error',
      comment:
        'Feature and platform modules must not import root-level src files; composition flows root -> module only',
      from: {
        path: '^src/([^/]+)/',
      },
      to: {
        path: '^src/[^/]+\\.ts$',
      },
    },
    {
      name: 'platform-to-feature-isolation',
      severity: 'error',
      comment: 'Platform layer must not import from any feature module',
      from: {
        path: '^src/platform/',
      },
      to: {
        path: '^src/([^/]+)/',
        pathNot: '^src/platform/',
      },
    },
  ],
  // NOTE: `pnpm architecture:check` cruises `src` only. test/, scripts/ and
  // supabase/ are NOT governed by these rules -- do not mistake a green gate for
  // whole-repo coverage.
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    // Without this, dependency-cruiser sees only what survives compilation, so a
    // type-only import crosses any boundary rule undetected. That is not
    // hypothetical: the cross-feature import this layer was created to stop --
    // accounts reaching into identity's bootstrap-command for FieldViolation --
    // was `import type`, and the rules below would have let it through.
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: path.resolve(__dirname, 'tsconfig.json'),
    },
  },
};
