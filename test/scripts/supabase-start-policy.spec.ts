import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  extractHostPorts,
  shouldRetryStart,
  waitForHostPorts,
} from '../../scripts/supabase-start-policy.mjs';

it('reads all five published ports from the checked-in stack config', () => {
  const config = readFileSync('supabase/config.toml', 'utf8');
  expect(extractHostPorts(config)).toEqual([54321, 54322, 54323, 54324, 54327]);
});

it('reads overrides and optional published ports, but not disabled or internal ports', () => {
  expect(
    extractHostPorts(`
[api]
  port = 55001 # gateway
[db]
  port = 55002
  shadow_port = 55020
[db.pooler]
  enabled = true
  port = 55_003
[studio]
  port = 55004
  enabled = false # not published
[local_smtp]
  port = 55005
  smtp_port = 55006
  pop3_port = 55007
[analytics]
  port = 55001 # only probe each port once
[auth.email.smtp]
  port = 587 # remote server, not published here
[edge_runtime]
  inspector_port = 8083 # only used when serving with an inspect mode
`),
  ).toEqual([55001, 55002, 55003, 55005, 55006, 55007]);
});

it.each([
  'bind tcp 0.0.0.0:54324: address already in use',
  'failed to bind host port: Port is already allocated',
  'driver failed programming external connectivity on endpoint',
])('retries only the first failure for %s', (message) => {
  expect(shouldRetryStart(message, 1)).toBe(true);
  expect(shouldRetryStart(message, 2)).toBe(false);
});

it('does not retry a migration failure', () => {
  const log = 'ERROR: migration failed (SQLSTATE 42P01)';
  expect(shouldRetryStart(log, 1)).toBe(false);
});

async function occupyPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (typeof address === 'object' && address) resolve(address.port);
      else reject(new Error('Expected a TCP address'));
    });
  });
}

async function releasePort(server: Server): Promise<void> {
  if (server.listening) {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

it('waits for all advertised ports to be released', async () => {
  const first = createServer();
  const second = createServer();
  try {
    const ports = await Promise.all([occupyPort(first), occupyPort(second)]);
    const release = async () => {
      await setTimeout(25);
      await releasePort(first);
      await setTimeout(25);
      await releasePort(second);
    };
    await Promise.all([
      waitForHostPorts(ports, 2_000).then(() => {
        expect(first.listening).toBe(false);
        expect(second.listening).toBe(false);
      }),
      release(),
    ]);
  } finally {
    await Promise.all([releasePort(first), releasePort(second)]);
  }
});

it('fails at the deadline when a port is still occupied', async () => {
  const server = createServer();
  try {
    const port = await occupyPort(server);
    await expect(waitForHostPorts([port], 25)).rejects.toThrow(
      `Supabase port wait failed: host ports still in use: ${port}`,
    );
    expect(server.listening).toBe(true);
  } finally {
    await releasePort(server);
  }
});
