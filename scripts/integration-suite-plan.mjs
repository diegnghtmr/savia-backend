import process from 'node:process';
import { collectPackageScripts } from './verify-test-script-reachability.mjs';

const prefix = 'test:integration:';
const wrappers = new Set(['all', 'ocr']);
const ocr = new Set(['forecasts', 'receipt-ocr', 'receipt-ocr-engine']);
const [mode, ...selection] = process.argv.slice(2);

function fail(message, status = 64) {
  process.stderr.write(`${message}\n`);
  process.exit(status);
}

const ci = mode === 'ci';
if (!ci && !wrappers.has(mode))
  fail('Expected integration mode: all, ocr or ci');
if (selection.length === 1 && selection[0] === '--help') {
  process.stdout.write(
    ci
      ? 'Usage: bash scripts/run-integration-suites.sh ci <suite> ...\n' +
          'Run the selected suites on the host. Use --list to see the suite names.\n'
      : `Usage: pnpm test:integration:${mode} [--list | <suite> ...]\n` +
          'Without arguments, run every suite in this group. Use --list to see the suite names.\n',
  );
  process.exit(0);
}
if (ci && selection.length === 0) {
  fail('CI integration mode requires an explicit suite selection');
}

const suites = new Map();
for (const [script, command] of Object.entries(collectPackageScripts('.'))) {
  if (!script.startsWith(prefix)) continue;
  const name = script.slice(prefix.length);
  if (wrappers.has(name)) continue;

  const spec = command.match(
    /^bash scripts\/run-disposable-database-suite\.sh (test\/[\w./-]+\.integration-spec\.ts)$/,
  )?.[1];
  if (
    !/^[a-z0-9-]+$/.test(name) ||
    (!spec && !command.startsWith('vitest run '))
  ) {
    fail(`Unsupported integration script: ${script}`, 70);
  }
  if (mode === 'ocr' && !ocr.has(name)) continue;
  const kind = `${!ci && ocr.has(name) ? 'container' : 'host'}-${spec ? 'db' : 'standalone'}`;
  suites.set(name, [name, kind, spec ?? script]);
}

const list = selection.length === 1 && selection[0] === '--list';
const names = list || selection.length === 0 ? [...suites.keys()] : selection;
if (names.length === 0) fail(`No ${mode} integration suites found`, 70);
const seen = new Set();
for (const name of names) {
  if (!suites.has(name)) fail(`Unknown ${mode} integration suite: ${name}`);
  if (seen.has(name)) fail(`Duplicate integration suite: ${name}`);
  seen.add(name);
}

process.stdout.write(
  `${names.map((name) => (list ? name : suites.get(name).join('\t'))).join('\n')}\n`,
);
