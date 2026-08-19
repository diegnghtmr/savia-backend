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

function stripHashComments(source) {
  return source
    .split('\n')
    .map((line) => {
      let inSingle = false;
      let inDouble = false;
      let escaped = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === "'" && !inDouble) {
          inSingle = !inSingle;
        } else if (char === '"' && !inSingle) {
          inDouble = !inDouble;
        } else if (char === '#' && !inSingle && !inDouble) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

function stripJsComments(source) {
  let result = '';
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const nextChar = source[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && nextChar === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      result += char;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      result += char;
      continue;
    }

    if (inSingle) {
      if (char === "'") inSingle = false;
      result += char;
      continue;
    }

    if (inDouble) {
      if (char === '"') inDouble = false;
      result += char;
      continue;
    }

    if (inTemplate) {
      if (char === '`') inTemplate = false;
      result += char;
      continue;
    }

    if (char === "'") {
      inSingle = true;
      result += char;
    } else if (char === '"') {
      inDouble = true;
      result += char;
    } else if (char === '`') {
      inTemplate = true;
      result += char;
    } else if (char === '/' && nextChar === '/') {
      inLineComment = true;
      i++;
    } else if (char === '/' && nextChar === '*') {
      inBlockComment = true;
      i++;
    } else {
      result += char;
    }
  }

  return result;
}

function stripComments(path, source) {
  const lower = (path || '').toLowerCase();
  if (
    lower.endsWith('.sh') ||
    lower.endsWith('.yml') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('makefile') ||
    lower.includes('.env') ||
    lower.includes('docker-compose') ||
    lower.includes('compose')
  ) {
    return stripHashComments(source);
  }
  if (
    lower.endsWith('.js') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs') ||
    lower.endsWith('.ts') ||
    lower.endsWith('.mts') ||
    lower.endsWith('.cts')
  ) {
    return stripJsComments(source);
  }
  return source;
}

function hasSetter(variable, setterSources) {
  const setterRegex = new RegExp(
    `(^|[^A-Z0-9_])${escapeRegex(variable)}\\s*[:=]`,
    'm',
  );
  return setterSources.some((s) => {
    const cleanSource = stripComments(s.path, s.source);
    return setterRegex.test(cleanSource);
  });
}

function isProcessEnv(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'env'
  );
}

function findEnvAliases(sourceFile) {
  const aliases = new Set();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (
          decl.initializer &&
          isProcessEnv(decl.initializer) &&
          ts.isIdentifier(decl.name)
        ) {
          aliases.add(decl.name.text);
        }
      }
    }
  }
  return aliases;
}

function isEnvObject(node, envAliases) {
  if (isProcessEnv(node)) return true;
  if (ts.isIdentifier(node) && envAliases && envAliases.has(node.text)) {
    return true;
  }
  return false;
}

function collectEnvReads(node, envAliases, topLevelEnvMap = null) {
  const envVars = new Set();

  function visit(n) {
    if (
      ts.isPropertyAccessExpression(n) &&
      isEnvObject(n.expression, envAliases) &&
      ts.isIdentifier(n.name)
    ) {
      envVars.add(n.name.text);
    } else if (
      ts.isElementAccessExpression(n) &&
      isEnvObject(n.expression, envAliases) &&
      n.argumentExpression &&
      ts.isStringLiteral(n.argumentExpression)
    ) {
      envVars.add(n.argumentExpression.text);
    } else if (topLevelEnvMap && ts.isIdentifier(n)) {
      const mapped = topLevelEnvMap.get(n.text);
      if (mapped) {
        for (const v of mapped) {
          envVars.add(v);
        }
      }
    }

    ts.forEachChild(n, visit);
  }

  visit(node);
  return Array.from(envVars);
}

function buildTopLevelEnvMap(sourceFile, envAliases) {
  const map = new Map();

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!decl.initializer) continue;

        if (ts.isIdentifier(decl.name)) {
          const directEnv = collectEnvReads(decl.initializer, envAliases);
          if (directEnv.length > 0) {
            map.set(decl.name.text, directEnv);
          }
        } else if (
          ts.isObjectBindingPattern(decl.name) &&
          isEnvObject(decl.initializer, envAliases)
        ) {
          for (const element of decl.name.elements) {
            if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
              const envName =
                element.propertyName && ts.isIdentifier(element.propertyName)
                  ? element.propertyName.text
                  : element.name.text;
              map.set(element.name.text, [envName]);
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
    const envAliases = findEnvAliases(sourceFile);
    const topLevelEnvMap = buildTopLevelEnvMap(sourceFile, envAliases);

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
              const varsInArg = collectEnvReads(
                arg,
                envAliases,
                topLevelEnvMap,
              );
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

function collectFilesRecursively(
  dir,
  extensions,
  isExcluded = null,
  collected = [],
) {
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
    if (isExcluded && isExcluded(fullPath, entry)) {
      continue;
    }
    if (entry.isDirectory()) {
      collectFilesRecursively(fullPath, extensions, isExcluded, collected);
    } else if (
      entry.isFile() &&
      extensions.some((ext) => entry.name.endsWith(ext))
    ) {
      collected.push(fullPath);
    }
  }
  return collected;
}

export function collectTestSources(root) {
  const testDir = resolve(root, 'test');
  const files = collectFilesRecursively(testDir, ['.ts'], (fullPath) =>
    fullPath.includes('test/architecture/fixtures'),
  );
  return files.map((file) => ({
    path: relative(root, file).replace(/\\/g, '/'),
    source: readFileSync(file, 'utf8'),
  }));
}

export function collectSetterSources(root) {
  const filePaths = [];

  const pkgPath = resolve(root, 'package.json');
  if (existsSync(pkgPath)) filePaths.push(pkgPath);

  const makefile = resolve(root, 'Makefile');
  if (existsSync(makefile)) filePaths.push(makefile);

  let rootEntries = [];
  try {
    rootEntries = readdirSync(root, { withFileTypes: true });
  } catch {
    // ignore
  }

  for (const entry of rootEntries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (
      name.startsWith('.env') ||
      ((name.startsWith('docker-compose') || name.startsWith('compose')) &&
        (name.endsWith('.yml') || name.endsWith('.yaml')))
    ) {
      filePaths.push(join(root, name));
    }
  }

  const workflowsDir = resolve(root, '.github/workflows');
  if (existsSync(workflowsDir)) {
    collectFilesRecursively(workflowsDir, ['.yml', '.yaml'], null, filePaths);
  }

  const scriptsDir = resolve(root, 'scripts');
  if (existsSync(scriptsDir)) {
    collectFilesRecursively(scriptsDir, ['.mjs', '.sh'], null, filePaths);
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
