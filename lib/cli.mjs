// second-chair CLI: run the server, publish proposals, wait for decisions.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_PORT, defaultPort } from './protocol.mjs';
import { defaultRoot, startServer } from './server.mjs';
import { portTaken, probe, start, stop, waitDown } from './daemon.mjs';
import { buildPayload } from './payload.mjs';
import { publish } from './publish.mjs';
import { createGh, resolvePr, fetchThreads, fetchPending, draft, GH_FLOOR, parseGhVersion, versionAtLeast } from './github.mjs';

const BIN = fileURLToPath(new URL('../bin/second-chair', import.meta.url));

const USAGE = `usage:
  second-chair start [--quiet]                  run the server in the background (once)
  second-chair stop                             stop the server that start launched
  second-chair doctor                           check Node, gh, the server and the userscript
  second-chair serve [--port N]                 run the server in the foreground (127.0.0.1 only)
  second-chair build --repo O/N --pr N --round R --head SHA [--mode review] <items.json>...
                                                wrap items into a payload and print it
  second-chair threads [<pr-url|number>] [--repo O/N --pr N]
                                                print the unresolved review threads as JSON
  second-chair pending [<pr-url|number>] [--repo O/N --pr N]
                                                print your pending review and its comments as JSON, or null
  second-chair draft [<pr-url|number>] <comments.json> [--body-file F]
                                                add comments to your pending review (creates it if none)
  second-chair push <proposals.json>            publish proposals for the userscript
  second-chair wait --repo O/N --pr N --round R [--timeout S]
                                                block until decisions arrive, print them
  second-chair get --repo O/N --pr N --round R  print decisions now, or exit 3 if none
  second-chair publish --repo O/N --pr N [--submit COMMENT|APPROVE|REQUEST_CHANGES]
                                                post the final round's approved texts to GitHub, once;
                                                review mode submits the pending review only with --submit
  second-chair close --repo O/N --pr N          mark the triage done; the page hides its cards
  second-chair status                           list pull requests and rounds

The port comes from --port or SECOND_CHAIR_PORT (default ${DEFAULT_PORT}); storage from SECOND_CHAIR_HOME
(default ~/.local/share/second-chair).`;

class Exit extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

function fail(msg, code = 1) {
  throw new Exit(code, msg);
}

export async function main(argv) {
  try {
    return (await run(argv)) ?? 0;
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    if (e.message) console.error(`second-chair: ${e.message}`);
    return e.code;
  }
}

