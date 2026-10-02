import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROUND_KEYS, NEEDS_NOTE, FINAL_ROUND, POSTS, TOOL, proposalsError, defaultRoot } from '../lib/protocol.mjs';

const source = readFileSync(new URL('../userscript/second-chair.user.js', import.meta.url), 'utf8');
const { SC_DECISIONS, SC_TOOL, SC_FINAL_ROUND } = new Function(`${source}\nreturn { SC_DECISIONS, SC_TOOL, SC_FINAL_ROUND };`)();

test('the userscript and the server agree on modes, rounds, decision keys and notes', () => {
  const fromScript = Object.fromEntries(Object.entries(SC_DECISIONS).map(([mode, rounds]) => [mode, Object.fromEntries(Object.entries(rounds).map(([r, bs]) => [r, bs.map((b) => b.key)]))]));
  assert.deepEqual(fromScript, ROUND_KEYS);
  const noteKeys = new Set(Object.values(SC_DECISIONS).flatMap((rs) => Object.values(rs).flat()).filter((b) => b.needsNote).map((b) => b.key));
  assert.deepEqual([...noteKeys], [...NEEDS_NOTE]);
  const posting = Object.fromEntries(Object.entries(SC_DECISIONS).map(([mode, rounds]) => [mode, Object.entries(rounds).flatMap(([r, bs]) => bs.filter((b) => b.posts).map((b) => `${r}:${b.key}`))]));
  assert.deepEqual(posting, Object.fromEntries(Object.entries(POSTS).map(([mode, keys]) => [mode, keys.map((k) => `${FINAL_ROUND}:${k}`)])));
  assert.equal(SC_TOOL, TOOL);
  assert.equal(SC_FINAL_ROUND, FINAL_ROUND);
});

test('a payload with another tool name is refused', () => {
  assert.match(proposalsError({ tool: 'pr-triage', kind: 'proposals' }), /second-chair/);
});

test('the data directory follows SECOND_CHAIR_HOME, then XDG_DATA_HOME', () => {
  const keep = { ...process.env };
  try {
    process.env.SECOND_CHAIR_HOME = '/x/sc';
    assert.equal(defaultRoot(), '/x/sc');
    delete process.env.SECOND_CHAIR_HOME;
    process.env.XDG_DATA_HOME = '/x/data';
    assert.equal(defaultRoot(), '/x/data/second-chair');
  } finally {
    process.env = keep;
  }
});

test('a final-round item may not be auto with a verdict that posts', () => {
  const p = (mode, verdict) => ({ tool: TOOL, kind: 'proposals', repo: 'o/n', pr: 1, round: 2, mode, head: 'h', items: [{ thread_id: 'T1', verdict, auto: true, reply_en: 'x' }] });
  assert.equal(proposalsError(p('reply', 'publish')), 'T1: auto cannot be used with publish in the final round; the user must approve every posted text');
  assert.equal(proposalsError(p('review', 'post')), 'T1: auto cannot be used with post in the final round; the user must approve every posted text');
  assert.equal(proposalsError(p('reply', 'manual')), null);
  assert.equal(proposalsError(p('review', 'drop')), null);
  assert.equal(proposalsError({ ...p('review', 'post'), round: 1 }), null);
});
