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

  // Directly invoked scripts from workflows
  const directlyInvoked = new Set();
  for (const name of allScriptNames) {
    const isDirect = cleanWorkflowSources.some((wf) =>
      matchScriptInvocation(wf.source, name),
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

  if (violations.length > 0) {
    throw new Error(
      `Unreachable test scripts found:\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    );
  }

  process.stdout.write(
    `Test script reachability verified: ${checkedScripts.length} test scripts checked, ${allowListed.length} allow-listed.\n`,
  );
}
