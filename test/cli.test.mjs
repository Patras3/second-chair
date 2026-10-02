import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { probe } from '../lib/daemon.mjs';
import { buildPayload } from '../lib/payload.mjs';
import { draftArgs } from '../lib/cli.mjs';
import { startServer } from '../lib/server.mjs';

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

test('doctor tells a port held by another program from a stopped server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const blocker = createServer((c) => {
    c.on('error', () => {});
    c.end('HTTP/1.1 200 OK\r\n\r\nnot us');
  });
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const env = { ...process.env, SECOND_CHAIR_HOME: root, SECOND_CHAIR_PORT: String(blocker.address().port) };
  try {
    const r = await run(process.execPath, [BIN, 'doctor'], { env }).catch((e) => e);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /server .*port \d+ is in use by another program; set SECOND_CHAIR_PORT/);
    assert.doesNotMatch(r.stdout, /run: second-chair start/);
  } finally {
    blocker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('stop does not signal a stale pid file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const env = { ...process.env, SECOND_CHAIR_HOME: root, SECOND_CHAIR_PORT: String(await freePort()) };
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  try {
    await writeFile(join(root, 'server.pid'), String(bystander.pid));
    const r = await run(process.execPath, [BIN, 'stop'], { env });
    assert.match(r.stdout, /stale pid file/);
    assert.equal(bystander.exitCode, null);
    assert.equal(await readFile(join(root, 'server.pid'), 'utf8').catch(() => 'gone'), 'gone');
  } finally {
    bystander.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test('build wraps items, puts general items first and refuses bad ones', () => {
  const p = buildPayload({ repo: 'octo-org/example', pr: 3, round: 1, head: 'abc', mode: 'reply', items: [
    { thread_id: 'T1', comment_id: 1, verdict: 'fix', reply_en: 'a' },
    { thread_id: 'GLOBAL', comment_id: null, verdict: 'manual', reply_en: '' },
  ] });
  assert.deepEqual(p.items.map((i) => i.thread_id), ['GLOBAL', 'T1']);
  assert.equal(p.tool, 'second-chair');
  assert.equal(p.mode, undefined, 'reply is the default and is left out');
  assert.throws(() => buildPayload({ repo: 'o/n', pr: 1, round: 1, head: 'h', items: [{ thread_id: 'A', verdict: 'fix' }] }), /A: missing reply_en/);
  assert.throws(() => buildPayload({ repo: 'o/n', pr: 1, round: 1, head: 'h', items: [{ thread_id: 'A', verdict: 'publish', reply_en: '' }] }), /A: verdict publish is not a round 1 reply decision/);
  assert.throws(() => buildPayload({ repo: 'o/n', pr: 1, round: 1, head: 'h', items: [{ thread_id: 'A', verdict: 'fix', reply_en: '' }, { thread_id: 'A', verdict: 'fix', reply_en: '' }] }), /duplicate thread_id A/);
  const r = buildPayload({ repo: 'o/n', pr: 1, round: 1, head: 'h', mode: 'review', items: [{ thread_id: 'C', comment_id: 5, verdict: 'post', reply_en: 'x', origin: 'user', original_en: 'x' }] });
  assert.equal(r.mode, 'review');
  assert.equal(r.items[0].origin, 'user');
});

test('build refuses auto on a final-round verdict that posts', () => {
  assert.throws(() => buildPayload({ repo: 'o/n', pr: 1, round: 2, head: 'h', items: [{ thread_id: 'A', verdict: 'publish', auto: true, reply_en: 'x' }] }), /^Error: A: auto cannot be used with publish in the final round; the user must approve every posted text$/);
  assert.throws(() => buildPayload({ repo: 'o/n', pr: 1, round: 2, head: 'h', mode: 'review', items: [{ thread_id: 'C1', comment_id: 1, verdict: 'post', auto: true, reply_en: 'x' }] }), /C1: auto cannot be used with post in the final round/);
  assert.equal(buildPayload({ repo: 'o/n', pr: 1, round: 2, head: 'h', items: [{ thread_id: 'A', verdict: 'manual', auto: true, reply_en: '' }] }).items.length, 1);
});

test('draft takes a pull request and a comments file, and only a body file for a review with no comments', () => {
  assert.deepEqual(draftArgs(['42', 'c.json'], undefined), { pr: '42', file: 'c.json' });
  assert.deepEqual(draftArgs(['c.json'], undefined), { pr: undefined, file: 'c.json' });
  assert.deepEqual(draftArgs(['c.json'], 'body.md'), { pr: undefined, file: 'c.json' });
  assert.deepEqual(draftArgs(['42'], 'body.md'), { pr: '42', file: null });
  assert.deepEqual(draftArgs(['https://github.com/octo-org/example/pull/42'], 'body.md'), { pr: 'https://github.com/octo-org/example/pull/42', file: null });
  assert.deepEqual(draftArgs([], 'body.md'), { pr: undefined, file: null });
  assert.deepEqual(draftArgs([], undefined), { pr: undefined, file: null });
});

test('stop signals nothing when the server on the port is not the one start launched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const port = await freePort();
  const env = { ...process.env, SECOND_CHAIR_HOME: root, SECOND_CHAIR_PORT: String(port) };
  const other = await startServer({ port, root, log: () => {} });
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.deepEqual(health, { ok: true, tool: 'second-chair', pid: process.pid });
    await writeFile(join(root, 'server.pid'), String(bystander.pid));
    const r = await run(process.execPath, [BIN, 'stop'], { env });
    assert.match(r.stdout, /not the one second-chair start launched/);
    assert.equal(bystander.exitCode, null);
    assert.equal(bystander.signalCode, null);
    assert.equal(await probe(port), true, 'the other server still runs');
    assert.equal(await readFile(join(root, 'server.pid'), 'utf8').catch(() => 'gone'), 'gone');
  } finally {
    bystander.kill();
    other.close();
    await rm(root, { recursive: true, force: true });
  }
});
