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

  // Directly invoked scripts from workflows
  const directlyInvoked = new Set();
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
  const allViolations = [...violations, ...suite.violations];

  if (allViolations.length > 0) {
    throw new Error(
      `Unreachable test scripts found:\n${allViolations.map((v) => `  - ${v}`).join('\n')}`,
    );
  }

  process.stdout.write(
    `Test script reachability verified: ${checkedScripts.length} test scripts checked, ${allowListed.length} allow-listed, ${suite.invoked.length} disposable-suite specs allow-listed.\n`,
  );
}
