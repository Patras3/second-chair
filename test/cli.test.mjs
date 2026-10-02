import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { health, isOlder, probe, start, stop } from '../lib/daemon.mjs';
import { buildPayload } from '../lib/payload.mjs';
import { draftArgs } from '../lib/cli.mjs';
import { startServer } from '../lib/server.mjs';

const run = promisify(execFile);
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const BIN = fileURLToPath(new URL('../bin/second-chair', import.meta.url));

// On Windows a killed server can hold server.log open a moment longer, so the cleanup retries.
const cleanup = (root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, what) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

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
    await cleanup(root);
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
    await cleanup(root);
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
    await cleanup(root);
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
    await cleanup(root);
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
    await cleanup(root);
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
    assert.deepEqual(health, { ok: true, tool: 'second-chair', pid: process.pid, version: VERSION });
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
    await cleanup(root);
  }
});

test('a file that cannot be read or parsed fails with its name and the reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const env = { ...process.env, SECOND_CHAIR_HOME: root, SECOND_CHAIR_PORT: String(await freePort()) };
  const bad = join(root, 'bad.json');
  const missing = join(root, 'missing.json');
  await writeFile(bad, '{ not json');
  try {
    for (const args of [
      ['build', '--repo', 'o/n', '--pr', '1', '--round', '1', '--head', 'h', missing],
      ['build', '--repo', 'o/n', '--pr', '1', '--round', '1', '--head', 'h', bad],
      ['push', bad],
      ['put-decisions', missing],
      ['draft', '3', missing],
      ['draft', '3', '--body-file', missing],
    ]) {
      const r = await run(process.execPath, [BIN, ...args], { env }).catch((e) => e);
      assert.equal(r.code, 1, args.join(' '));
      const file = args.includes(bad) ? bad : missing;
      assert.ok(r.stderr.startsWith(`second-chair: cannot read ${file}: `), `${args.join(' ')}: ${r.stderr}`);
    }
  } finally {
    await cleanup(root);
  }
});

