/**
 * Known limitations (deliberately bounded):
 * 1. A '#' inside a quoted YAML string can strip a real invocation. Failure
 *    direction is a loud false positive, never a silent miss.
 * 2. A quoted invocation such as `pnpm "test:database"` is not recognised, so a
 *    stale allow-list entry can survive. The script is still genuinely covered;
 *    this is hygiene, not a coverage hole.
 * 3. The guard is reachability-only, not inventory protection: it does not
 *    assert a minimum script count at runtime.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { stripHashComments } from './verify-test-gates.mjs';

export const COVERAGE_ALLOWLIST = [
  {
    script: 'test:database',
    reason: 'CI step "database RLS contract" runs identity_rls.test.sql inline',
  },
  {
    script: 'test:database:bootstrap',
    reason:
      'CI step "database bootstrap contract" runs identity_bootstrap_rls.test.sql inline',
  },
  {
    script: 'test:integration:all',
    reason:
      'Local convenience wrapper; CI selects suites with the shared runner in host mode',
  },
  {
    script: 'test:integration:ocr',
    reason:
      'Local Docker wrapper; CI uses distro OCR packages and runs these suites on the host',
  },
  {
    script: 'test:runner-isolation',
    reason: 'Local Docker probe for the shared runner’s Storage isolation',
  },
  {
    script: 'test:docker-context',
    reason:
      'Local Docker probe for the OCR image build context; CI does not build that image',
  },
];

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchScriptInvocation(text, scriptName) {
  const escaped = escapeRegex(scriptName);
  const regex = new RegExp(
    `(?:^|[^\\w:.\\-\\/])pnpm\\s+(?:run\\s+)?${escaped}(?![\\w:.\\-])`,
    'm',
  );
  return regex.test(text);
}

function getLeadingSpaces(line) {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

export function extractRunBlocks(workflowSource) {
  const lines = (workflowSource || '').split('\n');
  const runBlocks = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!match) continue;

    const indent = match[1].length;
    const rest = match[2].trim();
    const isBlockScalar = /^([|>][-+]?)?$/.test(rest);

    if (isBlockScalar) {
      const blockLines = [];
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j];
        if (nextLine.trim() === '') {
          blockLines.push(nextLine);
          j++;
        } else if (getLeadingSpaces(nextLine) > indent) {
          blockLines.push(nextLine);
          j++;
        } else {
          break;
        }
      }
      runBlocks.push(blockLines.join('\n'));
      i = j - 1;
    } else {
      runBlocks.push(rest);
    }
  }

  return runBlocks;
}

// Keep the CI batch syntax intentionally literal: it is both the command that
// executes and the source of truth for suite assignment and reachability.
const INTEGRATION_PREFIX = 'test:integration:';
const CI_BATCH = 'bash scripts/run-integration-suites.sh ci';

function extractCiBatchSuites(run) {
  const command = run.trim().replace(/\s+/g, ' ');
  const prefix = CI_BATCH + ' ';
  if (!command.startsWith(prefix)) return null;
  const names = command.slice(prefix.length).split(' ');
  if (!names.every((name) => /^[a-z0-9-]+$/.test(name))) return null;
  return names.map((name) => INTEGRATION_PREFIX + name);
}

const INLINE_SQL_SUITES = new Map([
  ['identity_rls.test.sql', 'test:database'],
  ['identity_bootstrap_rls.test.sql', 'test:database:bootstrap'],
]);
const separateSuites = [
  ...INLINE_SQL_SUITES.values(),
  'test:schema-contract',
  'test:mutation:transaction',
];

export function analyzeIntegrationShardAssignments(scripts, workflowSource) {
  // This guard intentionally checks the workflow's fixed, simple matrix shape.
  // A format change must update the guard rather than silently skip validation.
  const job = stripHashComments(workflowSource)
    .split(/^ {2}integration:[ \t]*$/m)[1]
    ?.split(/^ {2}[\w-]+:/m)[0];
  const matrix = job
    ?.split(/^ {6}matrix:[ \t]*$/m)[1]
    ?.split(/^ {4}steps:[ \t]*$/m)[0];
  const row = /^\s*shard:[ \t]*\[([1-9]\d*(?:,[ \t]*[1-9]\d*)*)\]\s*$/.exec(
    matrix ?? '',
  );
  const shards = row?.[1].split(',').map((id) => Number(id));
  if (!shards || new Set(shards).size !== shards.length) {
    return [
      'CI integration must have a single matrix of unique positive shard IDs',
    ];
  }

  const batched = new Set(
    Object.keys(scripts).filter(
      (name) =>
        name.startsWith(INTEGRATION_PREFIX) &&
        name !== 'test:integration:all' &&
        name !== 'test:integration:ocr',
    ),
  );
  const assignments = new Map(
    [...batched, ...separateSuites].map((name) => [name, []]),
  );
  const batches = new Map(shards.map((id) => [id, 0]));
  const violations = [];
  for (const step of job.split(/^ {6}- /m).slice(1)) {
    const run = extractRunBlocks(step)[0] ?? '';
    const isBatch = run.includes('scripts/run-integration-suites.sh');
    const direct = [
      ...run.matchAll(/(?:^|[^\w:./-])pnpm\s+(?:run\s+)?(test:[\w:.-]+)/gm),
    ].map((match) => match[1]);
    const inlineSql = [
      ...run.matchAll(/\btest db --local\b([^\n\\]*(?:\\\n[^\n]*)?)/g),
    ].map(
      (match) =>
        [...INLINE_SQL_SUITES].find(([file]) =>
          match[1].includes('/' + file + '"'),
        )?.[1],
    );
    if (!isBatch && direct.length === 0 && inlineSql.length === 0) continue;
    const title = step.split('\n', 1)[0];
    const conditions = [...step.matchAll(/^ {8}if:[ \t]*(.*)$/gm)];
    const shard = Number(
      /^matrix\.shard == ([1-9]\d*)$/.exec(conditions[0]?.[1] ?? '')?.[1],
    );
    if (conditions.length !== 1 || !batches.has(shard)) {
      violations.push(
        'Integration step must select exactly one matrix shard: ' + title,
      );
      continue;
    }
    if (isBatch) {
      batches.set(shard, batches.get(shard) + 1);
      const names = extractCiBatchSuites(run);
      const foldsIntoOneCommand =
        /^ {8}run: >-$/m.test(step) &&
        run
          .trimEnd()
          .split('\n')
          .every((line) => /^ {10}\S/.test(line));
      if (!names || !foldsIntoOneCommand) {
        violations.push('Expected a literal folded CI suite list: ' + title);
      } else {
        for (const name of names) {
          if (batched.has(name)) assignments.get(name).push(shard);
          else violations.push('Unknown CI batch suite: ' + name);
        }
      }
    }
    for (const name of [...direct, ...inlineSql]) {
      if (separateSuites.includes(name)) assignments.get(name).push(shard);
      else
        violations.push(
          'Unexpected standalone integration suite: ' + (name ?? title),
        );
    }
  }

  for (const [id, count] of batches) {
    if (count !== 1)
      violations.push(
        'Shard ' + id + ' must run exactly one CI batch; found ' + count,
      );
  }
  for (const [name, ids] of assignments) {
    if (ids.length !== 1) {
      violations.push(
        name +
          ' must run exactly once across CI shards; found ' +
          ids.length +
          (ids.length ? ' (shards ' + ids.join(', ') + ')' : ''),
      );
    }
  }
  return violations;
}

export function analyzeTestScriptReachability(
  scripts,
  workflowSources,
  allowList,
) {
  const allScriptNames = Object.keys(scripts || {});
  const checkedScripts = allScriptNames.filter(
    (name) => name === 'test' || name.startsWith('test:'),
  );

  const cleanWorkflowSources = (workflowSources || []).map((wf) => ({
    path: wf.path,
    source: stripHashComments(wf.source || ''),
  }));

  const workflowRunBlocks = cleanWorkflowSources.flatMap((wf) =>
    extractRunBlocks(wf.source),
  );

  // Directly invoked scripts and the literal selections handed to the CI runner.
  const directlyInvoked = new Set(
    workflowRunBlocks.flatMap((block) => extractCiBatchSuites(block) ?? []),
  );
  for (const name of allScriptNames) {
    const isDirect = workflowRunBlocks.some((block) =>
      matchScriptInvocation(block, name),
    );
    if (isDirect) {
      directlyInvoked.add(name);
    }
  }

  // Graph adjacency: script -> target scripts it invokes
  const adjacency = new Map();
  for (const name of allScriptNames) {
    const body = scripts[name] || '';
    const targets = [];
    for (const target of allScriptNames) {
      if (matchScriptInvocation(body, target)) {
        targets.push(target);
      }
    }
    adjacency.set(name, targets);
  }

  // BFS traversal from directlyInvoked
  const reachableSet = new Set();
  const queue = [...directlyInvoked];
  for (const item of queue) {
    reachableSet.add(item);
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const targets = adjacency.get(current) || [];
    for (const target of targets) {
      if (!reachableSet.has(target)) {
        reachableSet.add(target);
        queue.push(target);
      }
    }
  }

  const reachable = checkedScripts.filter((name) => reachableSet.has(name));
  const allowListed = [];
  const violations = [];

  const allowListByName = new Map();
  for (const entry of allowList || []) {
    allowListByName.set(entry.script, entry);
    if (!allScriptNames.includes(entry.script)) {
      violations.push(
        `Allow-list entry '${entry.script}' is stale: no such script exists in package.json (unreachable-test-script-gate)`,
      );
    } else if (reachableSet.has(entry.script)) {
      violations.push(
        `Allow-list entry '${entry.script}' is stale: script is now invoked by CI (unreachable-test-script-gate)`,
      );
    } else if (!entry.reason || entry.reason.trim() === '') {
      violations.push(
        `Allow-list entry for '${entry.script}' requires a non-empty reason (unreachable-test-script-gate)`,
      );
    } else {
      allowListed.push(entry.script);
    }
  }

  for (const name of checkedScripts) {
    if (reachableSet.has(name)) {
      // reachable
    } else if (allowListByName.has(name)) {
      // handled in allow-list evaluation
    } else {
      violations.push(
        `Script '${name}' is not reachable from any CI workflow (unreachable-test-script-gate)`,
      );
    }
  }

  return {
    checkedScripts,
    reachable,
    allowListed,
    violations,
  };
}

const DISPOSABLE_SUITE_SCRIPT = 'scripts/run-disposable-database-suite.sh';

/**
 * The reachability graph above proves a `test:*` script is invoked by CI. It says
 * nothing about whether the ARGUMENT that script hands to
 * run-disposable-database-suite.sh survives that script's own allow-list, which
 * exits 64 on an unknown spec. A suite could therefore be wired into CI, run on
 * every push, and never execute a single test. This closes that gap in both
 * directions: an argument missing from the allow-list, and an allow-list entry no
 * script passes any more.
 */
