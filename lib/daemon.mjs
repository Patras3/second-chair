// Starts and stops the server as a background process that outlives the shell, the hook or the session
// that started it. spawn with detached + unref works the same on Linux, macOS and Windows.
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { TOOL } from './protocol.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when a Second Chair server answers /health on the port. */
export async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    const body = await r.json().catch(() => null);
    return r.ok && body?.ok === true && body?.tool === TOOL;
  } catch {
    return false;
  }
}

/** True when anything at all accepts a TCP connection on the port. */
export function portTaken(port) {
  return new Promise((resolve) => {
    const s = createConnection({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

export async function start({ port, root, bin }) {
  const log = join(root, 'server.log');
  if (await probe(port)) return { started: false, log };
  if (await portTaken(port)) throw new Error(`port ${port} is in use by another program; set SECOND_CHAIR_PORT to a free port`);
  await mkdir(root, { recursive: true });
  const out = await open(log, 'a');
  const child = spawn(process.execPath, [bin, 'serve', '--port', String(port)], {
    detached: true,
    stdio: ['ignore', out.fd, out.fd],
    env: { ...process.env, SECOND_CHAIR_HOME: root },
    windowsHide: true,
  });
  child.unref();
  await out.close();
  await writeFile(join(root, 'server.pid'), String(child.pid));
  for (let i = 0; i < 30; i++) {
    if (await probe(port)) return { started: true, pid: child.pid, log };
    await sleep(100);
  }
  throw new Error(`the server did not come up on port ${port}; see ${log}`);
}

/**
 * Stops the server that start launched. Returns 'stopped', 'stale' (the pid file was left over and no
 * Second Chair server answers on the port, so nothing was signalled) or 'none' (no pid file).
 */
export async function stop({ root, port }) {
  const file = join(root, 'server.pid');
  const pid = Number(await readFile(file, 'utf8').catch(() => ''));
  if (!pid) return 'none';
  if (!(await probe(port))) {
    await rm(file, { force: true });
    return 'stale';
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