test('put-decisions hands pasted decisions to the server, and shows why the server refuses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const port = await freePort();
  const env = { ...process.env, SECOND_CHAIR_HOME: root, SECOND_CHAIR_PORT: String(port) };
  const server = await startServer({ port, root, log: () => {} });
  const H = { 'Content-Type': 'application/json', 'X-Second-Chair': '1' };
  try {
    const proposals = { tool: 'second-chair', kind: 'proposals', repo: 'octo-org/example', pr: 5, round: 2, head: 'h2', items: [{ thread_id: 'T1', comment_id: 11, verdict: 'publish', reply_en: 'Done in `abc`.' }] };
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/proposals`, { method: 'PUT', headers: H, body: JSON.stringify(proposals) })).status, 200);
    const decisions = { tool: 'second-chair', kind: 'decisions', mode: 'reply', repo: 'octo-org/example', pr: 5, round: 2, head: 'h2', exported_at: 'now', decisions: [{ thread_id: 'T1', comment_id: 11, proposed: 'publish', decision: 'publish', auto: false, reply_en: 'Done in `abc`.', reply_edited: false, note: '' }] };
    const file = join(root, 'decisions.json');
    await writeFile(file, JSON.stringify(decisions, null, 2));
    const ok = await run(process.execPath, [BIN, 'put-decisions', file], { env });
    assert.match(ok.stdout, /saved 1 decision for octo-org\/example#5 round 2/);
    const got = await run(process.execPath, [BIN, 'get', '--repo', 'octo-org/example', '--pr', '5', '--round', '2'], { env });
    assert.equal(JSON.parse(got.stdout).decisions[0].reply_en, 'Done in `abc`.');

    await writeFile(file, JSON.stringify({ ...decisions, head: 'old' }));
    const refused = await run(process.execPath, [BIN, 'put-decisions', file], { env }).catch((e) => e);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /the server refused these decisions: these decisions answer an older head; reload the proposals/);
    assert.equal((await run(process.execPath, [BIN, 'put-decisions'], { env }).catch((e) => e)).code, 1, 'no file');
  } finally {
    server.close();
    await cleanup(root);
  }
});

test('several sessions starting at once leave one server, and its own pid in the pid file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const port = await freePort();
  const env = { ...process.env, SECOND_CHAIR_HOME: root, SECOND_CHAIR_PORT: String(port) };
  try {
    const runs = await Promise.all([1, 2, 3, 4].map(() => run(process.execPath, [BIN, 'start', '--quiet'], { env }).catch((e) => e)));
    for (const r of runs) assert.ok(!(r instanceof Error), `every start exits 0: ${r.stderr ?? ''}`);
    const h = await health(port);
    assert.ok(h, 'a server answers');
    assert.equal(Number(await readFile(join(root, 'server.pid'), 'utf8')), h.pid);
    assert.equal(runs.filter((r) => /started/.test(r.stdout)).length, 1, 'only one start says it started the server');
    const stopped = await run(process.execPath, [BIN, 'stop'], { env });
    assert.match(stopped.stdout, /server stopped/);
    assert.equal(await probe(port), false);
  } finally {
    // When the test fails, the pid file may name the wrong process, so end the server by its own pid.
    const left = await health(port);
    if (left && left.pid !== process.pid) process.kill(left.pid);
    await cleanup(root);
  }
});

test('the server removes its pid file when it is told to stop', { skip: process.platform === 'win32' && 'Windows ends a process without running its signal handlers' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const port = await freePort();
  const pidFile = join(root, 'server.pid');
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port), '--pid-file', pidFile], { env: { ...process.env, SECOND_CHAIR_HOME: root }, stdio: 'ignore' });
    const exited = new Promise((r) => child.once('exit', r));
    try {
      await until(() => probe(port), 'the server');
      assert.equal(Number(await readFile(pidFile, 'utf8')), child.pid);
      child.kill(signal);
      await exited;
      assert.equal(await readFile(pidFile, 'utf8').catch(() => 'gone'), 'gone', signal);
    } finally {
      child.kill();
    }
  }
  await cleanup(root);
});

test('start removes a pid file that does not belong to the server on the port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const port = await freePort();
  const env = { ...process.env, SECOND_CHAIR_HOME: root, SECOND_CHAIR_PORT: String(port) };
  const other = await startServer({ port, root, log: () => {} });
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  try {
    await writeFile(join(root, 'server.pid'), String(bystander.pid));
    await run(process.execPath, [BIN, 'start', '--quiet'], { env });
    assert.equal(await readFile(join(root, 'server.pid'), 'utf8').catch(() => 'gone'), 'gone');
    assert.equal(bystander.exitCode, null);
    assert.equal(await probe(port), true, 'the other server still runs');
  } finally {
    bystander.kill();
    other.close();
    await cleanup(root);
  }
});

/** A server of another version in its own process, as another copy of the plugin left it running. */
async function otherServer({ port, root, pidFile, version = '0.9.0' }) {
  const server = new URL('../lib/server.mjs', import.meta.url).href;
  const opts = JSON.stringify({ port, root, version, ...(pidFile ? { pidFile } : {}) });
  const child = spawn(process.execPath, ['-e', `import(${JSON.stringify(server)}).then((m) => m.startServer({ ...${opts}, log: () => {} }))`], { stdio: 'ignore' });
  const exited = new Promise((r) => child.once('exit', r));
  await until(async () => (await health(port))?.version === version, 'the older server').catch((e) => {
    child.kill();
    throw e;
  });
  return { child, exited };
}

test('start reuses a server of the same version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const port = await freePort();
  const env = { ...process.env, SECOND_CHAIR_HOME: root, SECOND_CHAIR_PORT: String(port) };
  try {
    await run(process.execPath, [BIN, 'start'], { env });
    const before = await health(port);
    assert.equal(before.version, VERSION);
    const again = await run(process.execPath, [BIN, 'start', '--quiet'], { env });
    assert.equal(again.stdout, '');
    assert.equal((await health(port)).pid, before.pid);
    const doctor = await run(process.execPath, [BIN, 'doctor'], { env }).catch((e) => e);
    assert.match(doctor.stdout, new RegExp(`server +http://127\\.0\\.0\\.1:${port} ok, version ${VERSION.replace(/\./g, '\\.')}`));
  } finally {
    await run(process.execPath, [BIN, 'stop'], { env }).catch(() => {});
    await cleanup(root);
  }
});

test('start restarts a server of another version that start launched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const port = await freePort();
  const env = { ...process.env, SECOND_CHAIR_HOME: root, SECOND_CHAIR_PORT: String(port) };
  const old = await otherServer({ port, root, pidFile: join(root, 'server.pid') });
  try {
    const doctor = await run(process.execPath, [BIN, 'doctor'], { env }).catch((e) => e);
    assert.equal(doctor.code, 1);
    assert.match(doctor.stdout, new RegExp(`server +http://127\\.0\\.0\\.1:${port} runs version 0\\.9\\.0, but this is ${VERSION.replace(/\./g, '\\.')}; run: second-chair start`));
    const r = await run(process.execPath, [BIN, 'start', '--quiet'], { env });
    assert.equal(r.stdout, `second-chair: restarted the server (was 0.9.0, now ${VERSION})\n`);
    await old.exited;
    const h = await health(port);
    assert.equal(h.version, VERSION);
    assert.equal(Number(await readFile(join(root, 'server.pid'), 'utf8')), h.pid);
  } finally {
    old.child.kill();
    await run(process.execPath, [BIN, 'stop'], { env }).catch(() => {});
    await cleanup(root);
  }
});

