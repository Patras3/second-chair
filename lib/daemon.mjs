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

/** True when anything at all accepts a TCP connection on the port. */
export function portTaken(port) {
  return new Promise((resolve) => {
    const s = createConnection({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

/** The pid in the pid file, or 0 when there is none. */
async function readPid(file) {
  return Number(await readFile(file, 'utf8').catch(() => '')) || 0;
}

/**
 * Removes the pid file when it names a process other than the server that answers. Such a file is left over:
 * Windows ends a server without letting it remove its file, and a server that another way started has none.
 */
async function dropStalePid(root, h) {
  const file = join(root, 'server.pid');
  const pid = await readPid(file);
  if (pid && pid !== h.pid) await rm(file, { force: true });
}

/**
 * Runs the server in the background, unless one of this version already answers. The server writes the pid
 * file itself, once it listens. When several sessions start at once, each spawns a server, one of them gets
 * the port, and the others exit; the pid file then names the one that runs.
 *
 * A server of another version is stopped and started again, so a plugin update takes effect in the next
 * session. When it cannot be stopped, the answer has `mismatch` and nothing is changed.
 */
export async function start({ port, root, bin, version = VERSION }) {
  const log = join(root, 'server.log');
  const running = await health(port);
  let restarted;
  if (running) {
    await dropStalePid(root, running);
    if (running.version === version) return { started: false, log };
    const was = running.version ?? 'unknown';
    const state = await stop({ root, port }).catch(() => 'refused');
    // Wait even when this session stopped nothing: another session may be stopping the same server.
    const down = await waitDown(port);
    if (state !== 'stopped' || !down) {
      // Another session may have restarted it in the meantime.
      const now = await health(port);
      if (now?.version === version) return { started: false, log };
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
  for (let i = 0; i < 30; i++) {
    const h = await health(port);
    // When another session's server got the port, this child exits and that server is the one running.
    if (h) return { started: h.pid === child.pid, pid: h.pid, log, restarted };
    await sleep(100);
  }
  throw new Error(`the server did not come up on port ${port}; see ${log}`);
}

/**
 * Stops the server that start launched. Returns 'stopped', 'stale' (the pid file was left over and no
 * Second Chair server answers on the port), 'other' (the server on the port has another pid, so the pid
 * file is left over too) or 'none' (no pid file). Only 'stopped' signals a process.
 */
export async function stop({ root, port }) {
  const file = join(root, 'server.pid');
  const pid = await readPid(file);
  if (!pid) return 'none';
  const h = await health(port);
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
  for (let i = 0; i < 20; i++) {
    if (!(await probe(port))) return true;
    await sleep(100);
  }
  return false;
}
