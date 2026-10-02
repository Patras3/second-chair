import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { probe } from '../lib/daemon.mjs';

const run = promisify(execFile);
const BIN = new URL('../bin/second-chair', import.meta.url).pathname;

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test('start runs the server in the background once, and stop ends it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const port = await freePort();
  const env = { ...process.env, SECOND_CHAIR_HOME: root, SECOND_CHAIR_PORT: String(port) };
  try {
    const first = await run(process.execPath, [BIN, 'start'], { env });
    assert.match(first.stdout, /started/);
    assert.equal(await probe(port), true);
    const second = await run(process.execPath, [BIN, 'start', '--quiet'], { env });
    assert.equal(second.stdout, '', 'a running server makes --quiet silent');
    const pid = Number(await readFile(join(root, 'server.pid'), 'utf8'));
    assert.ok(pid > 0);
    await run(process.execPath, [BIN, 'stop'], { env });
    assert.equal(await probe(port), false);
  } finally {
    await run(process.execPath, [BIN, 'stop'], { env }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('start reports a port taken by something else instead of hanging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const blocker = createServer((c) => {
    c.on('error', () => {}); // the probe may hang up early; that is not a test failure
    c.end('HTTP/1.1 200 OK\r\n\r\nnot us');
  });
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const env = { ...process.env, SECOND_CHAIR_HOME: root, SECOND_CHAIR_PORT: String(blocker.address().port) };
  try {
    const r = await run(process.execPath, [BIN, 'start'], { env }).catch((e) => e);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /port \d+ is in use by another program/);
  } finally {
    blocker.close();
    await run(process.execPath, [BIN, 'stop'], { env }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor lists each check with ok or a fix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const env = { ...process.env, SECOND_CHAIR_HOME: root, SECOND_CHAIR_PORT: String(await freePort()) };
  try {
    const r = await run(process.execPath, [BIN, 'doctor'], { env }).catch((e) => e);
    assert.match(r.stdout, /node .* ok/);
    assert.match(r.stdout, /server .* not running.*second-chair start/);
    assert.match(r.stdout, /userscript .*http:\/\/127\.0\.0\.1:\d+\/second-chair\.user\.js/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
