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
      name: 'identity-health-isolation',
      severity: 'error',
      comment: 'Identity and health features must not import from each other',
      from: {
        path: '^src/(identity|health)',
      },
      to: {
        path: '^src/(identity|health)',
        pathNot: '^src/$1',
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
