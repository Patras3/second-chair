// Starts and stops the server as a background process that outlives the shell, the hook or the session
// that started it. spawn with detached + unref works the same on Linux, macOS and Windows.
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { TOOL, VERSION } from './protocol.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The /health answer of the Second Chair server on the port, or null when none answers. */
export async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    const body = await r.json().catch(() => null);
    return r.ok && body?.ok === true && body?.tool === TOOL ? body : null;
  } catch {
    return null;
  }
}

/** True when a Second Chair server answers /health on the port. */
export async function probe(port) {
  return Boolean(await health(port));
}

/** True when anything at all accepts a TCP connection on the port within a second. */
export function portTaken(port) {
  return new Promise((resolve) => {
    const s = createConnection({ host: '127.0.0.1', port });
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

/**
 * True when a running server's version is older than `version`. A missing or unreadable version counts as
 * older: servers from before /health reported a version have none.
 */
export function isOlder(running, version) {
  const parse = (v) => /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''))?.slice(1).map(Number);
  const a = parse(running);
  const b = parse(version);
  if (!a) return true;
  if (!b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** The pid in the pid file, or 0 when there is none. */
export async function readPid(root) {
  return Number(await readFile(join(root, 'server.pid'), 'utf8').catch(() => '')) || 0;
}

/**
 * Removes the pid file when it names a process other than the server that answers. Such a file is left over:
 * Windows ends a server without letting it remove its file, and a server that another way started has none.
 * The health check comes first: a server writes its pid file before it answers, so a file read after the
 * answer is never older than the server that gave it.
 */
async function dropStalePid(root, port) {
  const h = await health(port);
  const pid = await readPid(root);
  if (h && pid && pid !== h.pid) await rm(join(root, 'server.pid'), { force: true });
}

/**
 * Runs the server in the background, unless one of this version or a newer one already answers. The server
 * writes the pid file itself, once it listens. When several sessions start at once, each spawns a server,
 * one of them gets the port, and the others exit; the pid file then names the one that runs.
 *
 * An older server is stopped and started again, so a plugin update takes effect in the next session. When
 * it cannot be stopped, the answer has `mismatch` and nothing is changed.
 *
 * Worst case, this takes about 13 seconds: health checks of up to 0.5 s each, 2 s for the old server to go
 * down, 1 s for the port check and 6 s for the new server to answer. The session hook allows 30.
 */
export async function start({ port, root, bin, version = VERSION, budget = 6000 }) {
  const log = join(root, 'server.log');
  const running = await health(port);
  let restarted;
  if (running) {
    await dropStalePid(root, port);
    if (!isOlder(running.version, version)) return { started: false, log };
    const was = running.version ?? 'unknown';
    const state = await stop({ root, port, expect: running.pid }).catch(() => 'refused');
    // Wait even when this session stopped nothing: another session may be stopping the same server.
    const down = await waitDown(port);
    if (state !== 'stopped' || !down) {
      // Another session may have restarted it in the meantime.
      const now = await health(port);
      if (now && !isOlder(now.version, version)) return { started: false, log };
      if (now) return { started: false, log, mismatch: { was, now: version } };
    }
    restarted = { was, now: version };
  }
  if (await portTaken(port)) {
    // Another session's server may have come up since the health check.
    if (await probe(port)) return { started: false, log, restarted };
    throw new Error(`port ${port} is in use by another program; set SECOND_CHAIR_PORT to a free port`);
  }
  await mkdir(root, { recursive: true });
  const out = await open(log, 'a');
  const child = spawn(process.execPath, [bin, 'serve', '--port', String(port), '--pid-file', join(root, 'server.pid')], {
    detached: true,
    stdio: ['ignore', out.fd, out.fd],
    env: { ...process.env, SECOND_CHAIR_HOME: root },
    windowsHide: true,
  });
  child.unref();
  await out.close();
  // A cold Node start on a busy machine, with a virus scanner, can take seconds.
  for (const deadline = Date.now() + budget; Date.now() < deadline; await sleep(100)) {
    const h = await health(port);
    // When another session's server got the port, this child exits and that server is the one running.
    if (h) return { started: h.pid === child.pid, pid: h.pid, log, restarted };
  }
  throw new Error(`the server did not come up on port ${port}; see ${log}`);
}

/**
 * Stops the server that start launched. Returns 'stopped', 'stale' (the pid file was left over and no
 * Second Chair server answers on the port), 'other' (the server on the port has another pid, so the pid
 * file is left over too), 'moved' (the caller expected another pid than the server that answers, which
 * matches the pid file: another session restarted it, and both stay) or 'none' (no pid file). Only
 * 'stopped' signals a process.
 */
export async function stop({ root, port, expect }) {
  const file = join(root, 'server.pid');
  const pid = await readPid(root);
  if (!pid) return 'none';
  const h = await health(port);
  if (expect !== undefined && h?.pid === pid && pid !== expect) return 'moved';
  if (!h || h.pid !== pid) {
    await rm(file, { force: true });
    return h ? 'other' : 'stale';
  }
  try {
    process.kill(pid);
  } catch (e) {
    if (e.code === 'EPERM') throw new Error(`not allowed to stop process ${pid}; stop the server on port ${port} by hand, then delete ${file}`);
    if (e.code !== 'ESRCH') throw e;
  }
  await rm(file, { force: true });
  return 'stopped';
}

/** Waits until nothing answers /health on the port, for up to two seconds. */
export async function waitDown(port) {
  for (const deadline = Date.now() + 2000; Date.now() < deadline; await sleep(100)) {
    if (!(await probe(port))) return true;
  }
  return false;
}