export function analyzeDisposableSuiteAllowlist(scripts, suiteSource) {
  const violations = [];
  const invoked = new Map();

  for (const [name, body] of Object.entries(scripts || {})) {
    const escaped = escapeRegex(DISPOSABLE_SUITE_SCRIPT);
    const regex = new RegExp(`${escaped}\\s+(\\S+)`, 'g');
    for (const match of String(body || '').matchAll(regex)) {
      invoked.set(match[1], name);
    }
  }

  const allowed = new Set();
  for (const match of String(suiteSource || '').matchAll(
    /^\s{2}(\S+\.integration-spec\.ts)\)\s*;;/gm,
  )) {
    allowed.add(match[1]);
  }

  for (const [spec, script] of invoked) {
    if (!allowed.has(spec)) {
      violations.push(
        `Script '${script}' passes '${spec}' to ${DISPOSABLE_SUITE_SCRIPT}, which is not in that script's allow-list and would exit 64 without running any test (disposable-suite-allowlist-gate)`,
      );
    }
  }

  for (const spec of allowed) {
    if (!invoked.has(spec)) {
      violations.push(
        `Allow-list entry '${spec}' in ${DISPOSABLE_SUITE_SCRIPT} is stale: no package.json script passes it (disposable-suite-allowlist-gate)`,
      );
    }
  }

  return { invoked: [...invoked.keys()], allowed: [...allowed], violations };
}

