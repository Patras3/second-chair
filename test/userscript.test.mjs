import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Evaluate the script with no `document`, so the DOM bootstrap stays dormant, and pull out the pure helpers.
const source = readFileSync(new URL('../userscript/second-chair.user.js', import.meta.url), 'utf8');
const { parseLocation, parsePayload, stateFor, isNewer, progress, buildExport, buildCard, buildPanelList, buildFilterBar, threadLinks, richText, renderMarkdown, effective, visibleItems, step, rowsFor } =
  new Function(`${source}\nreturn { parseLocation, parsePayload, stateFor, isNewer, progress, buildExport, buildCard, buildPanelList, buildFilterBar, threadLinks, richText, renderMarkdown, effective, visibleItems, step, rowsFor };`)();

const payload = (over = {}) => ({
  tool: 'second-chair', kind: 'proposals', repo: 'acme/w', pr: 7, round: 1, head: 'abc123',
  items: [
    { thread_id: 'T1', comment_id: 11, author: 'bob', path: 'a/b/C.java', line: 3, verdict: 'fix', reply_en: 'Will do.', summary: 'change <x>', context_pl: 'checked `foo()`' },
    { thread_id: 'G', comment_id: null, verdict: 'manual', reply_en: '' },
  ],
  ...over,
});

test('parseLocation takes the PR from every tab of a pull request', () => {
  assert.deepEqual(parseLocation('/acme/w/pull/7'), { repo: 'acme/w', number: 7 });
  assert.deepEqual(parseLocation('/acme/w/pull/7/files'), { repo: 'acme/w', number: 7 });
  assert.equal(parseLocation('/acme/w/pulls'), null);
  assert.equal(parseLocation('/acme/w/issues/7'), null);
});

test('parsePayload refuses what is not a proposals payload', () => {
  assert.match(parsePayload('nope').error, /JSON/);
  assert.match(parsePayload(JSON.stringify({ tool: 'x' })).error, /second-chair/);
  assert.match(parsePayload(JSON.stringify(payload({ round: 3 }))).error, /Unknown round/);
  assert.match(parsePayload(JSON.stringify(payload({ items: [{ thread_id: 'A' }, { thread_id: 'A' }] }))).error, /Duplicate/);
  assert.equal(parsePayload(JSON.stringify(payload())).payload.items.length, 2);
});

test('export stays locked until every thread has a decision', () => {
  const s = stateFor(payload(), null);
  assert.deepEqual(progress(s), { done: 0, auto: 0, total: 2, complete: false });
  s.decisions.T1.decision = 'fix';
  assert.equal(buildExport(s, 'now'), null);
  s.decisions.G.decision = 'manual';
  s.decisions.G.note = 'mine';
  const out = buildExport(s, 'now');
  assert.equal(out.kind, 'decisions');
  assert.deepEqual(out.decisions.map((d) => [d.thread_id, d.proposed, d.decision, d.auto, d.note]), [['T1', 'fix', 'fix', false, ''], ['G', 'manual', 'manual', false, 'mine']]);
});

test('a re-import keeps decisions and edited replies, and takes new drafts for untouched ones', () => {
  const s = stateFor(payload(), null);
  s.decisions.T1 = { decision: 'pushback', note: 'n', reply: 'My words.', replyEdited: true };
  s.decisions.G.decision = 'reply';
  const next = payload();
  next.items[1].reply_en = 'New draft.';
  const r = stateFor(next, s);
  assert.deepEqual(r.decisions.T1, { decision: 'pushback', note: 'n', reply: 'My words.', replyEdited: true });
  assert.equal(r.decisions.G.reply, 'New draft.');
  assert.equal(r.decisions.G.decision, 'reply');
});

test('round 2 starts clean even over round 1 decisions', () => {
  const s = stateFor(payload(), null);
  s.decisions.T1.decision = 'fix';
  const r = stateFor(payload({ round: 2 }), s);
  assert.equal(r.decisions.T1.decision, null);
});

