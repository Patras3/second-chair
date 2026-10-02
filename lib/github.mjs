// Every GitHub call Second Chair makes, through the gh CLI. Shaping functions are pure so tests can feed
// them recorded responses.
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// On an HTTP error gh prints only the status to stderr; GitHub's reason is in the JSON it prints to stdout.
export function ghError(args, err, stdout, stderr) {
  let why = (stderr || err.message).trim();
  try {
    const body = JSON.parse(stdout);
    const reasons = (body.errors ?? []).map((x) => (typeof x === 'string' ? x : x?.message)).filter((m) => m && !why.includes(m));
    if (reasons.length) why += `: ${reasons.join('; ')}`;
  } catch {
    // Not JSON: stderr says it all.
  }
  return new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${why}`);
}

export function defaultExec(args, stdin) {
  return new Promise((resolve, reject) => {
    const child = execFile('gh', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(ghError(args, err, stdout, stderr));
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

// The review threads include my own pending comments, both new threads and replies, with state PENDING.
const THREADS = `query($owner:String!,$name:String!,$pr:Int!,$after:String){
  repository(owner:$owner,name:$name){pullRequest(number:$pr){
    reviewThreads(first:50,after:$after){pageInfo{hasNextPage endCursor}
      nodes{id isResolved isOutdated path line originalLine startLine diffSide startDiffSide
        comments(first:100){pageInfo{hasNextPage} nodes{databaseId state author{login} createdAt body url pullRequestReview{databaseId}}}}}}}}`;

const threadNodes = (pages) => pages.flatMap((page) => page.data.repository.pullRequest.reviewThreads.nodes);

/** The unresolved threads others can see. My pending comments are drafts, not conversation, so they are left out. */
export function shapeThreads(pages) {
  const out = [];
  for (const t of threadNodes(pages)) {
    if (t.isResolved) continue;
    if (t.comments.pageInfo?.hasNextPage) throw new Error(`thread ${t.id} has more than 100 comments; answer it on GitHub`);
    const cs = t.comments.nodes.filter((c) => c.state !== 'PENDING');
    if (!cs.length) continue;
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
  return out;
}

/** Anchors of the comments in one review, by comment id, read from the threads they sit in. */
export function reviewAnchors(pages, reviewId) {
  const out = new Map();
  for (const t of threadNodes(pages)) {
    const [root] = t.comments.nodes;
    t.comments.nodes.forEach((c, i) => {
      if (c.pullRequestReview?.databaseId !== reviewId) return;
      const line = t.line ?? null;
      // A single-line thread reports startLine equal to line; GitHub refuses that as a range.
      const start = line != null && t.startLine != null && t.startLine < line ? t.startLine : null;
      out.set(c.databaseId, { line, start_line: start, side: t.diffSide ?? null, start_side: start == null ? null : (t.startDiffSide ?? t.diffSide ?? null), in_reply_to: i === 0 ? null : root.databaseId });
    });
  }
  return out;
}

async function threadPages(gh, { repo, pr }) {
  const { owner, name } = split(repo);
  const pages = [];
  let after = null;
  do {
    const args = ['api', 'graphql', '-f', `query=${THREADS}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `pr=${pr}`];
    if (after) args.push('-f', `after=${after}`);
    const page = await gh.json(args);
    pages.push(page);
    const info = page.data.repository.pullRequest.reviewThreads.pageInfo;
    after = info.hasNextPage ? info.endCursor : null;
  } while (after);
  return pages;
}

export async function fetchThreads(gh, where) {
  return shapeThreads(await threadPages(gh, where));
}

export async function fetchPending(gh, { repo, pr }) {
  const me = (await gh.json(['api', 'user'])).login;
  const reviews = await gh.json(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr}/reviews`]);
  const mine = reviews.flat().find((r) => r.state === 'PENDING' && r.user?.login === me);
  if (!mine) return null;
  const comments = (await gh.json(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr}/reviews/${mine.id}/comments`])).flat();
  // That endpoint gives no line, start_line or side for pending comments, so they come from the threads.
  const anchors = reviewAnchors(await threadPages(gh, { repo, pr }), mine.id);
  return {
    review_id: mine.id,
    node_id: mine.node_id,
    commit_id: mine.commit_id ?? null,
    body: mine.body ?? '',
    comments: comments.map((c) => {
      const a = anchors.get(c.id);
      return {
        id: c.id,
        node_id: c.node_id,
        path: c.path,
        line: a?.line ?? c.line ?? c.original_line ?? null,
        start_line: a ? a.start_line : (c.start_line ?? null),
        side: a?.side ?? c.side ?? 'RIGHT',
        start_side: a ? a.start_side : (c.start_side ?? null),
        position: c.position ?? null,
        in_reply_to: a ? a.in_reply_to : (c.in_reply_to_id ?? null),
        body: c.body,
      };
    }),
  };
}

const ADD_THREAD = `mutation($input:AddPullRequestReviewThreadInput!){addPullRequestReviewThread(input:$input){thread{id}}}`;

const restComment = (c) => {
  const out = { path: c.path };
  if (c.line != null) {
    out.line = c.line;
    if (c.start_line != null) out.start_line = c.start_line;
    if (c.start_line != null && c.start_side != null) out.start_side = c.start_side;
    out.side = c.side ?? 'RIGHT';
  } else {
    out.position = c.position;
  }
  out.body = c.body;
  return out;
};

