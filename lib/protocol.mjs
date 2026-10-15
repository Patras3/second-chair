// Second Chair protocol: the rules every party shares. The userscript keeps its own copy of the decision
// table (SC_DECISIONS); test/protocol.test.mjs proves the two agree.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TOOL = 'second-chair';
export const HEADER = 'x-second-chair';
export const DEFAULT_PORT = 7788;
// The package version. /health reports it, so `start` can replace a server that an older plugin started.
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const FINAL_ROUND = 2;
// Decision keys per mode and round, as the userscript offers them. Review mode decides the comments of a
// pending review; Revise there needs a note saying what to change.
export const ROUND_KEYS = {
  reply: { 1: ['reply', 'fix', 'pushback', 'manual'], 2: ['publish', 'revise', 'hold', 'manual', 'change'] },
  review: { 1: ['post', 'revise', 'drop'], 2: ['post', 'revise', 'drop'] },
};
// Review submit events, as GitHub names them.
export const EVENTS = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];
// Who wrote an item's text: the agent now, the user, or Second Chair in an earlier review pass.
export const ORIGINS = ['agent', 'user', 'earlier'];
export const NEEDS_NOTE = new Set(['revise']);
// Keys the user never picks with a button. `change` follows the notes on the code: a note sets it, and deleting the
// last note clears it. The agent never proposes it.
export const DERIVED = new Set(['change']);
const SHA_RE = /^[0-9a-f]{40}$/;

/** True for a full, lowercase commit sha. */
export const isSha = (s) => typeof s === 'string' && SHA_RE.test(s);

function fileError(f, where) {
  if (!f || typeof f.path !== 'string' || !f.path) return `${where}: a file has no path`;
  if (f.old_path != null && typeof f.old_path !== 'string') return `${where}: ${f.path}: old_path must be a string or null`;
  if (!Number.isInteger(f.add) || f.add < 0 || !Number.isInteger(f.del) || f.del < 0) return `${where}: ${f.path}: add and del must be whole numbers`;
  if (typeof f.binary !== 'boolean') return `${where}: ${f.path}: binary must be true or false`;
  if (f.patch != null && typeof f.patch !== 'string') return `${where}: ${f.path}: patch must be a string`;
  return null;
}

/** Returns an error message for a payload's `changes`, or null when it has none or they are valid. */
export function changesError(p) {
  const c = p.changes;
  if (c == null) return null;
  if ((p.mode ?? 'reply') !== 'reply' || p.round !== FINAL_ROUND) return `changes belong to round ${FINAL_ROUND} of respond mode`;
  if (!isSha(c.base) || !isSha(c.head)) return 'changes: base and head must be full shas';
  const count = (n) => Number.isInteger(n) && n >= 0;
  if (!count(c.add) || !count(c.del)) return 'changes: add and del must be whole numbers';
  if (!Array.isArray(c.commits) || c.commits.length === 0) return 'changes: commits must be a non-empty array';
  for (const k of c.commits) {
    if (!isSha(k?.sha)) return 'changes: a commit has no full sha';
    if (typeof k.subject !== 'string' || typeof k.author !== 'string' || !Array.isArray(k.files)) return `changes: ${k.sha.slice(0, 7)}: subject, author or files missing`;
    if (!count(k.add) || !count(k.del)) return `changes: ${k.sha.slice(0, 7)}: add and del must be whole numbers`;
    for (const f of k.files) {
      const e = fileError(f, `changes: ${k.sha.slice(0, 7)}`);
      if (e) return e;
    }
  }
  if (!Array.isArray(c.range?.files)) return 'changes: range.files must be an array';
  const shas = new Set(c.commits.map((k) => k.sha));
  for (const f of c.range.files) {
    const e = fileError(f, 'changes: range');
    if (e) return e;
    if (!Array.isArray(f.commits) || f.commits.length === 0 || !f.commits.every((s) => shas.has(s))) return `changes: range: ${f.path}: commits must name commits of the range`;
  }
  return null;
}

