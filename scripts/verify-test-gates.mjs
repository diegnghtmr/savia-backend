import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const GATE_ROOT_NAMES = new Set(['it', 'test', 'describe', 'suite']);
const GATE_METHOD_NAMES = new Set(['skipIf', 'runIf']);

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasSetter(variable, setterSources) {
  const setterRegex = new RegExp(
    `(^|[^A-Z0-9_])${escapeRegex(variable)}\\s*[:=]`,
    'm',
  );
  return setterSources.some((s) => setterRegex.test(s.source));
}

function isProcessEnv(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'env'
  );
}

function extractDirectEnvReads(node) {
  const envVars = new Set();

  function visit(n) {
    if (
      ts.isPropertyAccessExpression(n) &&
      isProcessEnv(n.expression) &&
      ts.isIdentifier(n.name)
    ) {
      envVars.add(n.name.text);
    } else if (
      ts.isElementAccessExpression(n) &&
      isProcessEnv(n.expression) &&
      n.argumentExpression &&
      ts.isStringLiteral(n.argumentExpression)
    ) {
      envVars.add(n.argumentExpression.text);
    } else if (
      ts.isVariableDeclaration(n) &&
      n.initializer &&
      isProcessEnv(n.initializer) &&
      ts.isObjectBindingPattern(n.name)
    ) {
      for (const element of n.name.elements) {
        if (ts.isBindingElement(element)) {
          if (element.propertyName && ts.isIdentifier(element.propertyName)) {
            envVars.add(element.propertyName.text);
          } else if (ts.isIdentifier(element.name)) {
            envVars.add(element.name.text);
          }
        }
      }
    }

    ts.forEachChild(n, visit);
  }

  visit(node);
  return Array.from(envVars);
}

