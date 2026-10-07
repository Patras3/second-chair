import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUND_KEYS, NEEDS_NOTE, FINAL_ROUND, POSTS, TOOL, EVENTS, ORIGINS, proposalsError, decisionsError, defaultRoot } from '../lib/protocol.mjs';

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
    assert.equal(defaultRoot(), join('/x/data', 'second-chair'));
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

test('the package, the plugin and the userscript carry the version of the latest changelog entry', () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const latest = /^## (\d+\.\d+\.\d+)$/m.exec(read('CHANGELOG.md'))[1];
  assert.equal(JSON.parse(read('package.json')).version, latest, 'package.json');
  assert.equal(JSON.parse(read('.claude-plugin/plugin.json')).version, latest, 'plugin.json');
  assert.equal(/^\/\/ @version\s+(\S+)$/m.exec(source)[1], latest, 'userscript');
});

test('round 2 offers revise in both modes', () => {
  assert.deepEqual(ROUND_KEYS.reply[2], ['publish', 'revise', 'hold', 'manual']);
  assert.deepEqual(ROUND_KEYS.review[2], ['post', 'revise', 'drop']);
  assert.deepEqual(EVENTS, ['COMMENT', 'APPROVE', 'REQUEST_CHANGES']);
  assert.deepEqual(ORIGINS, ['agent', 'user', 'earlier']);
});

test('the buttons say Keep in review mode, and every button explains itself', () => {
  const labels = (mode, round) => SC_DECISIONS[mode][round].map((b) => b.label);
  assert.deepEqual(labels('review', 1), ['Keep', 'Revise', 'Drop']);
  assert.deepEqual(labels('review', 2), ['Keep', 'Revise', 'Drop']);
  assert.deepEqual(labels('reply', 2), ['Publish', 'Revise', 'Hold', 'Manual']);
  for (const b of Object.values(SC_DECISIONS).flatMap((rs) => Object.values(rs).flat())) assert.ok(b.help && b.help.length > 10, b.key);
});

const props = (over = {}) => ({ tool: 'second-chair', kind: 'proposals', mode: 'review', repo: 'a/b', pr: 1, round: 2, head: 'h',
  items: [{ thread_id: 'BODY', comment_id: null, verdict: 'post', reply_en: 'b' }, { thread_id: 'C1', comment_id: 1, verdict: 'post', reply_en: 'c' }], ...over });
const dec = (over = {}) => ({ tool: 'second-chair', kind: 'decisions', mode: 'review', repo: 'a/b', pr: 1, round: 2, head: 'h',
  decisions: [{ thread_id: 'BODY', decision: 'post', note: '' }, { thread_id: 'C1', decision: 'post', note: '' }], ...over });

test('submit is allowed only in review round 2, with a known event', () => {
  assert.equal(decisionsError(dec({ submit: 'COMMENT' }), props()), null);
  assert.equal(decisionsError(dec({ submit: null }), props()), null);
  assert.match(decisionsError(dec({ submit: 'MERGE' }), props()), /submit/);
  assert.match(decisionsError(dec({ round: 1, submit: 'COMMENT' }), props({ round: 1 })), /round 2/);
  assert.match(decisionsError(dec({ mode: 'reply', submit: 'COMMENT', decisions: [{ thread_id: 'BODY', decision: 'publish' }, { thread_id: 'C1', decision: 'publish' }] }), props({ mode: undefined })), /review/);
});

test('revise in round 2 needs a note', () => {
  assert.match(decisionsError(dec({ decisions: [{ thread_id: 'BODY', decision: 'revise', note: '' }, { thread_id: 'C1', decision: 'post' }] }), props()), /needs a note/);
});

test('suggested_submit and needs_submit sit only on the BODY item, with valid values', () => {
  assert.equal(proposalsError(props({ items: [{ thread_id: 'BODY', comment_id: null, verdict: 'post', reply_en: 'b', suggested_submit: 'APPROVE', needs_submit: true }] })), null);
  assert.match(proposalsError(props({ items: [{ thread_id: 'BODY', verdict: 'post', reply_en: 'b', suggested_submit: 'MERGE' }] })), /suggested_submit/);
  assert.match(proposalsError(props({ items: [{ thread_id: 'C1', comment_id: 1, verdict: 'post', reply_en: 'b', needs_submit: true }] })), /BODY/);
  assert.match(proposalsError(props({ items: [{ thread_id: 'BODY', verdict: 'post', reply_en: 'b', needs_submit: 'yes' }] })), /needs_submit/);
});
