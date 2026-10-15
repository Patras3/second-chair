import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUND_KEYS, NEEDS_NOTE, FINAL_ROUND, POSTS, TOOL, EVENTS, ORIGINS, DERIVED, isSha, changesError, threadsCiting, withoutPatches, proposalsError, decisionsError, defaultRoot } from '../lib/protocol.mjs';

const source = readFileSync(new URL('../userscript/second-chair.user.js', import.meta.url), 'utf8');
const { SC_DECISIONS, SC_TOOL, SC_FINAL_ROUND } = new Function(`${source}\nreturn { SC_DECISIONS, SC_TOOL, SC_FINAL_ROUND };`)();

test('the userscript and the server agree on modes, rounds, decision keys and notes', () => {
  const fromScript = Object.fromEntries(Object.entries(SC_DECISIONS).map(([mode, rounds]) => [mode, Object.fromEntries(Object.entries(rounds).map(([r, bs]) => [r, bs.map((b) => b.key)]))]));
  assert.deepEqual(fromScript, ROUND_KEYS);
  const noteKeys = new Set(Object.values(SC_DECISIONS).flatMap((rs) => Object.values(rs).flat()).filter((b) => b.needsNote).map((b) => b.key));
  assert.deepEqual([...noteKeys], [...NEEDS_NOTE]);
  const posting = Object.fromEntries(Object.entries(SC_DECISIONS).map(([mode, rounds]) => [mode, Object.entries(rounds).flatMap(([r, bs]) => bs.filter((b) => b.posts).map((b) => `${r}:${b.key}`))]));
  assert.deepEqual(posting, Object.fromEntries(Object.entries(POSTS).map(([mode, keys]) => [mode, keys.map((k) => `${FINAL_ROUND}:${k}`)])));
  const derived = Object.values(SC_DECISIONS).flatMap((rs) => Object.values(rs).flat()).filter((b) => b.derived).map((b) => b.key);
  assert.deepEqual(derived, [...DERIVED]);
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

test('round 2 offers revise in both modes, and change in respond mode', () => {
  assert.deepEqual(ROUND_KEYS.reply[2], ['publish', 'revise', 'hold', 'manual', 'change']);
  assert.deepEqual(ROUND_KEYS.review[2], ['post', 'revise', 'drop']);
  assert.deepEqual([...DERIVED], ['change']);
  assert.deepEqual(EVENTS, ['COMMENT', 'APPROVE', 'REQUEST_CHANGES']);
  assert.deepEqual(ORIGINS, ['agent', 'user', 'earlier']);
});

test('the buttons say Keep in review mode, and every button explains itself', () => {
  const labels = (mode, round) => SC_DECISIONS[mode][round].map((b) => b.label);
  assert.deepEqual(labels('review', 1), ['Keep', 'Revise', 'Drop']);
  assert.deepEqual(labels('review', 2), ['Keep', 'Revise', 'Drop']);
  assert.deepEqual(labels('reply', 2), ['Publish', 'Revise', 'Hold', 'Manual', 'Change code']);
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

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const file = (path, over = {}) => ({ path, old_path: null, status: 'M', add: 1, del: 0, binary: false, patch: '@@ -1 +1,2 @@\n x\n+y\n', ...over });
const changes = () => ({
  base: BASE, head: B, add: 3, del: 0,
  commits: [
    { sha: A, subject: 'first', author: 'me', add: 1, del: 0, files: [file('src/F.java'), file('docs/Mój plik.md')] },
    { sha: B, subject: 'second', author: 'me', add: 2, del: 0, files: [file('src/F.java'), file('src/G.java')] },
  ],
  range: { files: [file('src/F.java', { commits: [A, B] }), file('docs/Mój plik.md', { commits: [A] }), file('src/G.java', { commits: [B] })] },
});
const r2 = (over = {}) => ({
  tool: TOOL, kind: 'proposals', repo: 'o/n', pr: 1, round: 2, head: B,
  items: [
    { thread_id: 'T1', reply_en: 'Fixed in a.', verdict: 'publish', commits: [A] },
    { thread_id: 'T2', reply_en: 'Fixed in b.', verdict: 'publish', commits: [B] },
    { thread_id: 'T3', reply_en: 'Nothing.', verdict: 'hold' },
  ],
  changes: changes(),
  ...over,
});
const rdec = (decisions, code_notes) => ({ tool: TOOL, kind: 'decisions', repo: 'o/n', pr: 1, round: 2, head: B, decisions, ...(code_notes ? { code_notes } : {}) });
const all = (over = {}) => ['T1', 'T2', 'T3'].map((t) => ({ thread_id: t, decision: over[t] ?? 'hold' }));
const note = (over = {}) => ({ sha: A, path: 'docs/Mój plik.md', view: 'commit', lines: [{ side: 'new', n: 1 }], text: 'Fix it.', thread_ids: ['T1'], ...over });

test('isSha takes only 40 lowercase hex characters', () => {
  assert.equal(isSha(A), true);
  assert.equal(isSha('abc1234'), false);
  assert.equal(isSha(A.toUpperCase()), false);
  assert.equal(isSha(`${A}\n`), false);
});

test('changes are checked for shape, and only in round 2 of respond mode', () => {
  assert.equal(proposalsError(r2()), null);
  assert.equal(changesError(r2({ changes: undefined })), null);
  assert.match(changesError(r2({ round: 1 })), /round 2 of respond mode/);
  assert.match(changesError(r2({ mode: 'review' })), /round 2 of respond mode/);
  assert.match(changesError(r2({ changes: { ...changes(), base: 'abc' } })), /full shas/);
  assert.match(changesError(r2({ changes: { ...changes(), commits: [] } })), /non-empty/);
  assert.match(changesError(r2({ changes: { ...changes(), commits: [{ sha: A, subject: 's', author: 'a', add: 0, del: 0, files: [{ path: 1 }] }] } })), /no path/);
  assert.match(changesError(r2({ changes: { ...changes(), commits: [{ sha: A, subject: 's', author: 'a', add: 0, del: 0, files: [file('x', { add: -1 })] }] } })), /whole numbers/);
  assert.match(changesError(r2({ changes: { ...changes(), commits: [{ sha: A, subject: 's', author: 'a', add: '<b>', del: 0, files: [] }] } })), /aaaaaaa: add and del must be whole numbers/);
  assert.match(changesError(r2({ changes: { ...changes(), add: '1' } })), /^changes: add and del/);
  assert.match(changesError(r2({ changes: { ...changes(), commits: [{ sha: A, subject: 's', add: 0, del: 0, files: [] }] } })), /author/);
  assert.match(changesError(r2({ changes: { ...changes(), range: { files: [file('x', { commits: ['f'.repeat(40)] })] } } })), /commits of the range/);
  assert.match(proposalsError(r2({ changes: { ...changes(), head: 'zz' } })), /full shas/);
});

test('change is never an agent verdict', () => {
  const p = r2();
  p.items[0].verdict = 'change';
  assert.equal(proposalsError(p), 'T1: change is set by the user\'s notes on the code, never proposed');
});

test('threadsCiting lists the items whose commits hold the sha', () => {
  assert.deepEqual(threadsCiting(r2(), A), ['T1']);
  assert.deepEqual(threadsCiting(r2(), BASE), []);
});

test('withoutPatches drops every patch and keeps the counts', () => {
  const lean = withoutPatches(r2());
  assert.equal(lean.changes.commits[0].files[0].patch, undefined);
  assert.equal(lean.changes.range.files[0].patch, undefined);
  assert.equal(lean.changes.range.files[0].add, 1);
  assert.deepEqual(lean.changes.range.files[0].commits, [A, B]);
  assert.equal(r2().changes.commits[0].files[0].patch.startsWith('@@'), true, 'the input is not changed');
  const none = r2({ changes: undefined });
  assert.equal(withoutPatches(none), none);
});

test('a code note locks the threads that cite its commit', () => {
  const p = withoutPatches(r2());
  assert.equal(decisionsError(rdec(all({ T1: 'change' }), [note()]), p), null);
  assert.equal(decisionsError(rdec(all(), [note()]), p), 'thread T1 cites a commit with a code note, so its decision must be change');
  assert.equal(decisionsError(rdec(all({ T1: 'change' })), p), 'thread T1: change needs a code note on a commit it cites');
  assert.equal(decisionsError(rdec(all({ T1: 'change' }), [note({ thread_ids: [] })]), p), 'code note on docs/Mój plik.md: thread_ids must be the threads that cite aaaaaaa');
});

test('a code note must name a commit and a file of the changes, with text and lines', () => {
  const p = withoutPatches(r2());
  const ok = all({ T1: 'change' });
  assert.match(decisionsError(rdec(ok, [note({ sha: BASE })]), p), /not in the changes/);
  assert.match(decisionsError(rdec(ok, [note({ path: 'src/G.java' })]), p), /does not change/);
  assert.match(decisionsError(rdec(ok, [note({ text: '  ' })]), p), /has no text/);
  assert.match(decisionsError(rdec(ok, [note({ view: 'all' })]), p), /view must be range or commit/);
  assert.match(decisionsError(rdec(ok, [note({ lines: [{ side: 'left', n: 1 }] })]), p), /lines must be/);
  assert.match(decisionsError(rdec(ok, [note({ lines: [{ side: 'new', n: 0 }] })]), p), /lines must be/);
  assert.match(decisionsError(rdec(ok, [note(), note()]), p), /two code notes/);
  assert.match(decisionsError(rdec(ok, [note()]), withoutPatches(r2({ changes: undefined }))), /need proposals with changes/);
});

test('a range note belongs to the newest commit that changed the file', () => {
  const p = withoutPatches(r2());
  const both = all({ T2: 'change' });
  assert.equal(decisionsError(rdec(both, [note({ sha: B, path: 'src/F.java', view: 'range', thread_ids: ['T2'] })]), p), null);
  assert.match(decisionsError(rdec(all({ T1: 'change' }), [note({ sha: A, path: 'src/F.java', view: 'range' })]), p), /newest commit/);
  assert.equal(decisionsError(rdec(all({ T1: 'change' }), [note({ sha: A, path: 'src/F.java', view: 'commit' })]), p), null);
});

test('a note on a commit that no reply cites locks nothing', () => {
  const p = withoutPatches(r2());
  p.items[1].commits = [];
  assert.equal(decisionsError(rdec(all(), [note({ sha: B, path: 'src/G.java', thread_ids: [] })]), p), null);
});