async function createReview(gh, { repo, pr, head, body, comments }) {
  // No `event` field: GitHub keeps the review PENDING until its author submits it.
  const input = { commit_id: head, comments: comments.map(restComment) };
  if (body) input.body = body;
  return gh.json(['api', '-X', 'POST', `repos/${repo}/pulls/${pr}/reviews`], input);
}

function validateDraftComments(comments) {
  if (!Array.isArray(comments) || !comments.length) throw new Error('draft needs at least one comment. Nothing was changed.');
  comments.forEach((c, i) => {
    const bad = (why) => { throw new Error(`comment ${i + 1} ${why}. Nothing was changed.`); };
    if (typeof c?.path !== 'string' || !c.path) bad('needs a path');
    if (!Number.isInteger(c.line) || c.line < 1) bad('needs a line that is a whole number of 1 or more');
    if (c.start_line != null && (!Number.isInteger(c.start_line) || c.start_line < 1 || c.start_line >= c.line)) bad('has a start_line that is not below its line');
    if (c.side != null && c.side !== 'RIGHT' && c.side !== 'LEFT') bad('has a side that is not RIGHT or LEFT');
    if (typeof c.body !== 'string' || !c.body.trim()) bad('needs a body');
  });
}

export async function draft(gh, { repo, pr, head, comments, body, backupDir }) {
  validateDraftComments(comments);
  const pending = await fetchPending(gh, { repo, pr });
  if (!pending) {
    const r = await createReview(gh, { repo, pr, head, body, comments });
    return { review_id: r.id, created: true, recreated: false };
  }
  try {
    // GitHub refuses to set a body on a pending review that has none, so only a rebuild can add one.
    if (body !== undefined && body !== pending.body && !pending.body) throw new Error('GitHub cannot add a body to a pending review that has none');
    let added = 0;
    for (const c of comments) {
      const input = { pullRequestReviewId: pending.node_id, path: c.path, line: c.line, side: c.side ?? 'RIGHT', body: c.body };
      if (c.start_line != null) Object.assign(input, { startLine: c.start_line, startSide: c.side ?? 'RIGHT' });
      const r = await gh.json(['api', 'graphql'], { query: ADD_THREAD, variables: { input } });
      if (!r?.data?.addPullRequestReviewThread?.thread?.id) {
        // A line GitHub cannot place gives a null thread and no error. A rebuild would fail on the same line.
        const sofar = added ? `${added} ${added === 1 ? 'comment before it was' : 'comments before it were'} added to pending review ${pending.review_id}; remove ${added === 1 ? 'it' : 'them'} from the file before you run draft again.` : 'Nothing was changed.';
        throw Object.assign(new Error(`GitHub did not add comment ${added + 1} (${c.path}:${c.line}); the line must be part of the pull request's diff. ${sofar}`), { anchor: true });
      }
      added++;
    }
    if (body !== undefined && body !== pending.body) await gh.json(['api', '-X', 'PUT', `repos/${repo}/pulls/${pr}/reviews/${pending.review_id}`], { body });
    return { review_id: pending.review_id, created: false, recreated: false };
  } catch (err) {
    if (err.anchor) throw err;
    // GitHub can refuse to add a thread to an existing pending review. Then rebuild the review with the
    // user's comments first, after saving them, so nothing they wrote can be lost.
    const reply = pending.comments.find((c) => c.in_reply_to != null);
    if (reply) throw new Error(`cannot add to your pending review (${err.message}), and your comment ${reply.id} is a reply in an existing thread, which GitHub cannot recreate. Nothing was changed.`);
    const unanchored = pending.comments.find((c) => c.line == null && c.position == null);
    if (unanchored) throw new Error(`cannot add to your pending review (${err.message}), and your comment ${unanchored.id} has no line to recreate it with. Nothing was changed.`);
    if (pending.commit_id && pending.commit_id !== head) throw new Error(`cannot add to your pending review (${err.message}), and it was made on commit ${pending.commit_id.slice(0, 8)} while the pull request is now at ${String(head).slice(0, 8)}; recreating it would move your comments. Nothing was changed.`);
    await mkdir(backupDir, { recursive: true });
    const backup = join(backupDir, `pending-${repo.replace('/', '_')}-${pr}-${Date.now()}.json`);
    await writeFile(backup, `${JSON.stringify(pending, null, 2)}\n`);
    try {
      await gh.json(['api', '-X', 'DELETE', `repos/${repo}/pulls/${pr}/reviews/${pending.review_id}`]);
    } catch (e) {
      throw new Error(`could not delete your pending review (${e.message}); it may still exist. Your comments are also saved in ${backup}`);
    }
    try {
      const r = await createReview(gh, { repo, pr, head, body: body ?? pending.body, comments: [...pending.comments, ...comments] });
      return { review_id: r.id, created: false, recreated: true, backup };
    } catch (e) {
      try {
        await createReview(gh, { repo, pr, head, body: pending.body, comments: pending.comments });
      } catch (e2) {
        throw new Error(`your pending review was deleted and could not be recreated (${e2.message}); your comments are saved in ${backup}`);
      }
      throw new Error(`your pending review was recreated with your own comments, but the new ones were not added (${e.message}); your comments are also saved in ${backup}`);
    }
  }
}
