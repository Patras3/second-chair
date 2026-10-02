// Builds a proposals payload from item arrays and checks every item before anything is pushed.
import { ROUND_KEYS, TOOL, proposalsError } from './protocol.mjs';

const REQUIRED = { 1: ['thread_id', 'verdict', 'reply_en'], 2: ['thread_id', 'reply_en'] };
const isGeneral = (it) => it.comment_id == null;

export function buildPayload({ repo, pr, round, head, mode = 'reply', items }) {
  const keys = ROUND_KEYS[mode]?.[round];
  if (!keys) throw new Error(`unknown mode ${mode} or round ${round}`);
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.thread_id)) throw new Error(`duplicate thread_id ${it.thread_id}`);
    seen.add(it.thread_id);
    const missing = REQUIRED[round].filter((k) => it[k] === undefined);
    if (missing.length) throw new Error(`${it.thread_id}: missing ${missing.join(', ')}`);
    if (it.verdict !== undefined && !keys.includes(it.verdict)) throw new Error(`${it.thread_id}: verdict ${it.verdict} is not a round ${round} ${mode} decision (${keys.join(', ')})`);
    if (it.origin !== undefined && !['agent', 'user'].includes(it.origin)) throw new Error(`${it.thread_id}: origin must be agent or user`);
  }
  const sorted = [...items.filter(isGeneral), ...items.filter((it) => !isGeneral(it))];
  const payload = { tool: TOOL, kind: 'proposals', repo, pr, round, head, items: sorted };
  if (mode !== 'reply') payload.mode = mode;
  const err = proposalsError(payload);
  if (err) throw new Error(err);
  return payload;
}