/** The ids of the items whose `commits` hold `sha`: the replies a note on that commit locks. */
export function threadsCiting(proposals, sha) {
  return proposals.items.filter((it) => Array.isArray(it.commits) && it.commits.includes(sha)).map((it) => it.thread_id);
}

/** A copy of the payload without patch texts. The page polls this; the patches stay in the changes file. */
export function withoutPatches(p) {
  if (!p?.changes) return p;
  const lean = ({ patch, ...rest }) => rest;
  return {
    ...p,
    changes: { ...p.changes, commits: p.changes.commits.map((k) => ({ ...k, files: k.files.map(lean) })), range: { ...p.changes.range, files: p.changes.range.files.map(lean) } },
  };
}

function codeNotesError(d, proposals) {
  const notes = d.code_notes ?? [];
  if (!Array.isArray(notes)) return 'code_notes must be an array';
  if (notes.length && !proposals.changes) return 'code_notes need proposals with changes';
  const decisionOf = new Map(d.decisions.map((x) => [x.thread_id, x.decision]));
  const locked = new Set();
  const seen = new Set();
  for (const n of notes) {
    const commit = proposals.changes.commits.find((k) => k.sha === n?.sha);
    if (!commit) return `a code note names ${String(n?.sha).slice(0, 7)}, which is not in the changes`;
    if (!commit.files.some((f) => f.path === n.path || (n.view === 'range' && f.old_path === n.path))) return `a code note names ${n.path}, which ${n.sha.slice(0, 7)} does not change`;
    if (n.view !== 'range' && n.view !== 'commit') return `code note on ${n.path}: view must be range or commit`;
    if (n.view === 'range' && proposals.changes.range.files.find((f) => f.path === n.path)?.commits.at(-1) !== n.sha) {
      return `code note on ${n.path}: a range note belongs to the newest commit that changed the file`;
    }
    if (!String(n.text ?? '').trim()) return `code note on ${n.path} has no text`;
    if (!Array.isArray(n.lines) || !n.lines.every((l) => (l?.side === 'new' || l?.side === 'old') && isCount(l.n))) return `code note on ${n.path}: lines must be { side: "new" or "old", n: a line number }`;
    const key = `${n.sha} ${n.path} ${n.view}`;
    if (seen.has(key)) return `two code notes on ${n.path} in the same view`;
    seen.add(key);
    const want = threadsCiting(proposals, n.sha);
    const got = Array.isArray(n.thread_ids) ? n.thread_ids : [];
    if ([...got].sort().join(' ') !== [...want].sort().join(' ')) return `code note on ${n.path}: thread_ids must be the threads that cite ${n.sha.slice(0, 7)}`;
    for (const t of want) {
      if (decisionOf.get(t) !== 'change') return `thread ${t} cites a commit with a code note, so its decision must be change`;
      locked.add(t);
    }
  }
  for (const [t, decision] of decisionOf) if (decision === 'change' && !locked.has(t)) return `thread ${t}: change needs a code note on a commit it cites`;
  return null;
}
// The final-round keys that post text where others see it. An item with such a verdict cannot be `auto`:
// the user approves every posted text.
export const POSTS = { reply: ['publish'], review: ['post'] };
export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** True for `owner/name` where neither part is `.` or `..`, so the store path stays inside the data directory. */
export function isRepo(repo) {
  return typeof repo === 'string' && REPO_RE.test(repo) && repo.split('/').every((part) => part !== '.' && part !== '..');
}

/** True for a pull request or round number: a whole number of 1 or more. */
export const isCount = (n) => Number.isInteger(n) && n > 0;

export const keysFor = (p) => ROUND_KEYS[p.mode ?? 'reply']?.[p.round];

export function defaultRoot() {
  if (process.env.SECOND_CHAIR_HOME) return process.env.SECOND_CHAIR_HOME;
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'second-chair');
}

export function defaultPort(env = process.env) {
  return Number(env.SECOND_CHAIR_PORT ?? DEFAULT_PORT);
}

