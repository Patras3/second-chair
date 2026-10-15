// Reads the commits that `git push` will send: from the pull request's head on GitHub (base) to the local HEAD.
// The page shows them in round 2 of respond mode. git runs with fixed options, so the user's config cannot change
// the output, and never through a shell.
import { execFile } from 'node:child_process';
import { isSha } from './protocol.mjs';

// --no-relative: a `diff.relative` config would drop files outside the current directory.
const DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', '-M'];
// `diff.suppressBlankEmpty` would print an empty context line without its leading space, and the page would lose
// count of the lines after it.
// --literal-pathspecs: a file named `[x].md` is a path, not a glob.
const CONFIG = ['--literal-pathspecs', '-c', 'core.quotePath=false', '-c', 'diff.suppressBlankEmpty=false'];

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', [...CONFIG, ...args], { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_PAGER: 'cat', LC_ALL: 'C' } }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') return reject(err);
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

async function ok(cwd, args) {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Parses `--numstat -z`: `add\tdel\tpath\0`, or `add\tdel\t\0old\0new\0` for a rename. `-` counts mean binary. */
function parseNumstat(out) {
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const [add, del, path] = parts[i].split('\t');
    const binary = add === '-';
    const counts = { add: binary ? 0 : Number(add), del: binary ? 0 : Number(del), binary };
    if (path === '') files.push({ path: parts[i + 2], old_path: parts[i + 1], ...counts }), (i += 2);
    else files.push({ path, old_path: null, ...counts });
  }
  return files;
}

/** Parses `--name-status -z`: `S\0path\0`, or `R100\0old\0new\0`. Returns path to status. */
function parseStatus(out) {
  const parts = out.split('\0');
  const status = new Map();
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!s) continue;
    if (/^[RC]/.test(s)) status.set(parts[i + 2], s), (i += 2);
    else status.set(parts[i + 1], s), (i += 1);
  }
  return status;
}

/** The patch of one file from the hunk headers on, without git's `diff --git` header lines. */
function hunks(patch) {
  if (patch.startsWith('@@')) return patch;
  const at = patch.indexOf('\n@@');
  return at < 0 ? '' : patch.slice(at + 1);
}

async function filesOf(cwd, range) {
  const numstat = parseNumstat(await ok(cwd, [...range.cmd, ...DIFF, '--numstat', '-z', ...range.args]));
  const status = parseStatus(await ok(cwd, [...range.cmd, ...DIFF, '--name-status', '-z', ...range.args]));
  const files = [];
  for (const f of numstat) {
    const file = { path: f.path, old_path: f.old_path, status: status.get(f.path) ?? 'M', add: f.add, del: f.del, binary: f.binary };
    if (!f.binary) {
      const paths = f.old_path ? [f.old_path, f.path] : [f.path];
      file.patch = hunks(await ok(cwd, [...range.cmd, ...DIFF, '--patch', ...range.args, '--', ...paths]));
    }
    files.push(file);
  }
  return files;
}

/**
 * The changes between `base` and `head`, or null when they are the same commit. `cwd` must be the pull request's
 * working tree, at `head`.
 */
export async function collectChanges({ cwd: start, base, head }) {
  if (!isSha(base) || !isSha(head)) throw new Error('--base and --head must be full shas: 40 hex characters');
  // Paths from git are relative to the top of the working tree, so every command runs there, even when `start` is a subdirectory.
  const cwd = (await ok(start, ['rev-parse', '--show-toplevel'])).trim();
  const local = (await ok(cwd, ['rev-parse', 'HEAD'])).trim();
  if (local !== head) throw new Error(`--head ${head.slice(0, 7)} is not this directory's HEAD (${local.slice(0, 7)}); build from the pull request's working tree`);
  if (base === head) return null;
  const anc = await git(cwd, ['merge-base', '--is-ancestor', base, head]);
  if (anc.code === 1) throw new Error("the local branch does not contain the pull request's head on GitHub. A rebase would need a force push, which Second Chair does not do. Tell the user.");
  if (anc.code !== 0) throw new Error(`git does not know ${base.slice(0, 7)}; run git fetch, then build again`);
  const shas = (await ok(cwd, ['rev-list', '--reverse', '--first-parent', `${base}..${head}`])).split('\n').filter(Boolean);
  const commits = [];
  for (const sha of shas) {
    // --no-show-signature: `log.showSignature` would put gpg output into stdout.
    const [subject, author] = (await ok(cwd, ['show', '-s', '--no-show-signature', '--format=%s%x00%an', sha])).replace(/\n$/, '').split('\0');
    const files = await filesOf(cwd, { cmd: ['show', '--no-show-signature', '--format=', '--diff-merges=first-parent'], args: [sha] });
    commits.push({ sha, subject, author, add: files.reduce((n, f) => n + f.add, 0), del: files.reduce((n, f) => n + f.del, 0), files });
  }
  const range = await filesOf(cwd, { cmd: ['diff'], args: [base, head] });
  for (const f of range) {
    const names = new Set([f.path, f.old_path].filter(Boolean));
    f.commits = commits.filter((k) => k.files.some((x) => names.has(x.path) || names.has(x.old_path))).map((k) => k.sha);
    // A rename chain can hide a file from the per-commit lists. git then says which first-parent commits touched it.
    if (!f.commits.length) {
      const touched = new Set((await ok(cwd, ['rev-list', '--first-parent', `${base}..${head}`, '--', ...names])).split('\n').filter(Boolean));
      f.commits = commits.filter((k) => touched.has(k.sha)).map((k) => k.sha);
    }
    if (!f.commits.length) throw new Error(`cannot tell which commit changed ${f.path}; tell the user`);
  }
  return { base, head, add: range.reduce((n, f) => n + f.add, 0), del: range.reduce((n, f) => n + f.del, 0), commits, range: { files: range } };
}

/** Items whose `commits` hold full shas. Each entry must be a unique prefix, 7 characters or more, of a commit in `changes`. */
export function resolveCommits(items, changes) {
  const all = changes.commits.map((k) => k.sha);
  return items.map((it) => {
    if (!Array.isArray(it.commits)) return it;
    const commits = it.commits.map((c) => {
      const s = String(c).toLowerCase();
      if (!/^[0-9a-f]{7,40}$/.test(s)) throw new Error(`${it.thread_id}: commit ${c} must be at least 7 characters of a sha`);
      const hits = all.filter((sha) => sha.startsWith(s));
      if (hits.length === 0) throw new Error(`${it.thread_id}: commit ${c} is not one of the commits git push will send`);
      if (hits.length > 1) throw new Error(`${it.thread_id}: commit ${c} is ambiguous; use more characters`);
      return hits[0];
    });
    return { ...it, commits };
  });
}
