// second-chair local server: hands proposals to the userscript and takes decisions back.
// Storage is plain JSON files, one directory per pull request:
//   <root>/<owner>/<name>/<pr>/r<round>-proposals.json
//   <root>/<owner>/<name>/<pr>/r<round>-decisions.json
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, HEADER, REPO_RE, defaultRoot, proposalsError, decisionsError } from './protocol.mjs';

export { DEFAULT_PORT, defaultRoot, proposalsError, decisionsError };

const MAX_BODY = 5 * 1024 * 1024;
const HERE = dirname(fileURLToPath(import.meta.url));

function prDir(root, repo, pr) {
  const [owner, name] = repo.split('/');
  return join(root, owner, name, String(pr));
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, file);
}

async function rounds(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return names.map((n) => /^r(\d+)-proposals\.json$/.exec(n)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
}

export function createStore(root) {
  return {
    /** The most recently published round. A new review cycle starts again at round 1, below an older round 2. */
    async latestProposals(repo, pr) {
      const dir = prDir(root, repo, pr);
      let latest = null;
      for (const round of await rounds(dir)) {
        const p = await this.proposals(repo, pr, round);
        if (p && (!latest || (p.published_at ?? '') >= (latest.published_at ?? ''))) latest = p;
      }
      return latest;
    },
    /** The stored proposals, with `closed_at` added when the pull request's triage was closed after they were published. */
    async proposals(repo, pr, round) {
      const dir = prDir(root, repo, pr);
      const p = await readJson(join(dir, `r${round}-proposals.json`));
      if (!p) return null;
      const closed = await readJson(join(dir, 'closed.json'));
      return closed && closed.closed_at >= (p.published_at ?? '') ? { ...p, closed_at: closed.closed_at } : p;
    },
    async close(repo, pr, now) {
      const dir = prDir(root, repo, pr);
      if (!(await rounds(dir)).length) return null;
      await writeJson(join(dir, 'closed.json'), { closed_at: now });
      return now;
    },
    async putProposals(p, now) {
      const dir = prDir(root, p.repo, p.pr);
      const stored = { ...p, published_at: now };
      await writeJson(join(dir, `r${p.round}-proposals.json`), stored);
      // New proposals for a round make its old decisions answer something that is gone.
      await rm(join(dir, `r${p.round}-decisions.json`), { force: true });
      return stored;
    },
    async decisions(repo, pr, round) {
      return readJson(join(prDir(root, repo, pr), `r${round}-decisions.json`));
    },
    async putDecisions(d, now) {
      const stored = { ...d, received_at: now };
      await writeJson(join(prDir(root, d.repo, d.pr), `r${d.round}-decisions.json`), stored);
      return stored;
    },
    async list() {
      const out = [];
      for (const owner of await readdir(root).catch(() => [])) {
        for (const name of await readdir(join(root, owner)).catch(() => [])) {
          for (const pr of await readdir(join(root, owner, name)).catch(() => [])) {
            const dir = join(root, owner, name, pr);
            for (const round of await rounds(dir)) {
              const p = await this.proposals(`${owner}/${name}`, Number(pr), round);
              const d = await readJson(join(dir, `r${round}-decisions.json`));
              out.push({ repo: `${owner}/${name}`, pr: Number(pr), round, head: p?.head ?? null, items: p?.items?.length ?? 0, published_at: p?.published_at ?? null, decided_at: d?.received_at ?? null, closed_at: p?.closed_at ?? null });
            }
          }
        }
      }
      return out;
    },
  };
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('body is not JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * The request handler. Every /api call must carry `X-Second-Chair: 1`: a web page cannot add a custom header to a
 * cross-origin request without a CORS preflight, and this server never answers one. The Host check stops a DNS
 * rebinding page from reaching the server under its own name.
 */
export function createHandler({ store, port, now = () => new Date().toISOString(), log = () => {} }) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      if (!hosts.has(req.headers.host)) return send(res, 403, { error: 'unexpected Host header' });
      if (req.method === 'GET' && url.pathname === '/second-chair.user.js') {
        const script = await readFile(join(HERE, '..', 'userscript', 'second-chair.user.js'), 'utf8');
        return send(res, 200, script.replace(/127\.0\.0\.1:7788/g, `127.0.0.1:${port}`), 'text/javascript; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      if (req.headers[HEADER] !== '1') return send(res, 403, { error: 'missing X-Second-Chair header' });

      const repo = url.searchParams.get('repo');
      const pr = Number(url.searchParams.get('pr'));
      const round = Number(url.searchParams.get('round'));
      const needPr = () => REPO_RE.test(repo ?? '') && Number.isInteger(pr) && pr > 0;

      if (req.method === 'GET' && url.pathname === '/api/proposals') {
        if (!needPr()) return send(res, 400, { error: 'repo and pr are required' });
        const p = Number.isInteger(round) && round > 0 ? await store.proposals(repo, pr, round) : await store.latestProposals(repo, pr);
        return p ? send(res, 200, p) : send(res, 404, { error: 'no proposals' });
      }
      if (req.method === 'PUT' && url.pathname === '/api/proposals') {
        const p = await readBody(req);
        const err = proposalsError(p);
        if (err) return send(res, 400, { error: err });
        const stored = await store.putProposals(p, now());
        log(`proposals ${p.repo}#${p.pr} round ${p.round}: ${p.items.length} items`);
        return send(res, 200, { ok: true, published_at: stored.published_at });
      }
      if (req.method === 'GET' && url.pathname === '/api/decisions') {
        if (!needPr() || !(round > 0)) return send(res, 400, { error: 'repo, pr and round are required' });
        const d = await store.decisions(repo, pr, round);
        return d ? send(res, 200, d) : send(res, 404, { error: 'no decisions yet' });
      }
      if (req.method === 'POST' && url.pathname === '/api/decisions') {
        const d = await readBody(req);
        const proposals = d && REPO_RE.test(d.repo ?? '') && Number.isInteger(d.pr) ? await store.proposals(d.repo, d.pr, d.round) : null;
        const err = decisionsError(d, proposals);
        if (err) return send(res, 409, { error: err });
        await store.putDecisions(d, now());
        log(`decisions ${d.repo}#${d.pr} round ${d.round}: ${d.decisions.length} threads`);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/close') {
        const b = await readBody(req);
        if (!REPO_RE.test(b?.repo ?? '') || !Number.isInteger(b?.pr)) return send(res, 400, { error: 'repo and pr are required' });
        const at = await store.close(b.repo, b.pr, now());
        if (!at) return send(res, 404, { error: 'no proposals for this pull request' });
        log(`closed ${b.repo}#${b.pr}`);
        return send(res, 200, { ok: true, closed_at: at });
      }
      if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, await store.list());
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, e.status ?? 500, { error: e.message });
    }
  };
}

export function startServer({ port = DEFAULT_PORT, root = defaultRoot(), log = console.log } = {}) {
  const server = createServer(createHandler({ store: createStore(root), port, log }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