test('cards escape reviewer text and mark the suggested button', () => {
  const s = stateFor(payload(), null);
  const html = buildCard(s, s.payload.items[0], 'inline');
  assert.ok(html.includes('change &lt;x&gt;'));
  assert.ok(html.includes('<code>foo()</code>'));
  assert.match(html, /sc-btn sc-suggested" [^>]*data-sc-val="fix"/);
  assert.ok(html.includes('Context — for you'));
  s.decisions.T1.decision = 'reply';
  const decided = buildCard(s, s.payload.items[0], 'panel');
  assert.match(decided, /sc-btn sc-on" [^>]*data-sc-val="reply"/);
  assert.ok(!decided.includes('sc-suggested'));
  assert.ok(buildPanelList(s, null, 'all', () => ({})).includes('Reply'));
});

test('links point at both the conversation and the files tab, and a global item has none', () => {
  assert.deepEqual(threadLinks('acme/w', 7, 11), { conversation: 'https://github.com/acme/w/pull/7#discussion_r11', files: 'https://github.com/acme/w/pull/7/files#r11' });
  assert.equal(threadLinks('acme/w', 7, null), null);
  assert.equal(richText('a\n`b`<'), 'a<br><code>b</code>&lt;');
});

test('a server payload is newer after a later round, another head, or a re-publish', () => {
  const s = stateFor(payload({ published_at: 't1' }), null);
  assert.equal(isNewer(payload({ published_at: 't1' }), s), false);
  assert.equal(isNewer(payload({ published_at: 't2' }), s), true);
  assert.equal(isNewer(payload({ head: 'def', published_at: 't1' }), s), true);
  assert.equal(isNewer(payload({ round: 2 }), s), true);
  assert.equal(isNewer(payload({ round: 2 }), stateFor(payload({ round: 2, published_at: 'x' }), null)), true);
  assert.equal(isNewer(payload(), null), true);
  const r2 = stateFor(payload({ round: 2 }), null);
  assert.equal(isNewer(payload({ round: 1 }), r2), false);
});

test('the header grants the server calls and points updates at the local server', () => {
  for (const line of ['// @grant        GM_xmlhttpRequest', '// @connect      127.0.0.1', '// @updateURL    http://127.0.0.1:7788/second-chair.user.js']) {
    assert.ok(source.includes(line), `header is missing ${line}`);
  }
});

const autoPayload = () => payload({ items: [
  { thread_id: 'A', verdict: 'fix', auto: true, reply_en: 'Done in abc' },
  { thread_id: 'B', verdict: 'pushback', reply_en: 'No.' },
  { thread_id: 'C', verdict: 'reply', auto: true, reply_en: 'Yes.' },
] });

test('an auto item counts as decided with its proposal until you pick something else', () => {
  const s = stateFor(autoPayload(), null);
  assert.deepEqual(effective(s, s.payload.items[0]), { decision: 'fix', auto: true });
  assert.deepEqual(progress(s), { done: 2, auto: 2, total: 3, complete: false });
  s.decisions.B.decision = 'reply';
  s.decisions.A.decision = 'manual';
  const out = buildExport(s, 'now');
  assert.deepEqual(out.decisions.map((d) => [d.thread_id, d.decision, d.auto]), [['A', 'manual', false], ['B', 'reply', false], ['C', 'reply', true]]);
});

test('an auto flag with a verdict the round does not know stays undecided', () => {
  const s = stateFor(payload({ round: 2, items: [{ thread_id: 'A', verdict: 'fix', auto: true }] }), null);
  assert.deepEqual(effective(s, s.payload.items[0]), { decision: null, auto: false });
});

test('filters split auto, yours and undecided, and chips show counts', () => {
  const s = stateFor(autoPayload(), null);
  const ids = (f) => visibleItems(s, f).map((i) => i.thread_id);
  assert.deepEqual(ids('all'), ['A', 'B', 'C']);
  assert.deepEqual(ids('todo'), ['B']);
  assert.deepEqual(ids('auto'), ['A', 'C']);
  assert.deepEqual(ids('mine'), []);
  assert.deepEqual(ids('d:fix'), ['A']);
  assert.deepEqual(ids('nonsense'), ['A', 'B', 'C']);
  const bar = buildFilterBar(s, 'auto');
  assert.match(bar, /sc-chip sc-chip-on" data-sc-act="filter" data-sc-val="auto">Auto <b>2<\/b>/);
  assert.ok(!bar.includes('data-sc-val="mine"'), 'an empty chip is left out');
});

test('step wraps around and starts at an end when nothing is selected', () => {
  const items = [{ thread_id: 'a' }, { thread_id: 'b' }, { thread_id: 'c' }];
  assert.equal(step(items, null, 1), 'a');
  assert.equal(step(items, null, -1), 'c');
  assert.equal(step(items, 'c', 1), 'a');
  assert.equal(step(items, 'a', -1), 'c');
  assert.equal(step(items, 'b', 1), 'c');
  assert.equal(step([], 'x', 1), null);
});

test('auto and sent cards are compact until expanded; a closed round too', () => {
  const s = stateFor(autoPayload(), null);
  const a = s.payload.items[0];
  assert.match(buildCard(s, a, 'inline', {}), /sc-compact/);
  assert.ok(!buildCard(s, a, 'inline', { expanded: true }).includes('sc-compact'));
  assert.ok(!buildCard(s, s.payload.items[1], 'inline', {}).includes('sc-compact'));
  assert.match(buildCard(s, s.payload.items[1], 'inline', { sent: true }), /sc-compact/);
  assert.match(buildCard(s, s.payload.items[1], 'inline', { closed: true }), /sc-compact/);
  assert.match(buildCard(s, a, 'inline', { expanded: true }), /sc-btn sc-on-auto" [^>]*data-sc-val="fix"/);
});

test('the reply shows as a preview, and as a textarea tall enough for its text while editing', () => {
  const s = stateFor(payload(), null);
  s.decisions.T1.reply = 'line one\n\n- a\n- b';
  const view = buildCard(s, s.payload.items[0], 'inline', {});
  assert.ok(view.includes('sc-reply-view') && !view.includes('<textarea'));
  const edit = buildCard(s, s.payload.items[0], 'inline', { editing: true });
  assert.match(edit, /<textarea class="sc-reply"[^>]* rows="5"/);
  assert.equal(rowsFor('x'.repeat(250), 100), 4);
});

test('markdown falls back to escaped text when marked is not loaded', () => {
  assert.equal(renderMarkdown('a `b` <c>'), '<p>a <code>b</code> &lt;c&gt;</p>');
  assert.equal(renderMarkdown('  '), '');
});

test('a sent mark lasts for one publication of the proposals', () => {
  const s = stateFor(payload({ published_at: 't1' }), null);
  s.sentAt = 'now';
  assert.equal(stateFor(payload({ published_at: 't1' }), s).sentAt, 'now');
  assert.equal(stateFor(payload({ published_at: 't2' }), s).sentAt, null);
  assert.equal(isNewer(payload({ published_at: 't1', closed_at: 'c' }), s), true);
});

const review = (over = {}) => payload({
  mode: 'review',
  items: [
    { thread_id: 'C1', comment_id: 21, author: 'comment', path: 'docs/a.md', line: 5, verdict: 'post', reply_en: 'A finding.', summary: 'the finding' },
    { thread_id: 'BODY', comment_id: null, author: 'review body', verdict: 'post', reply_en: 'Looks good.' },
  ],
  ...over,
});

test('review mode offers Post, Revise and Drop, and labels the text as a comment or the review body', () => {
  const s = stateFor(review(), null);
  const card = buildCard(s, s.payload.items[0], 'inline');
  assert.deepEqual([...card.matchAll(/data-sc-val="([a-z]+)"/g)].map((m) => m[1]), ['post', 'revise', 'drop']);
  assert.ok(card.includes('Comment to post'));
  assert.ok(buildCard(s, s.payload.items[1], 'panel').includes('Review body'));
  assert.match(parsePayload(JSON.stringify(review({ mode: 'other' }))).error, /Unknown mode/);
  assert.match(parsePayload(JSON.stringify(review({ round: 3 }))).error, /Unknown round/);
});

test('Revise counts as decided only once its note says what to change', () => {
  const s = stateFor(review(), null);
  s.decisions.C1.decision = 'revise';
  s.decisions.BODY.decision = 'post';
  assert.equal(progress(s).complete, false);
  assert.equal(buildExport(s, 'now'), null);
  assert.ok(buildCard(s, s.payload.items[0], 'inline').includes('sc-note-needed'));
  s.decisions.C1.note = '   ';
  assert.equal(progress(s).complete, false);
  s.decisions.C1.note = 'shorter, no code block';
  const out = buildExport(s, 'now');
  assert.equal(out.mode, 'review');
  assert.deepEqual(out.decisions.map((d) => [d.thread_id, d.decision, d.note]), [['C1', 'revise', 'shorter, no code block'], ['BODY', 'post', '']]);
});

test('review round 2 keeps only Post and Drop, and a reply-mode export says so', () => {
  const s = stateFor(review({ round: 2 }), null);
  assert.deepEqual([...buildCard(s, s.payload.items[0], 'inline').matchAll(/data-sc-val="([a-z]+)"/g)].map((m) => m[1]), ['post', 'drop']);
  const r = stateFor(payload(), null);
  r.decisions.T1.decision = 'fix';
  r.decisions.G.decision = 'manual';
  assert.equal(buildExport(r, 'now').mode, 'reply');
});
