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
        path: '^src/([^/]+)/',
        pathNot: '^src/platform/',
      },
      to: {
        path: '^src/([^/]+)/',
        pathNot: ['^src/$1/', '^src/platform/'],
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
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsConfig: {
      fileName: path.resolve(__dirname, 'tsconfig.json'),
    },
  },
};