function buildTopLevelEnvMap(sourceFile) {
  const map = new Map();

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (decl.initializer) {
          const directEnv = extractDirectEnvReads(decl.initializer);
          if (ts.isIdentifier(decl.name)) {
            if (directEnv.length > 0) {
              map.set(decl.name.text, directEnv);
            }
          } else if (ts.isObjectBindingPattern(decl.name)) {
            if (isProcessEnv(decl.initializer)) {
              for (const element of decl.name.elements) {
                if (ts.isBindingElement(element)) {
                  const envName =
                    element.propertyName &&
                    ts.isIdentifier(element.propertyName)
                      ? element.propertyName.text
                      : ts.isIdentifier(element.name)
                        ? element.name.text
                        : null;
                  const localName = ts.isIdentifier(element.name)
                    ? element.name.text
                    : null;
                  if (envName && localName) {
                    map.set(localName, [envName]);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return map;
}

function getRootIdentifier(node) {
  let current = node;
  while (current) {
    if (ts.isIdentifier(current)) {
      return current.text;
    }
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
    } else if (ts.isCallExpression(current)) {
      current = current.expression;
    } else if (ts.isElementAccessExpression(current)) {
      current = current.expression;
    } else {
      break;
    }
  }
  return null;
}

function collectEnvVarsInExpression(expr, topLevelEnvMap) {
  const vars = new Set();

  function visit(node) {
    if (
      ts.isPropertyAccessExpression(node) &&
      isProcessEnv(node.expression) &&
      ts.isIdentifier(node.name)
    ) {
      vars.add(node.name.text);
    } else if (
      ts.isElementAccessExpression(node) &&
      isProcessEnv(node.expression) &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      vars.add(node.argumentExpression.text);
    } else if (ts.isIdentifier(node)) {
      const mapped = topLevelEnvMap.get(node.text);
      if (mapped) {
        for (const v of mapped) {
          vars.add(v);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(expr);
  return Array.from(vars);
}

export function analyzeTestGates(testSources, setterSources) {
  const gates = [];
  const violations = [];

  for (const { path, source } of testSources) {
    const sourceFile = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const topLevelEnvMap = buildTopLevelEnvMap(sourceFile);

    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const memberName = node.expression.name.text;
        if (GATE_METHOD_NAMES.has(memberName)) {
          const rootName = getRootIdentifier(node.expression.expression);
          if (rootName && GATE_ROOT_NAMES.has(rootName)) {
            const envVars = new Set();
            for (const arg of node.arguments) {
              const varsInArg = collectEnvVarsInExpression(arg, topLevelEnvMap);
              for (const v of varsInArg) {
                envVars.add(v);
              }
            }

            const variables = Array.from(envVars);
            if (variables.length > 0) {
              const { line } = sourceFile.getLineAndCharacterOfPosition(
                node.getStart(sourceFile),
              );
              const callee = node.expression.getText(sourceFile);
              gates.push({
                path,
                line: line + 1,
                callee,
                variables,
              });

              for (const variable of variables) {
                const isSet = hasSetter(variable, setterSources);
                if (!isSet) {
                  violations.push(
                    `${path}:${line + 1}: ${callee} gated on un-set env variable ${variable} (dead-test-gate)`,
                  );
                }
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return { gates, violations };
}

function collectTestFiles(dir, collected = []) {
  if (!dir) return collected;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return collected;
  }

  for (const entry of entries) {
    if (['.git', 'node_modules', 'dist', 'fixtures'].includes(entry.name)) {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (fullPath.includes('test/architecture/fixtures')) {
      continue;
    }
    if (entry.isDirectory()) {
      collectTestFiles(fullPath, collected);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      collected.push(fullPath);
    }
  }
  return collected;
}

export function collectTestSources(root) {
  const testDir = resolve(root, 'test');
  const files = collectTestFiles(testDir);
  return files.map((file) => ({
    path: relative(root, file).replace(/\\/g, '/'),
    source: readFileSync(file, 'utf8'),
  }));
}

function collectFilesRecursively(dir, extensions, collected = []) {
  if (!dir) return collected;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return collected;
  }

  for (const entry of entries) {
    if (['.git', 'node_modules', 'dist'].includes(entry.name)) {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursively(fullPath, extensions, collected);
    } else if (
      entry.isFile() &&
      extensions.some((ext) => entry.name.endsWith(ext))
    ) {
      collected.push(fullPath);
    }
  }
  return collected;
}

export function collectSetterSources(root) {
  const filePaths = [];

  const pkgPath = resolve(root, 'package.json');
  if (existsSync(pkgPath)) filePaths.push(pkgPath);

  const workflowsDir = resolve(root, '.github/workflows');
  if (existsSync(workflowsDir)) {
    collectFilesRecursively(workflowsDir, ['.yml', '.yaml'], filePaths);
  }

  const scriptsDir = resolve(root, 'scripts');
  if (existsSync(scriptsDir)) {
    collectFilesRecursively(scriptsDir, ['.mjs', '.sh'], filePaths);
  }

  const vitestConfig = resolve(root, 'vitest.config.ts');
  if (existsSync(vitestConfig)) filePaths.push(vitestConfig);

  const vitestIntegrationConfig = resolve(root, 'vitest.integration.config.ts');
  if (existsSync(vitestIntegrationConfig))
    filePaths.push(vitestIntegrationConfig);

  return filePaths.map((file) => ({
    path: relative(root, file).replace(/\\/g, '/'),
    source: readFileSync(file, 'utf8'),
  }));
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const root = resolve(import.meta.dirname, '..');
  const testSources = collectTestSources(root);
  const setterSources = collectSetterSources(root);

  const { gates, violations } = analyzeTestGates(testSources, setterSources);
  if (violations.length > 0) {
    throw new Error(
      `Dead test gates found:\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    );
  }

  const noun = gates.length === 1 ? 'skip' : 'skips';
  process.stdout.write(
    `Test gate wiring verified: ${gates.length} env-gated ${noun}, all variables set.\n`,
  );
}
