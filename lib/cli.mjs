// second-chair CLI: run the server, publish proposals, wait for decisions.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { DEFAULT_PORT, defaultRoot, startServer } from './server.mjs';

const USAGE = `usage:
  second-chair serve [--port N]                          run the server (127.0.0.1 only)
  second-chair push <proposals.json>                     publish proposals for the userscript
  second-chair wait --repo O/N --pr N --round R [--timeout S]
                                                      block until decisions arrive, print them
  second-chair get --repo O/N --pr N --round R           print decisions now, or exit 3 if none
  second-chair close --repo O/N --pr N                   mark the triage done; the page hides its cards
  second-chair status                                    list pull requests and rounds

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
    },
  });
  const port = Number(values.port ?? process.env.SECOND_CHAIR_PORT ?? DEFAULT_PORT);
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
      fail(`the server at ${base} is not running; start it with: second-chair serve`);
    }
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  function prQuery() {
    if (!values.repo || !values.pr || !values.round) fail('--repo, --pr and --round are required');
    return `repo=${encodeURIComponent(values.repo)}&pr=${Number(values.pr)}&round=${Number(values.round)}`;
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
