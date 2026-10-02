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
  reply: { 1: ['reply', 'fix', 'pushback', 'manual'], 2: ['publish', 'hold', 'manual'] },
  review: { 1: ['post', 'revise', 'drop'], 2: ['post', 'drop'] },
};
export const NEEDS_NOTE = new Set(['revise']);
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
    if (it.auto === true && p.round === FINAL_ROUND && POSTS[p.mode ?? 'reply'].includes(it.verdict)) {
      return `${it.thread_id}: auto cannot be used with ${it.verdict} in the final round; the user must approve every posted text`;
    }
  }
  return null;
}

/** Returns an error message for decisions measured against the proposals they answer, or null. */
export function decisionsError(d, proposals) {
  if (!d || d.tool !== TOOL || d.kind !== 'decisions') return `not a ${TOOL} decisions payload`;
  if (!isRepo(d.repo) || !isCount(d.pr) || !isCount(d.round)) return 'bad repo, pr or round';
  if (!proposals) return 'no proposals for this pull request and round';
  if (d.repo !== proposals.repo || d.pr !== proposals.pr || d.round !== proposals.round) return 'repo, pr or round does not match the proposals';
  if ((d.head ?? null) !== (proposals.head ?? null)) return 'these decisions answer an older head; reload the proposals';
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
  return null;
}