test('start waits for a port that the stopped server frees late, as on Windows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const port = await freePort();
  const old = await otherServer({ port, root, pidFile: join(root, 'server.pid') });
  let calls = 0;
  const taken = async () => ++calls <= 2;
  try {
    const r = await start({ port, root, bin: BIN, taken });
    assert.deepEqual(r.restarted, { was: '0.9.0', now: VERSION });
    assert.equal(calls, 3, 'the port was checked until it was free');
  } finally {
    old.child.kill();
    await run(process.execPath, [BIN, 'stop'], { env: { ...process.env, SECOND_CHAIR_HOME: root, SECOND_CHAIR_PORT: String(port) } }).catch(() => {});
    await cleanup(root);
  }
});

test('start says another program holds the port when a restart never frees it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const port = await freePort();
  const old = await otherServer({ port, root, pidFile: join(root, 'server.pid') });
  try {
    await assert.rejects(start({ port, root, bin: BIN, taken: async () => true, portWait: 300 }), /in use by another program/);
  } finally {
    old.child.kill();
    await cleanup(root);
  }
});

test('start warns and exits 0 when a server of another version cannot be stopped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const port = await freePort();
  const env = { ...process.env, SECOND_CHAIR_HOME: root, SECOND_CHAIR_PORT: String(port) };
  const old = await otherServer({ port, root });
  try {
    const r = await run(process.execPath, [BIN, 'start', '--quiet'], { env });
    assert.equal(r.stdout.split('\n').filter(Boolean).length, 1, r.stdout);
    assert.match(r.stdout, new RegExp(`^second-chair: the server on http://127\\.0\\.0\\.1:${port} runs version 0\\.9\\.0, but this is ${VERSION.replace(/\./g, '\\.')}\\. Stop that server by hand, then run second-chair start again\\.\\n$`));
    assert.equal(old.child.exitCode, null, 'the older server still runs');
    assert.equal((await health(port)).version, '0.9.0');
    const doctor = await run(process.execPath, [BIN, 'doctor'], { env }).catch((e) => e);
    assert.equal(doctor.code, 1);
    assert.match(doctor.stdout, new RegExp(`server +http://127\\.0\\.0\\.1:${port} runs version 0\\.9\\.0, but this is ${VERSION.replace(/\./g, '\\.')}; stop it by hand \\(pid ${old.child.pid}\\)`));
  } finally {
    old.child.kill();
    await cleanup(root);
  }
});

test('several sessions restarting a server of another version at once print no false warning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const port = await freePort();
  const env = { ...process.env, SECOND_CHAIR_HOME: root, SECOND_CHAIR_PORT: String(port) };
  const old = await otherServer({ port, root, pidFile: join(root, 'server.pid') });
  try {
    const runs = await Promise.all([1, 2, 3].map(() => run(process.execPath, [BIN, 'start', '--quiet'], { env }).catch((e) => e)));
    for (const r of runs) {
      assert.ok(!(r instanceof Error), `every start exits 0: ${r.stderr ?? ''}`);
      assert.doesNotMatch(r.stdout, /by hand/);
    }
    await old.exited;
    const h = await health(port);
    assert.equal(h.version, VERSION);
    assert.equal(Number(await readFile(join(root, 'server.pid'), 'utf8')), h.pid);
  } finally {
    old.child.kill();
    const left = await health(port);
    if (left && left.pid !== process.pid) process.kill(left.pid);
    await cleanup(root);
  }
});

/** A server from before /health had a version: it answers with its pid only, and writes the pid file. */
async function versionlessServer({ port, pidFile }) {
  const code = `const fs = require('fs');
require('http').createServer((q, s) => { s.setHeader('Content-Type', 'application/json'); s.end(JSON.stringify({ ok: true, tool: 'second-chair', pid: process.pid })); })
  .listen(${port}, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)));`;
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
  const exited = new Promise((r) => child.once('exit', r));
  await until(async () => (await health(port))?.pid === child.pid, 'the server without a version').catch((e) => {
    child.kill();
    throw e;
  });
  return { child, exited };
}

