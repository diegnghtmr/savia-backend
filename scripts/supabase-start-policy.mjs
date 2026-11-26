import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const publishedPorts = new Map([
  ['api', ['port']],
  ['db', ['port']],
  ['db.pooler', ['port']],
  ['studio', ['port']],
  ['local_smtp', ['port', 'smtp_port', 'pop3_port']],
  ['inbucket', ['port', 'smtp_port', 'pop3_port']],
  ['analytics', ['port']],
]);

// Read the bare tables and integer ports used by our config. The shadow DB,
// outbound SMTP, and the functions-serve inspector aren't published by start.
export function extractHostPorts(config) {
  const sections = [];
  let section;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.split('#', 1)[0].trim();
    if (line.startsWith('[')) {
      const keys = publishedPorts.get(line.slice(1, -1).trim());
      section = keys ? { keys, enabled: true, ports: [] } : undefined;
      if (section) sections.push(section);
      continue;
    }
    if (!section) continue;
    const assignment = /^(\w+)\s*=\s*(\S+)$/.exec(line);
    if (!assignment) continue;
    const [, key, value] = assignment;
    if (key === 'enabled') section.enabled = value !== 'false';
    if (!section.keys.includes(key) || !/^\d(?:_?\d)*$/.test(value)) continue;
    const port = Number(value.replaceAll('_', ''));
    if (port > 0 && port <= 65535) section.ports.push(port);
  }
  const ports = sections.flatMap((s) => (s.enabled ? s.ports : []));
  return [...new Set(ports)];
}

// Docker's connectivity wrapper is generic; the underlying bind error must
// identify a port conflict, not a firewall or another networking failure.
const portAllocationError = /address already in use|port is already allocated/i;

export function shouldRetryStart(log, attempt) {
  return attempt === 1 && portAllocationError.test(log);
}

function canBind(port, host) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen({ host, port }, () => server.close(() => resolve(true)));
  });
}

async function portIsFree(port) {
  try {
    // Check both address families with a dual-stack wildcard, just as a Docker
    // publish with no host IP can use either family.
    return await canBind(port, '::');
  } catch (error) {
    if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) throw error;
    return canBind(port, '0.0.0.0');
  }
}

export async function waitForHostPorts(ports, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const free = await Promise.all(ports.map(portIsFree));
    const busy = ports.filter((_, index) => !free[index]);
    if (busy.length === 0) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new Error(
        `Supabase port wait failed: host ports still in use: ${busy.join(', ')}`,
      );
    }
    await setTimeout(Math.min(200, remaining));
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  const [, , action, path, attempt] = process.argv;
  if (action === 'wait') {
    try {
      const ports = extractHostPorts(readFileSync(path, 'utf8'));
      if (ports.length === 0) {
        throw new Error('No published ports in the config');
      }
      await waitForHostPorts(ports);
    } catch (error) {
      process.stderr.write(`Supabase preflight failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  } else if (action === 'should-retry') {
    const log = readFileSync(path, 'utf8');
    process.exitCode = shouldRetryStart(log, Number(attempt)) ? 0 : 1;
  } else {
    process.exitCode = 64;
  }
}