/** Returns an error message for a proposals payload, or null when it is valid. */
export function proposalsError(p) {
  if (!p || p.tool !== TOOL || p.kind !== 'proposals') return `not a ${TOOL} proposals payload`;
  if (!isRepo(p.repo) || !isCount(p.pr)) return 'bad repo or pr';
  if (!Object.hasOwn(ROUND_KEYS, p.mode ?? 'reply')) return `unknown mode ${p.mode}`;
  if (!isCount(p.round) || !keysFor(p)) return `unknown round ${p.round}`;
  if (!Array.isArray(p.items) || p.items.length === 0) return 'no items';
  const ids = new Set();
  for (const it of p.items) {
    if (!it || typeof it.thread_id !== 'string' || !it.thread_id) return 'an item has no thread_id';
    if (ids.has(it.thread_id)) return `duplicate thread_id ${it.thread_id}`;
    ids.add(it.thread_id);
    if (it.suggested_submit != null && !EVENTS.includes(it.suggested_submit)) return `${it.thread_id}: suggested_submit must be one of ${EVENTS.join(', ')}`;
    if (it.needs_submit != null && typeof it.needs_submit !== 'boolean') return `${it.thread_id}: needs_submit must be true or false`;
    if ((it.suggested_submit != null || it.needs_submit != null) && it.thread_id !== 'BODY') return `${it.thread_id}: suggested_submit and needs_submit belong on the BODY item`;
    if (DERIVED.has(it.verdict)) return `${it.thread_id}: ${it.verdict} is set by the user's notes on the code, never proposed`;
    if (it.auto === true && p.round === FINAL_ROUND && POSTS[p.mode ?? 'reply'].includes(it.verdict)) {
      return `${it.thread_id}: auto cannot be used with ${it.verdict} in the final round; the user must approve every posted text`;
    }
  }
  const ce = changesError(p);
  if (ce) return ce;
  return null;
}

/** Returns an error message for decisions measured against the proposals they answer, or null. */
export function decisionsError(d, proposals) {
  if (!d || d.tool !== TOOL || d.kind !== 'decisions') return `not a ${TOOL} decisions payload`;
  if (!isRepo(d.repo) || !isCount(d.pr) || !isCount(d.round)) return 'bad repo, pr or round';
  if (!proposals) return 'no proposals for this pull request and round';
  if (d.repo !== proposals.repo || d.pr !== proposals.pr || d.round !== proposals.round) return 'repo, pr or round does not match the proposals';
  if ((d.head ?? null) !== (proposals.head ?? null)) return 'these decisions answer an older head; reload the proposals';
  // A page from 1.1 names the publication it answers. One that the agent replaced since is gone.
  if (d.published_at != null && d.published_at !== (proposals.published_at ?? null)) return `the agent sent a new version of round ${d.round}; decide there`;
  if (d.submit != null) {
    if ((proposals.mode ?? 'reply') !== 'review') return 'submit applies only to review mode';
    if (d.round !== FINAL_ROUND) return `submit applies only to round ${FINAL_ROUND}`;
    if (!EVENTS.includes(d.submit)) return `submit must be one of ${EVENTS.join(', ')}, or null`;
  }
  if (!Array.isArray(d.decisions)) return 'no decisions';
  const want = new Set(proposals.items.map((it) => it.thread_id));
  const got = new Set();
  for (const x of d.decisions) {
    if (!want.has(x.thread_id)) return `unknown thread_id ${x.thread_id}`;
    if (!keysFor(proposals).includes(x.decision)) return `thread ${x.thread_id} has no valid decision`;
    if (NEEDS_NOTE.has(x.decision) && !String(x.note ?? '').trim()) return `thread ${x.thread_id}: ${x.decision} needs a note`;
    got.add(x.thread_id);
  }
  if (got.size !== want.size) return `${want.size - got.size} threads have no decision`;
  return codeNotesError(d, proposals);
}