async function run(argv) {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      repo: { type: 'string' },
      pr: { type: 'string' },
      round: { type: 'string' },
      timeout: { type: 'string' },
      head: { type: 'string' },
      mode: { type: 'string' },
      quiet: { type: 'boolean' },
      'body-file': { type: 'string' },
      submit: { type: 'string' },
    },
  });
  const port = Number(values.port ?? defaultPort());
  const base = `http://127.0.0.1:${port}`;

  async function call(method, path, body) {
    let r;
    try {
      r = await fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Second-Chair': '1' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      fail(`the server at ${base} is not running; start it with: second-chair start`);
    }
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  function prQuery() {
    if (!values.repo || !values.pr || !values.round) fail('--repo, --pr and --round are required');
    return `repo=${encodeURIComponent(values.repo)}&pr=${Number(values.pr)}&round=${Number(values.round)}`;
  }

  async function doctor() {
    const rows = []; // [name, text, ok]; informational rows count as ok
    const major = Number(process.versions.node.split('.')[0]);
    rows.push(['node', major >= 22 ? `${process.versions.node} ok` : `${process.versions.node} is too old; install Node 22 or newer`, major >= 22]);
    const ghOk = await promisify(execFile)('gh', ['auth', 'status'], { timeout: 10000 }).then(() => null, (e) => e);
    const ghVer = ghOk?.code === 'ENOENT' ? null : await promisify(execFile)('gh', ['--version'], { timeout: 10000 }).then((r) => parseGhVersion(r.stdout), () => null);
    if (ghVer && !versionAtLeast(ghVer, GH_FLOOR)) rows.push(['gh', `gh ${ghVer} is too old; second-chair needs ${GH_FLOOR} or newer`, false]);
    else rows.push(['gh', ghOk === null ? 'logged in ok' : ghOk.code === 'ENOENT' ? 'not installed; see https://cli.github.com' : 'not logged in; run: gh auth login', ghOk === null]);
    if (await probe(port)) rows.push(['server', `${base} ok`, true]);
    else if (await portTaken(port)) rows.push(['server', `port ${port} is in use by another program; set SECOND_CHAIR_PORT to a free port`, false]);
    else rows.push(['server', `not running on ${base}; run: second-chair start`, false]);
    rows.push(['userscript', `install from ${base}/second-chair.user.js (needs Tampermonkey or Violentmonkey; in Chrome allow user scripts, see the README)`, true]);
    rows.push(['data', defaultRoot(), true]);
    for (const [k, v] of rows) console.log(`${k.padEnd(11)} ${v}`);
    return rows.every((r) => r[2]) ? 0 : 1;
  }

  if (command === 'start') {
    try {
      const r = await start({ port, root: defaultRoot(), bin: BIN });
      if (r.started) console.log(`second-chair: server started on ${base} (log ${r.log})`);
      else if (!values.quiet) console.log(`second-chair: server already running on ${base}`);
    } catch (e) {
      fail(e.message);
    }
    return 0;
  }
  if (command === 'stop') {
    let state;
    try {
      state = await stop({ root: defaultRoot(), port });
    } catch (e) {
      fail(e.message);
    }
    if (state === 'stopped' && !(await waitDown(port))) fail(`the server on ${base} is still running; stop it by hand`);
    console.log({
      stopped: 'second-chair: server stopped',
      stale: `second-chair: no server answers on ${base}; removed the stale pid file`,
      none: 'second-chair: no server started by second-chair start',
    }[state]);
    return 0;
  }
  if (command === 'doctor') return doctor();

  if (command === 'build') {
    if (!values.repo || !values.pr || !values.round || !values.head || !positionals.length) fail('build needs --repo, --pr, --round, --head and at least one items file');
    const items = [];
    for (const f of positionals) items.push(...JSON.parse(await readFile(f, 'utf8')));
    try {
      const p = buildPayload({ repo: values.repo, pr: Number(values.pr), round: Number(values.round), head: values.head, mode: values.mode ?? 'reply', items });
      console.log(JSON.stringify(p, null, 1));
    } catch (e) {
      fail(e.message);
    }
    return 0;
  }

  if (command === 'threads' || command === 'pending') {
    const gh = createGh();
    const where = values.repo && values.pr ? { repo: values.repo, pr: Number(values.pr) } : await resolvePr(gh, positionals[0]).catch((e) => fail(e.message));
    const out = await (command === 'threads' ? fetchThreads(gh, where) : fetchPending(gh, where)).catch((e) => fail(e.message));
    console.log(JSON.stringify(out, null, 1));
    return 0;
  }

  if (command === 'draft') {
    const gh = createGh();
    const file = positionals.at(-1);
    if (!file) fail('draft needs a comments file: [{"path":"...","line":N,"body":"..."}]');
    const where = await (values.repo && values.pr
      ? resolvePr(gh, `https://github.com/${values.repo}/pull/${values.pr}`)
      : resolvePr(gh, positionals.length > 1 ? positionals[0] : undefined)).catch((e) => fail(e.message));
    const comments = JSON.parse(await readFile(file, 'utf8'));
    const body = values['body-file'] ? await readFile(values['body-file'], 'utf8') : undefined;
    const r = await draft(gh, { ...where, comments, body, backupDir: join(defaultRoot(), 'backups') }).catch((e) => fail(e.message));
    console.log(r.created ? `created pending review ${r.review_id}` : r.recreated ? `recreated pending review ${r.review_id}; your earlier comments are saved in ${r.backup}` : `added ${comments.length} comments to pending review ${r.review_id}`);
    console.log(JSON.stringify(await fetchPending(gh, where), null, 1));
    return 0;
  }

  if (command === 'publish') {
    if (!values.repo || !values.pr) fail('--repo and --pr are required');
    try {
      const r = await publish({ gh: createGh(), api: call, repo: values.repo, pr: Number(values.pr), submit: values.submit });
      console.log(`published ${r.done.length}, skipped ${r.skipped.length} already done`);
    } catch (e) {
      if (e instanceof Exit) throw e;
      fail(e.message);
    }
    return 0;
  }

  if (command === 'serve') {
    await startServer({ port, root: defaultRoot() }).catch((e) => fail(e.code === 'EADDRINUSE' ? `port ${port} is in use` : e.message));
    console.log(`second-chair server on ${base}, storage ${defaultRoot()}`);
    console.log(`install or update the userscript from ${base}/second-chair.user.js`);
  } else if (command === 'push') {
    if (!positionals[0]) fail('push needs a proposals file');
    const payload = JSON.parse(await readFile(positionals[0], 'utf8'));
    const r = await call('PUT', '/api/proposals', payload);
    if (r.status !== 200) fail(`refused: ${r.body?.error ?? r.status}`);
    console.log(`published ${payload.items.length} items for ${payload.repo}#${payload.pr} round ${payload.round}`);
    console.log(`open https://github.com/${payload.repo}/pull/${payload.pr}`);
  } else if (command === 'wait' || command === 'get') {
    const q = prQuery();
    const deadline = values.timeout ? Date.now() + Number(values.timeout) * 1000 : Infinity;
    for (;;) {
      const r = await call('GET', `/api/decisions?${q}`);
      if (r.status === 200) {
        console.log(JSON.stringify(r.body, null, 2));
        break;
      }
      if (r.status !== 404) fail(`server error: ${r.body?.error ?? r.status}`);
      if (command === 'get') fail('no decisions yet', 3);
      if (Date.now() > deadline) fail('timed out waiting for decisions', 2);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } else if (command === 'close') {
    if (!values.repo || !values.pr) fail('--repo and --pr are required');
    const r = await call('POST', '/api/close', { repo: values.repo, pr: Number(values.pr) });
    if (r.status !== 200) fail(`refused: ${r.body?.error ?? r.status}`);
    console.log(`closed ${values.repo}#${values.pr} at ${r.body.closed_at}`);
  } else if (command === 'status') {
    const r = await call('GET', '/api/status');
    for (const s of r.body ?? []) {
      console.log(`${s.repo}#${s.pr} round ${s.round}  ${s.items} items  head ${String(s.head).slice(0, 8)}  published ${s.published_at}  ${s.decided_at ? `decided ${s.decided_at}` : 'waiting'}${s.closed_at ? `  closed ${s.closed_at}` : ''}`);
    }
  } else {
    console.log(USAGE);
    return command ? 1 : 0;
  }
}