test('start restarts a server that reports no version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const port = await freePort();
  const env = { ...process.env, SECOND_CHAIR_HOME: root, SECOND_CHAIR_PORT: String(port) };
  const old = await versionlessServer({ port, pidFile: join(root, 'server.pid') });
  try {
    const r = await run(process.execPath, [BIN, 'start', '--quiet'], { env });
    assert.equal(r.stdout, `second-chair: restarted the server (was unknown, now ${VERSION})\n`);
    await old.exited;
    assert.equal((await health(port)).version, VERSION);
  } finally {
    old.child.kill();
    await run(process.execPath, [BIN, 'stop'], { env }).catch(() => {});
    await cleanup(root);
  }
});

test('start keeps a newer server, and doctor says this copy is older', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const port = await freePort();
  const env = { ...process.env, SECOND_CHAIR_HOME: root, SECOND_CHAIR_PORT: String(port) };
  const newer = await otherServer({ port, root, pidFile: join(root, 'server.pid'), version: '99.0.0' });
  try {
    const r = await run(process.execPath, [BIN, 'start', '--quiet'], { env });
    assert.equal(r.stdout, '');
    assert.equal(newer.child.exitCode, null, 'the newer server still runs');
    assert.equal((await health(port)).pid, newer.child.pid);
    const doctor = await run(process.execPath, [BIN, 'doctor'], { env }).catch((e) => e);
    assert.equal(doctor.code, 1);
    assert.match(doctor.stdout, new RegExp(`server +this copy \\(${VERSION.replace(/\./g, '\\.')}\\) is older than the running server \\(99\\.0\\.0\\); update it`));
  } finally {
    newer.child.kill();
    const left = await health(port);
    if (left && left.pid !== process.pid && left.pid !== newer.child.pid) process.kill(left.pid);
    await cleanup(root);
  }
});

test('stop signals nothing when the server on the port is not the one the caller expects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const port = await freePort();
  const pidFile = join(root, 'server.pid');
  // Another session already restarted the server: the pid file and /health agree, but on a pid this caller never saw.
  const fresh = await otherServer({ port, root, pidFile, version: VERSION });
  try {
    assert.equal(await stop({ root, port, expect: fresh.child.pid + 100000 }), 'moved');
    assert.equal(fresh.child.exitCode, null, 'the fresh server still runs');
    assert.equal(Number(await readFile(pidFile, 'utf8')), fresh.child.pid, 'its pid file stays');
  } finally {
    fresh.child.kill();
    await cleanup(root);
  }
});

test('wait keeps waiting while the server restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc-cli-'));
  const port = await freePort();
  const env = { ...process.env, SECOND_CHAIR_HOME: root, SECOND_CHAIR_PORT: String(port) };
  const H = { 'Content-Type': 'application/json', 'X-Second-Chair': '1' };
  const proposals = { tool: 'second-chair', kind: 'proposals', repo: 'octo-org/example', pr: 5, round: 1, head: 'h1', items: [{ thread_id: 'T1', comment_id: 11, verdict: 'fix', reply_en: 'Will do.' }] };
  const decisions = { tool: 'second-chair', kind: 'decisions', repo: 'octo-org/example', pr: 5, round: 1, head: 'h1', decisions: [{ thread_id: 'T1', decision: 'fix' }] };
  let server = await startServer({ port, root, log: () => {} });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/proposals`, { method: 'PUT', headers: H, body: JSON.stringify(proposals) })).status, 200);
    const waiting = run(process.execPath, [BIN, 'wait', '--repo', 'octo-org/example', '--pr', '5', '--round', '1', '--timeout', '60'], { env });
    await sleep(500);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await sleep(3000);
    server = await startServer({ port, root, log: () => {} });
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/decisions`, { method: 'POST', headers: H, body: JSON.stringify(decisions) })).status, 200);
    const r = await waiting;
    assert.equal(JSON.parse(r.stdout).decisions[0].decision, 'fix');
  } finally {
    server.close();
    await cleanup(root);
  }
});

test('isOlder compares versions, and a missing version counts as older', () => {
  assert.equal(isOlder('0.9.0', '1.0.0'), true);
  assert.equal(isOlder('1.0.0', '1.0.10'), true);
  assert.equal(isOlder('1.10.0', '1.9.0'), false);
  assert.equal(isOlder('1.0.0', '1.0.0'), false);
  assert.equal(isOlder('2.0.0', '1.0.0'), false);
  assert.equal(isOlder(undefined, '1.0.0'), true);
  assert.equal(isOlder('garbage', '1.0.0'), true);
});