export function collectDisposableSuiteSource(root) {
  try {
    return readFileSync(resolve(root, DISPOSABLE_SUITE_SCRIPT), 'utf8');
  } catch {
    return '';
  }
}

export function collectPackageScripts(root) {
  const pkgPath = resolve(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  return pkg.scripts || {};
}

export function collectWorkflowSources(root) {
  const workflowsDir = resolve(root, '.github/workflows');
  let entries = [];
  try {
    entries = readdirSync(workflowsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sources = [];
  for (const entry of entries) {
    if (
      entry.isFile() &&
      (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml'))
    ) {
      const fullPath = join(workflowsDir, entry.name);
      sources.push({
        path: relative(root, fullPath).replace(/\\/g, '/'),
        source: readFileSync(fullPath, 'utf8'),
      });
    }
  }
  return sources;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const root = resolve(import.meta.dirname, '..');
  const scripts = collectPackageScripts(root);
  const workflowSources = collectWorkflowSources(root);

  const { checkedScripts, allowListed, violations } =
    analyzeTestScriptReachability(scripts, workflowSources, COVERAGE_ALLOWLIST);

  const suite = analyzeDisposableSuiteAllowlist(
    scripts,
    collectDisposableSuiteSource(root),
  );
  const shardViolations = analyzeIntegrationShardAssignments(
    scripts,
    workflowSources.find(({ path }) => path === '.github/workflows/ci.yml')
      ?.source ?? '',
  );
  const allViolations = [
    ...violations,
    ...suite.violations,
    ...shardViolations,
  ];

  if (allViolations.length > 0) {
    throw new Error(
      `Unreachable test scripts found:\n${allViolations.map((v) => `  - ${v}`).join('\n')}`,
    );
  }

  process.stdout.write(
    `Test script reachability verified: ${checkedScripts.length} test scripts checked, ${allowListed.length} allow-listed, ${suite.invoked.length} disposable-suite specs allow-listed.\n`,
  );
}
