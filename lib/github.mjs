// Every GitHub call Second Chair makes, through the gh CLI. Shaping functions are pure so tests can feed
// them recorded responses.
import { execFile } from 'node:child_process';

export function defaultExec(args, stdin) {
  return new Promise((resolve, reject) => {
    const child = execFile('gh', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
    if (stdin !== undefined) child.stdin.end(stdin);
  });
}

export function createGh({ exec = defaultExec } = {}) {
  return {
    async json(args, input) {
      const out = await exec(input === undefined ? args : [...args, '--input', '-'], input === undefined ? undefined : JSON.stringify(input));
      return out.trim() ? JSON.parse(out) : null;
    },
  };
}

// `gh api --slurp` arrived in gh 2.48.0 (cli/cli#8620, released 2024-04-17).
export const GH_FLOOR = '2.48.0';

// Returns the version in `gh --version` output, or null when it cannot be read.
export function parseGhVersion(text) {
  return /gh version (\d+\.\d+\.\d+)/.exec(text ?? '')?.[1] ?? null;
}

export function versionAtLeast(have, floor) {
  const a = have.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

const split = (repo) => {
  const [owner, name] = repo.split('/');
  return { owner, name };
};

export async function resolvePr(gh, arg) {
  const v = await gh.json(['pr', 'view', ...(arg ? [String(arg)] : []), '--json', 'number,url,headRefOid']);
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(v.url);
  return { repo: m[1], pr: v.number, head: v.headRefOid };
}

const THREADS = `query($owner:String!,$name:String!,$pr:Int!,$after:String){
  repository(owner:$owner,name:$name){pullRequest(number:$pr){
    reviewThreads(first:50,after:$after){pageInfo{hasNextPage endCursor}
      nodes{id isResolved isOutdated path line originalLine
        comments(first:100){pageInfo{hasNextPage} nodes{databaseId author{login} createdAt body url}}}}}}}`;

export function shapeThreads(pages) {
  const out = [];
  for (const page of pages) {
    for (const t of page.data.repository.pullRequest.reviewThreads.nodes) {
      if (t.isResolved) continue;
      if (t.comments.pageInfo?.hasNextPage) throw new Error(`thread ${t.id} has more than 100 comments; answer it on GitHub`);
      const cs = t.comments.nodes;
      out.push({
        thread_id: t.id,
        comment_id: cs[0]?.databaseId ?? null,
        path: t.path,
        line: t.line ?? t.originalLine ?? null,
        outdated: Boolean(t.isOutdated),
        url: cs[0]?.url ?? null,
        comments: cs.map((c) => ({ id: c.databaseId, author: c.author?.login ?? 'ghost', created_at: c.createdAt, body: c.body })),
      });
    }
  }
  return out;
}

export async function fetchThreads(gh, { repo, pr }) {
  const { owner, name } = split(repo);
  const pages = [];
  let after = null;
  do {
    const args = ['api', 'graphql', '-f', `query=${THREADS}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `pr=${pr}`];
    if (after) args.push('-f', `after=${after}`);
    const page = await gh.json(args);
    pages.push(page);
    const info = page.data.repository.pullRequest.reviewThreads.pageInfo;
    after = info.hasNextPage ? info.endCursor : null;
  } while (after);
  return shapeThreads(pages);
}

export async function fetchPending(gh, { repo, pr }) {
  const me = (await gh.json(['api', 'user'])).login;
  const reviews = await gh.json(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr}/reviews`]);
  const mine = reviews.flat().find((r) => r.state === 'PENDING' && r.user?.login === me);
  if (!mine) return null;
  const comments = (await gh.json(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr}/reviews/${mine.id}/comments`])).flat();
  return {
    review_id: mine.id,
    node_id: mine.node_id,
    body: mine.body ?? '',
    comments: comments.map((c) => ({ id: c.id, node_id: c.node_id, path: c.path, line: c.line ?? c.original_line ?? null, start_line: c.start_line ?? null, side: c.side ?? 'RIGHT', position: c.position ?? null, body: c.body })),
  };
}
