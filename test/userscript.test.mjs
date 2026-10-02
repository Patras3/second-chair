import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Evaluate the script with no `document`, so the DOM bootstrap stays dormant, and pull out the pure helpers.
const source = readFileSync(new URL('../userscript/second-chair.user.js', import.meta.url), 'utf8');
const { doneInfo, parseLocation, parsePayload, stateFor, isNewer, progress, buildExport, buildCard, buildPanelList, buildFilterBar, groupItems, displayOrder, sentNote, SC_DONE_REASON, threadLinks, richText, renderMarkdown, effective, visibleItems, step, rowsFor } =
  new Function(`${source}\nreturn { doneInfo, parseLocation, parsePayload, stateFor, isNewer, progress, buildExport, buildCard, buildPanelList, buildFilterBar, groupItems, displayOrder, sentNote, SC_DONE_REASON, threadLinks, richText, renderMarkdown, effective, visibleItems, step, rowsFor };`)();

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

test('the card reads as the next comment: header, For you note, reply box, decision group, note', () => {
  const s = stateFor(payload(), null);
  const html = buildCard(s, s.payload.items[0], 'inline');
  assert.match(html, /class="sc-card-head"[\s\S]*Second Chair[\s\S]*proposes[\s\S]*sc-label sc-v-fix">Fix/);
  assert.match(html, /class="sc-foryou"[\s\S]*For you[\s\S]*never posted[\s\S]*<code>foo\(\)<\/code>/);
  assert.ok(html.includes('change &lt;x&gt;'), 'reviewer text is escaped');
  assert.match(html, /class="sc-reply-box"[\s\S]*data-sc-val="write"[\s\S]*data-sc-val="preview"/);
  assert.match(html, /class="sc-md markdown-body/);
  assert.match(html, /sc-btn sc-suggested" [^>]*data-sc-val="fix"/);
  assert.match(html, /<input class="sc-note"/);
  s.decisions.T1.decision = 'reply';
  const decided = buildCard(s, s.payload.items[0], 'inline');
  assert.match(decided, /sc-card sc-decided/);
  assert.match(decided, /sc-btn sc-on" [^>]*data-sc-val="reply"/);
  assert.ok(buildPanelList(s, null, 'all', () => ({})).includes('Reply'));
});

test('Write shows a textarea tall enough for the text; Preview shows rendered markdown', () => {
  const s = stateFor(payload(), null);
  s.decisions.T1.reply = 'line one\n\n- a\n- b';
  assert.ok(!buildCard(s, s.payload.items[0], 'inline', {}).includes('<textarea'));
  assert.match(buildCard(s, s.payload.items[0], 'inline', { editing: true }), /<textarea class="sc-reply"[^>]* rows="5"/);
  assert.equal(rowsFor('x'.repeat(250), 100), 4);
});

test('an auto card is one line until expanded', () => {
  const s = stateFor(autoPayload(), null);
  const a = s.payload.items[0];
  assert.match(buildCard(s, a, 'inline', {}), /sc-compact[\s\S]*auto · Fix[\s\S]*Done in abc/);
  assert.ok(!buildCard(s, a, 'inline', { expanded: true }).includes('sc-compact'));
  assert.ok(!buildCard(s, s.payload.items[1], 'inline', {}).includes('sc-compact'));
  assert.match(buildCard(s, s.payload.items[1], 'inline', { sent: true }), /sc-compact/);
  assert.match(buildCard(s, s.payload.items[1], 'inline', { done: true }), /sc-compact/);
  assert.match(buildCard(s, a, 'inline', { expanded: true }), /sc-btn sc-on-auto" [^>]*data-sc-val="fix"/);
});

test('a comment the user wrote says so, and shows the original under a proposed rewrite', () => {
  const s = stateFor(review({ items: [{ thread_id: 'C', comment_id: 5, verdict: 'revise', origin: 'user', original_en: 'old words', reply_en: 'new words', path: 'a.md', line: 1 }] }), null);
  const html = buildCard(s, s.payload.items[0], 'inline');
  assert.ok(html.includes('Your draft comment'));
  assert.match(html, /<details class="sc-original"><summary>Your original<\/summary>[\s\S]*old words/);
  assert.ok(html.includes('Comment to post'));
});

test('the head shows the position with prev and next links, but not on a read-only card', () => {
  const s = stateFor(payload(), null);
  const html = buildCard(s, s.payload.items[0], 'inline', { position: '1 of 3' });
  assert.match(html, /1 of 3[\s\S]*data-sc-act="prev" data-sc-id="T1"[\s\S]*data-sc-act="next" data-sc-id="T1"/);
  assert.ok(!buildCard(s, s.payload.items[0], 'inline', { position: '1 of 3', readOnly: true }).includes('data-sc-act="prev"'));
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

test('auto never decides a posting choice in the final round', () => {
  const r2 = stateFor(payload({ round: 2, items: [{ thread_id: 'A', verdict: 'publish', auto: true, reply_en: 'x' }, { thread_id: 'B', verdict: 'manual', auto: true, reply_en: '' }] }), null);
  assert.deepEqual(effective(r2, r2.payload.items[0]), { decision: null, auto: false });
  assert.deepEqual(effective(r2, r2.payload.items[1]), { decision: 'manual', auto: true });
  const rv = stateFor(payload({ mode: 'review', round: 2, items: [{ thread_id: 'C1', comment_id: 1, verdict: 'post', auto: true, reply_en: 'x' }, { thread_id: 'C2', comment_id: 2, verdict: 'drop', auto: true, reply_en: 'y' }] }), null);
  assert.deepEqual(effective(rv, rv.payload.items[0]), { decision: null, auto: false });
  assert.deepEqual(effective(rv, rv.payload.items[1]), { decision: 'drop', auto: true });
  const r1 = stateFor(payload({ mode: 'review', round: 1, items: [{ thread_id: 'C1', comment_id: 1, verdict: 'post', auto: true, reply_en: 'x' }] }), null);
  assert.deepEqual(effective(r1, r1.payload.items[0]), { decision: 'post', auto: true }, 'round 1 posts nothing');
});

test('filters split auto, yours and undecided', () => {
  const s = stateFor(autoPayload(), null);
  const ids = (f) => visibleItems(s, f).map((i) => i.thread_id);
  assert.deepEqual(ids('all'), ['A', 'B', 'C']);
  assert.deepEqual(ids('todo'), ['B']);
  assert.deepEqual(ids('auto'), ['A', 'C']);
  assert.deepEqual(ids('mine'), []);
  assert.deepEqual(ids('d:fix'), ['A']);
  assert.deepEqual(ids('nonsense'), ['A', 'B', 'C']);
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
  assert.deepEqual([...card.matchAll(/data-sc-act="decide"[^>]*data-sc-val="([a-z]+)"/g)].map((m) => m[1]), ['post', 'revise', 'drop']);
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
  assert.deepEqual([...buildCard(s, s.payload.items[0], 'inline').matchAll(/data-sc-act="decide"[^>]*data-sc-val="([a-z]+)"/g)].map((m) => m[1]), ['post', 'drop']);
  const r = stateFor(payload(), null);
  r.decisions.T1.decision = 'fix';
  r.decisions.G.decision = 'manual';
  assert.equal(buildExport(r, 'now').mode, 'reply');
});

test('a triage is done when closed, when the final round was sent, or when marked done', () => {
  const r1 = stateFor(payload({ published_at: 't1' }), null);
  assert.equal(doneInfo(r1), null);
  r1.sentAt = 's1';
  assert.equal(doneInfo(r1), null, 'sending round 1 is not the end');
  const r2 = stateFor(payload({ round: 2, published_at: 't2' }), null);
  r2.sentAt = 's2';
  assert.deepEqual(doneInfo(r2), { at: 's2', reason: 'final-sent' });
  const closed = stateFor(payload({ published_at: 't1', closed_at: 'c1' }), null);
  assert.deepEqual(doneInfo(closed), { at: 'c1', reason: 'closed' });
  const marked = stateFor(payload({ published_at: 't1' }), null);
  marked.doneAt = 'm1';
  assert.deepEqual(doneInfo(marked), { at: 'm1', reason: 'marked' });
  const review2 = stateFor(review({ round: 2, published_at: 't3' }), null);
  review2.sentAt = 's3';
  assert.equal(doneInfo(review2).reason, 'final-sent');
});

test('a new publication reopens a finished triage', () => {
  const s = stateFor(payload({ round: 2, published_at: 't2' }), null);
  s.sentAt = 's2';
  s.doneAt = 'm2';
  assert.equal(stateFor(payload({ round: 2, published_at: 't2' }), s).doneAt, 'm2', 'the same publication keeps the mark');
  const next = stateFor(payload({ round: 1, published_at: 't9' }), s);
  assert.equal(next.doneAt, null);
  assert.equal(next.sentAt, null);
  assert.equal(doneInfo(next), null);
});

test('a read-only card has no buttons, no editor and no note', () => {
  const s = stateFor(payload(), null);
  s.decisions.T1.decision = 'fix';
  const html = buildCard(s, s.payload.items[0], 'inline', { readOnly: true, expanded: true });
  assert.ok(!html.includes('data-sc-act="decide"'));
  assert.ok(!html.includes('data-sc-field="note"'));
  assert.ok(!html.includes('data-sc-act="tab"'));
  assert.ok(html.includes('Will do.'));
  assert.match(html, /Decision:<\/span> <b>Fix<\/b>/);
  s.decisions.T1.decision = null;
  assert.match(buildCard(s, s.payload.items[0], 'inline', { readOnly: true }), /Decision:<\/span> <b>none<\/b>/);
});

test('a stored state whose final round was sent stays done without the server', () => {
  const stored = JSON.parse(JSON.stringify({ ...stateFor(payload({ round: 2, published_at: 't2' }), null), sentAt: 's2' }));
  assert.equal(doneInfo(stored).reason, 'final-sent');
});

test('panel rows are grouped by file with general items first', () => {
  const items = [
    { thread_id: 'A', path: 'src/x.js' }, { thread_id: 'G', comment_id: null }, { thread_id: 'B', path: 'docs/y.md' }, { thread_id: 'C', path: 'src/x.js' },
  ];
  assert.deepEqual(groupItems(items).map((g) => [g.label, g.items.map((i) => i.thread_id)]), [['General', ['G']], ['src/x.js', ['A', 'C']], ['docs/y.md', ['B']]]);
});

test('filters are tabs with counters, and decisions sit in a select', () => {
  const s = stateFor(autoPayload(), null);
  const bar = buildFilterBar(s, 'auto');
  assert.match(bar, /class="sc-ftab sc-ftab-on" data-sc-act="filter" data-sc-val="auto">Auto<b>2<\/b>/);
  assert.match(bar, /<select class="sc-fdecision"[\s\S]*<option value="d:fix">Fix \(1\)<\/option>/);
  assert.ok(bar.includes('data-sc-val="mine"'), 'the fixed tabs stay even when empty');
});

test('a panel row shows status, summary, author, line and decision', () => {
  const s = stateFor(payload(), null);
  s.decisions.T1.decision = 'fix';
  const html = buildPanelList(s, null, 'all', () => ({}));
  assert.match(html, /class="sc-group"[\s\S]*a\/b\/C\.java/);
  assert.match(html, /class="sc-row sc-decided"[\s\S]*change &lt;x&gt;[\s\S]*bob · line 3[\s\S]*sc-label sc-v-fix">Fix/);
});

test('an auto label is green, and an incomplete Revise is not decided', () => {
  const a = stateFor(autoPayload(), null);
  assert.match(buildPanelList(a, null, 'all', () => ({})), /sc-label sc-auto sc-v-fix">auto · Fix/);
  assert.match(buildCard(a, a.payload.items[0], 'inline', {}), /sc-label sc-auto sc-v-fix">auto · Fix/);
  const s = stateFor(review(), null);
  s.decisions.C1.decision = 'revise';
  assert.ok(!buildCard(s, s.payload.items[0], 'inline').includes('sc-card sc-decided'));
  assert.ok(!buildPanelList(s, null, 'all', () => ({})).includes('class="sc-row sc-decided"'));
  assert.match(buildPanelList(s, null, 'all', () => ({})), /needs a note/);
  s.decisions.C1.note = 'shorter';
  assert.match(buildCard(s, s.payload.items[0], 'inline'), /sc-card sc-decided/);
});

test('the summary has no extra gap above it, and the dead label table is gone', () => {
  const s = stateFor(payload(), null);
  assert.match(buildCard(s, s.payload.items[0], 'inline'), /class="sc-summary sc-md"/);
  assert.ok(!source.includes('SC_VERDICT_LABEL'));
  assert.ok(source.includes('color:var(--fgColor-onEmphasis,#fff)'));
});

test('the done banner cannot say who closed it, and the sent note fits both ways of sending', () => {
  assert.equal(SC_DONE_REASON.closed, 'closed');
  const s = stateFor(payload(), null);
  s.sentAt = 'T';
  s.sentVia = 'server';
  assert.match(sentNote(s), /^Decisions sent .*\. The agent picks them up from the server/);
  s.sentVia = 'clipboard';
  assert.ok(!/server/.test(sentNote(s)));
  assert.match(sentNote(s), /clipboard/);
  assert.equal(stateFor(payload({ published_at: 'x' }), s).sentVia ?? null, null);
});

test('moving and counting follow the panel order, not the payload order', () => {
  const items = [{ thread_id: 'A', path: 'x' }, { thread_id: 'B', path: 'y' }, { thread_id: 'C', path: 'x' }, { thread_id: 'G' }];
  assert.deepEqual(displayOrder(items).map((i) => i.thread_id), ['G', 'A', 'C', 'B']);
  assert.equal(step(displayOrder(items), 'A', 1), 'C');
});
