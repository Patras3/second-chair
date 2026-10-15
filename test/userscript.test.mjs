import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Evaluate the script with no `document`, so the DOM bootstrap stays dormant, and pull out the pure helpers.
const source = readFileSync(new URL('../userscript/second-chair.user.js', import.meta.url), 'utf8');
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NAMES = ['SC_LOGO', 'SC_DECISIONS', 'SC_MODE_NAME', 'doneInfo', 'parseLocation', 'parsePayload', 'stateFor', 'isNewer', 'progress', 'buildExport', 'buildCard', 'buildPanelList', 'buildFilterBar', 'groupItems', 'displayOrder', 'SC_DONE_REASON', 'threadLinks', 'richText', 'renderMarkdown', 'effective', 'visibleItems', 'step', 'rowsFor', 'hasRevise', 'phaseOf', 'statusOf', 'publishedSummary', 'submitLock', 'buildYourReview', 'emptyPanel', 'tourSteps', 'tourKey', 'buildTourTip', 'tourIntro', 'buildTourIntro', 'choicesFor', 'notesFor', 'noteKey', 'withoutPatches', 'hasPatches', 'splitPatches', 'parsePatch', 'markLabel', 'noteTarget', 'isLargeFile', 'diffFiles', 'isSafeSha', 'buildDiff'];
const { SC_LOGO, SC_DECISIONS, SC_MODE_NAME, doneInfo, parseLocation, parsePayload, stateFor, isNewer, progress, buildExport, buildCard, buildPanelList, buildFilterBar, groupItems, displayOrder, SC_DONE_REASON, threadLinks, richText, renderMarkdown, effective, visibleItems, step, rowsFor, hasRevise, phaseOf, statusOf, publishedSummary, submitLock, buildYourReview, emptyPanel, tourSteps, tourKey, buildTourTip, tourIntro, buildTourIntro, choicesFor, notesFor, noteKey, withoutPatches, hasPatches, splitPatches, parsePatch, markLabel, noteTarget, isLargeFile, diffFiles, isSafeSha, buildDiff } =
  new Function(`${source}\nreturn { ${NAMES.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')} };`)();

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
  assert.equal(r.decisions.G.decision, null, 'a decision on the old draft does not carry over to a new one');
  assert.equal(stateFor(payload(), s).decisions.G.decision, 'reply', 'an unchanged draft keeps its decision');
});

test('a re-push of the final round asks again for a reply whose text changed', () => {
  const r2 = (text) => payload({ round: 2, published_at: text, items: [{ thread_id: 'T1', comment_id: 11, verdict: 'publish', reply_en: text }, { thread_id: 'T2', comment_id: 22, verdict: 'publish', reply_en: 'Same.' }] });
  const s = stateFor(r2('Done in abc.'), null);
  s.decisions.T1.decision = 'publish';
  s.decisions.T2.decision = 'publish';
  const r = stateFor(r2('Done in abc. Also removed the old helper.'), s);
  assert.deepEqual(r.decisions.T1, { decision: null, note: '', reply: 'Done in abc. Also removed the old helper.', replyEdited: false });
  assert.equal(r.decisions.T2.decision, 'publish');
  assert.equal(buildExport(r, 'now'), null, 'nothing can be sent until the new text is approved');
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
  assert.match(html, /class="sc-card-head"><svg [^>]*class="sc-logo" aria-hidden="true"/);
  assert.ok(!html.includes('sc-mark'), 'the old SC badge is gone');
  assert.match(html, /class="sc-card-head"[\s\S]*Second Chair[\s\S]*proposes[\s\S]*sc-label sc-v-fix">Fix/);
  assert.match(html, /class="sc-foryou"[\s\S]*For you[\s\S]*never posted[\s\S]*<code>foo\(\)<\/code>/);
  assert.ok(html.includes('change &lt;x&gt;'), 'reviewer text is escaped');
  assert.match(html, /data-sc-act="edit"[^>]*>✎ Edit<\/button>[\s\S]*class="sc-reply-box"/);
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
  assert.ok(html.includes('Comment · stays in your draft review'));
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

test('markdown is cleaned of data attributes, styles, forms and form controls', () => {
  // DOMPurify needs a real DOM, so this checks the settings; the smoke test checks the output in Chromium.
  let seen;
  globalThis.marked = { parse: (t) => t };
  globalThis.DOMPurify = { sanitize: (html, cfg) => { seen = cfg; return html; } };
  try {
    renderMarkdown('text');
    assert.equal(seen?.ALLOW_DATA_ATTR, false);
    for (const tag of ['style', 'form', 'button', 'textarea', 'select', 'input']) assert.ok(seen.FORBID_TAGS.includes(tag), tag);
    assert.ok(seen.FORBID_ATTR.includes('style'));
    assert.ok(seen.FORBID_ATTR.includes('class'));
  } finally {
    delete globalThis.marked;
    delete globalThis.DOMPurify;
  }
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
  assert.ok(buildCard(s, s.payload.items[0], 'panel').includes('Comment · stays in your draft review'));
  assert.ok(buildCard(s, s.payload.items[1], 'panel').includes('Review body · added to your review'));
  assert.match(parsePayload(JSON.stringify(review({ mode: 'other' }))).error, /Unknown mode/);
  assert.match(parsePayload(JSON.stringify(review({ round: 3 }))).error, /Unknown round/);
});

test('under its own pending comment a review card does not repeat the text, until it differs from GitHub', () => {
  const s = stateFor(review(), null);
  const c1 = s.payload.items[0];
  const inline = buildCard(s, c1, 'inline');
  assert.ok(inline.includes('Comment above · stays in your draft review'));
  assert.ok(!inline.includes('sc-reply-box') && !inline.includes('A finding.'));
  assert.match(inline, /data-sc-act="edit"[^>]*>✎ Edit<\/button>/);
  assert.ok(buildCard(s, c1, 'panel').includes('A finding.'));
  assert.match(buildCard(s, c1, 'inline', { editing: true }), /<textarea class="sc-reply"/);
  s.decisions.C1.reply = 'Mine.';
  s.decisions.C1.replyEdited = true;
  assert.match(buildCard(s, c1, 'inline'), /Comment · stays in your draft review[\s\S]*sc-reply-box[\s\S]*Mine\./);
  const r = stateFor(review({ items: [{ thread_id: 'C', comment_id: 5, verdict: 'revise', origin: 'earlier', original_en: 'old words', reply_en: 'new words', path: 'a.md', line: 1 }] }), null);
  assert.match(buildCard(r, r.payload.items[0], 'inline'), /sc-reply-box[\s\S]*new words/);
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

test('review round 2 offers Keep, Revise and Drop, and a reply-mode export says so', () => {
  const s = stateFor(review({ round: 2 }), null);
  assert.deepEqual([...buildCard(s, s.payload.items[0], 'inline').matchAll(/data-sc-act="decide"[^>]*data-sc-val="([a-z]+)"/g)].map((m) => m[1]), ['post', 'revise', 'drop']);
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
  r2.sentVia = 'server';
  assert.equal(doneInfo(r2), null, 'with a server, the agent\'s close ends the work');
  r2.sentVia = 'clipboard';
  assert.deepEqual(doneInfo(r2), { at: 's2', reason: 'final-sent' });
  const closed = stateFor(payload({ published_at: 't1', closed_at: 'c1' }), null);
  assert.deepEqual(doneInfo(closed), { at: 'c1', reason: 'closed' });
  const marked = stateFor(payload({ published_at: 't1' }), null);
  marked.doneAt = 'm1';
  assert.deepEqual(doneInfo(marked), { at: 'm1', reason: 'marked' });
  const review2 = stateFor(review({ round: 2, published_at: 't3' }), null);
  review2.sentAt = 's3';
  review2.sentVia = 'clipboard';
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
  assert.ok(!html.includes('data-sc-act="edit"'));
  assert.ok(html.includes('Will do.'));
  assert.match(html, /Decision:<\/span> <b>Fix<\/b>/);
  s.decisions.T1.decision = null;
  assert.match(buildCard(s, s.payload.items[0], 'inline', { readOnly: true }), /Decision:<\/span> <b>none<\/b>/);
});

test('a stored state whose final round was sent stays past decide without the server', () => {
  const sent = (via) => JSON.parse(JSON.stringify({ ...stateFor(payload({ round: 2, published_at: 't2' }), null), sentAt: 's2', sentVia: via }));
  assert.equal(phaseOf(sent('server')), 'publishing', 'the cards stay hidden until the agent closes');
  assert.equal(phaseOf(sent('clipboard')), 'done');
  assert.equal(doneInfo(sent('clipboard')).reason, 'final-sent');
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
  assert.equal(stateFor(payload({ published_at: 'x' }), s).sentVia ?? null, null);
});

test('moving and counting follow the panel order, not the payload order', () => {
  const items = [{ thread_id: 'A', path: 'x' }, { thread_id: 'B', path: 'y' }, { thread_id: 'C', path: 'x' }, { thread_id: 'G' }];
  assert.deepEqual(displayOrder(items).map((i) => i.thread_id), ['G', 'A', 'C', 'B']);
  assert.equal(step(displayOrder(items), 'A', 1), 'C');
});

test('the mark is one inline SVG in the text colour, with no old SC badge', () => {
  assert.match(SC_LOGO, /^<svg [^>]*viewBox="0 0 16 16"[^>]*stroke="currentColor"[^>]*class="sc-logo" aria-hidden="true">/);
  assert.ok(!source.includes('sc-mark'));
  assert.ok(source.includes('toggle.setAttribute(\'aria-label\', \'Second Chair\')'), 'the pill button has an accessible name');
  assert.equal(source.split('${SC_LOGO}').length - 1, 4, 'pill (twice), panel header and popup header use the constant');
  const s = stateFor(payload(), null);
  s.decisions.T1.decision = 'fix'; s.payload.items[0].auto = true;
  assert.ok(buildCard(s, s.payload.items[0], 'inline', { expanded: false }).includes(SC_LOGO), 'the compact line carries the mark');
});

const at = (round, over = {}) => stateFor(payload({ round, ...over }), null);
const decideAll = (s, key) => { for (const it of s.payload.items) s.decisions[it.thread_id].decision = key; return s; };

test('phaseOf walks a round from decide to waiting, publishing and done', () => {
  assert.equal(phaseOf(null), 'empty');
  const s1 = decideAll(at(1), 'reply');
  assert.equal(phaseOf(s1), 'decide');
  s1.sentAt = 't'; s1.sentVia = 'server';
  assert.equal(phaseOf(s1), 'waiting');
  const s2 = decideAll(at(2), 'publish');
  s2.sentAt = 't'; s2.sentVia = 'server';
  assert.equal(phaseOf(s2), 'publishing');
  s2.payload.closed_at = 'c';
  assert.equal(phaseOf(s2), 'done');
});

test('a final send with Revise waits for a new round 2, also offline', () => {
  const s = decideAll(at(2), 'publish');
  s.decisions.T1.decision = 'revise'; s.decisions.T1.note = 'shorter';
  assert.equal(hasRevise(s), true);
  s.sentAt = 't'; s.sentVia = 'server';
  assert.equal(phaseOf(s), 'waiting');
  s.sentVia = 'clipboard';
  assert.equal(phaseOf(s), 'waiting');
  assert.equal(doneInfo(s), null);
});

test('an offline final send is done in this browser', () => {
  const s = decideAll(at(2), 'publish');
  s.sentAt = 't'; s.sentVia = 'clipboard';
  assert.equal(phaseOf(s), 'done');
});

test('the status line names whose turn it is', () => {
  const s = at(1);
  assert.equal(statusOf(s, 'decide').who, 'you');
  assert.match(statusOf(s, 'decide').text, /^Your turn\. .*Nothing is posted yet\.$/);
  assert.equal(statusOf(s, 'decide').warn, null);
  assert.match(statusOf(at(2), 'decide').text, /Only Publish posts/);
  const r = stateFor(review(), null);
  assert.match(statusOf(r, 'decide').text, /draft that only you can see/);
  assert.match(statusOf(r, 'decide').warn, /Do not submit the review on GitHub yet/);
  assert.match(statusOf(r, 'waiting').warn, /Do not submit/);
  s.sentAt = '2026-10-07T08:09:00Z';
  assert.equal(statusOf(s, 'waiting').who, 'agent');
  assert.match(statusOf(s, 'waiting').text, /^Agent's turn\. It makes the fixes .* Sent /);
  assert.match(statusOf(s, 'waiting', { pickedUpAt: '2026-10-07T08:09:20Z' }).text, /The agent picked up your decisions at /);
  const rev = decideAll(at(2), 'publish');
  rev.decisions.T1.decision = 'revise';
  assert.match(statusOf(rev, 'waiting').text, /new versions you asked for/);
  assert.match(statusOf(decideAll(at(2), 'publish'), 'publishing').text, /pushes the commits and posts/);
  const rp = stateFor(review({ round: 2 }), null);
  rp.submit = 'COMMENT';
  assert.match(statusOf(rp, 'publishing').text, /updates your draft review on GitHub\. Then it submits it as Comment\./);
  assert.equal(statusOf(s, 'done', { published: { items: {} } }).who, null);
});

test('publishedSummary counts what reached GitHub', () => {
  const s = decideAll(at(2), 'publish');
  s.decisions.G.decision = 'hold';
  assert.equal(publishedSummary(s, { items: { T1: { action: 'replied', url: 'u' } } }), 'Posted 1 reply. 1 not posted.');
  assert.equal(publishedSummary(s, { items: {} }), 'Closed. Nothing was posted.');
  const r = stateFor(review({ round: 2 }), null);
  assert.match(publishedSummary(r, { items: { C1: { action: 'kept' } } }), /^Your review is ready and still a draft: submit it on GitHub, Files changed, Review changes, Submit\.$/);
  assert.equal(publishedSummary(r, { items: { REVIEW: { action: 'submitted', event: 'REQUEST_CHANGES' } } }), 'Submitted as Request changes.');
});

test('a reply the agent rewrote clears the old decision and its note', () => {
  const s = at(2);
  s.decisions.T1 = { decision: 'revise', note: 'shorter', reply: 'Will do.', replyEdited: false };
  const p = payload({ round: 2, published_at: 'p2' });
  p.items[0] = { ...p.items[0], reply_en: 'Done.' };
  const next = stateFor(p, s);
  assert.deepEqual([next.decisions.T1.decision, next.decisions.T1.note], [null, '']);
});

test('a send through the clipboard tells the user to paste it to the agent', () => {
  const s = decideAll(at(1), 'reply');
  s.sentAt = '2026-10-07T08:09:00Z'; s.sentVia = 'clipboard';
  assert.match(statusOf(s, 'waiting').text, /on the clipboard\. Paste them to the agent\./);
  s.sentVia = 'server';
  assert.doesNotMatch(statusOf(s, 'waiting').text, /clipboard/);
});

test('a reload of the same publication keeps what the page knows about its sends', () => {
  const s = stateFor(payload({ published_at: 'p1' }), null);
  Object.assign(s, { sentAt: 's', sentVia: 'server', lastExport: 'e1', resendOf: null });
  const same = stateFor(payload({ published_at: 'p1', closed_at: 'c' }), s);
  assert.equal(same.lastExport, 'e1');
  s.resendOf = 's0';
  assert.equal(stateFor(payload({ published_at: 'p1' }), s).resendOf, 's0');
  const next = stateFor(payload({ published_at: 'p2' }), s);
  assert.deepEqual([next.lastExport, next.resendOf], [null, null]);
});

const review2 = (items) => stateFor(payload({ mode: 'review', round: 2, items }), null);
const BODY = (over = {}) => ({ thread_id: 'BODY', comment_id: null, verdict: 'post', reply_en: 'Summary', ...over });
const C1 = { thread_id: 'C1', comment_id: 1, path: 'a.js', line: 2, verdict: 'post', reply_en: 'c' };

test('a body that needs the submit locks Leave as draft', () => {
  const s = review2([BODY({ needs_submit: true }), C1]);
  s.decisions.BODY.decision = 'post'; s.decisions.C1.decision = 'post';
  assert.match(submitLock(s), /GitHub adds this body only with the submit/);
  s.submit = 'COMMENT';
  assert.equal(submitLock(s), null);
  s.decisions.BODY.decision = 'drop'; s.submit = null;
  assert.equal(submitLock(s), null);
});

test('Request changes needs a body, and Comment needs a body or a kept comment', () => {
  const s = review2([BODY(), C1]);
  s.decisions.BODY.decision = 'drop'; s.decisions.C1.decision = 'post'; s.submit = 'REQUEST_CHANGES';
  assert.match(submitLock(s), /Request changes needs a review body/);
  s.submit = 'COMMENT';
  assert.equal(submitLock(s), null);
  s.decisions.C1.decision = 'drop';
  assert.match(submitLock(s), /Comment needs a review body or at least one kept comment/);
  s.submit = 'APPROVE';
  assert.equal(submitLock(s), null);
  assert.equal(submitLock(stateFor(payload(), null)), null, 'respond mode has no submit');
});

test('the export carries the submit only in review round 2', () => {
  const s = review2([BODY(), C1]);
  s.decisions.BODY.decision = 'post'; s.decisions.C1.decision = 'post'; s.submit = 'APPROVE';
  assert.equal(buildExport(s, 'now').submit, 'APPROVE');
  s.submit = undefined;
  assert.equal(buildExport(s, 'now').submit, null);
  s.submit = 'COMMENT';
  s.decisions.BODY.decision = 'post';
  const locked = review2([BODY({ needs_submit: true }), C1]);
  locked.decisions.BODY.decision = 'post'; locked.decisions.C1.decision = 'post';
  assert.equal(buildExport(locked, 'now'), null, 'a locked send exports nothing');
  const r1 = stateFor(payload(), null);
  for (const it of r1.payload.items) r1.decisions[it.thread_id].decision = 'manual';
  assert.equal('submit' in buildExport(r1, 'now'), false);
});

test('the submit choice survives a reload of the same round and resets on a new one', () => {
  const s = review2([BODY(), C1]);
  s.submit = 'COMMENT';
  assert.equal(stateFor(s.payload, s).submit, 'COMMENT');
  assert.equal(stateFor({ ...s.payload, round: 1 }, s).submit, null);
});

test('Your review holds the body card and, in round 2, the submit choice with the agent suggestion outlined', () => {
  const s = review2([BODY({ suggested_submit: 'APPROVE' }), C1]);
  const h = buildYourReview(s, {});
  assert.match(h, /Your review/);
  assert.match(h, /data-sc-card="BODY"/);
  assert.match(h, /When the agent has applied this:/);
  assert.match(h, /data-sc-act="submit" data-sc-val=""[^>]*>Leave as draft/);
  assert.match(h, /class="sc-btn sc-on"[^>]*data-sc-act="submit" data-sc-val=""/, 'Leave as draft is chosen by default');
  assert.match(h, /class="sc-btn sc-suggested"[^>]*data-sc-val="APPROVE"/);
  s.submit = 'COMMENT';
  assert.match(buildYourReview(s, {}), /class="sc-btn sc-on"[^>]*data-sc-val="COMMENT"/);
  assert.doesNotMatch(buildYourReview(stateFor(payload({ mode: 'review', items: [BODY(), C1] }), null), {}), /When the agent has applied this/);
});

test('in review mode the body leaves the file list for the Your review block', () => {
  const s = review2([BODY(), C1]);
  assert.doesNotMatch(buildPanelList(s, null, 'all', () => ({})), /data-sc-item="BODY"/);
  assert.match(buildPanelList(stateFor(payload(), null), null, 'all', () => ({})), /data-sc-item="G"/);
});

test('no control is a link, so page code cannot take its clicks', () => {
  const s = stateFor(payload(), null);
  const html = buildCard(s, s.payload.items[0], 'panel', { position: '1 of 2', expanded: true })
    + buildCard(s, s.payload.items[0], 'inline', { position: '1 of 2', sent: true })
    + buildCard(s, s.payload.items[0], 'inline', { position: '1 of 2', expanded: true, sent: true, editing: true })
    + buildPanelList(s, 'T1', 'all', () => ({ panelOpen: true })) + buildFilterBar(s, 'all');
  assert.equal(/<a [^>]*href="#"/.test(html), false);
  assert.match(html, /<button type="button" class="sc-link"[^>]*data-sc-act="edit"/);
  assert.match(html, /<a href="https:\/\/github.com\/acme\/w\/pull\/7\/files#r11">in files<\/a>/, 'the link to the files tab stays a real link');
});

test('the caption says when the text goes out', () => {
  const s = stateFor(payload(), null);
  assert.match(buildCard(s, s.payload.items[0], 'inline', { expanded: true }), /Draft reply · posted only if you approve it in round 2/);
  const r2 = stateFor(payload({ round: 2 }), null);
  assert.match(buildCard(r2, r2.payload.items[0], 'inline', { expanded: true }), /Reply · posted when you choose Publish/);
});

test('editing shows the textarea with Preview and a hint, and an edited reply offers Undo my edits', () => {
  const s = stateFor(payload(), null);
  const editing = buildCard(s, s.payload.items[0], 'inline', { expanded: true, editing: true });
  assert.match(editing, /<textarea class="sc-reply"/);
  assert.match(editing, /data-sc-act="preview"/);
  assert.match(editing, /Your text replaces the agent&#39;s\. Esc to finish\./);
  assert.doesNotMatch(buildCard(s, s.payload.items[0], 'inline', { expanded: true }), /data-sc-act="undo"/);
  s.decisions.T1.reply = 'mine'; s.decisions.T1.replyEdited = true;
  assert.match(buildCard(s, s.payload.items[0], 'inline', { expanded: true }), /data-sc-act="undo"/);
  assert.doesNotMatch(buildCard(s, s.payload.items[0], 'inline', { expanded: true, readOnly: true }), /data-sc-act="(edit|undo)"/);
});

test('the shown text starts editing when clicked, but not on a read-only card', () => {
  const s = stateFor(payload(), null);
  assert.match(buildCard(s, s.payload.items[0], 'inline', { expanded: true }), /<div class="sc-preview" data-sc-act="edit" data-sc-id="T1"/);
  assert.doesNotMatch(buildCard(s, s.payload.items[0], 'inline', { expanded: true, readOnly: true }), /sc-preview" data-sc-act/);
});

test('a review comment folded on GitHub says to decide it here', () => {
  const s = stateFor(review(), null);
  assert.match(buildPanelList(s, null, 'all', () => ({ hidden: true })), /folded on GitHub · decide here/);
  assert.match(buildPanelList(stateFor(payload(), null), null, 'all', () => ({ hidden: true })), /not loaded on page/);
});

test('each screen has a short tour that points at Second Chair, never at GitHub', () => {
  const counts = { 'reply:1': 7, 'reply:2': 4, 'review:1': 8, 'review:2': 4 };
  for (const [key, n] of Object.entries(counts)) {
    const [mode, round] = key.split(':');
    const steps = tourSteps(mode, Number(round));
    assert.equal(steps.length, n, key);
    for (const st of steps) {
      assert.ok(st.at === 'card' || st.at === 'panel', `${key}: ${st.text}`);
      assert.ok(st.text.length <= 150, `${key}: short text: ${st.text}`);
      assert.ok(st.text.split(/[.!?](\s|$)/).filter((x) => x && x.trim()).length <= 2, `${key}: two sentences at most: ${st.text}`);
      assert.doesNotMatch(st.sel ?? '', /js-|discussion_r|gh-/);
    }
  }
  assert.match(tourSteps('reply', 1)[0].text, /Nothing is posted yet/);
  assert.equal(tourSteps('reply', 1).at(-1).sel, '[data-sc-act=export]');
  assert.ok(tourSteps('review', 1).some((st) => /Submit/.test(st.text)), 'review warns about GitHub\'s Submit');
  assert.ok(tourSteps('review', 2).some((st) => st.sel === '.sc-submit'));
  assert.deepEqual(tourSteps('other', 1), []);
  assert.equal(tourKey('review', 2), 'sc:tour:review:2');
});

test('every tour shows the yellow box and a note for the agent with an example', () => {
  for (const [mode, round] of [['reply', 1], ['review', 1]]) {
    const box = tourSteps(mode, round).find((st) => st.sel === '.sc-foryou');
    assert.ok(box && /yellow box/.test(box.text) && /never posted/.test(box.text), `${mode}:${round} explains the yellow box`);
  }
  for (const [mode, round] of [['reply', 1], ['reply', 2], ['review', 1], ['review', 2]]) {
    const note = tourSteps(mode, round).find((st) => st.sel === '.sc-note');
    assert.ok(note && /For example: "[^"]+"/.test(note.text), `${mode}:${round} gives an example note`);
  }
});

test('the review tour says when Approve or Request changes comes, and what the main comment is', () => {
  assert.match(tourIntro('review', 1, false).text, /two rounds/);
  const body = tourSteps('review', 1).find((st) => st.sel === '.sc-yourreview');
  assert.match(body.text, /top of your review/);
  assert.match(body.text, /round 2/);
  assert.match(tourSteps('review', 1).at(-1).text, /Approve, Comment or Request changes/);
  assert.match(tourSteps('review', 2).find((st) => st.sel === '.sc-submit').text, /Approve, Comment or Request changes/);
});

test('the tour first asks whether to start, and welcomes a first-time user', () => {
  assert.match(tourIntro('reply', 1, true).title, /Welcome to Second Chair/);
  assert.doesNotMatch(tourIntro('reply', 1, false).title, /Welcome/);
  assert.match(tourIntro('review', 1, false).text, /draft/);
  assert.match(tourIntro('review', 2, false).title, /Round 2/);
  assert.equal(tourIntro('other', 1, true), null);
  const h = buildTourIntro(tourIntro('reply', 1, true), 7);
  assert.match(h, /Welcome to Second Chair/);
  assert.match(h, /data-sc-act="tournext"[^>]*>Show me/);
  assert.match(h, /data-sc-act="tourskip"[^>]*>Not now/);
  assert.match(h, /7 steps/);
  assert.match(h, /\? in the panel/);
  assert.doesNotMatch(h, / of 7/);
});

test('the tour bubble says where you are and how to move on', () => {
  const h = buildTourTip({ text: 'The agent\'s proposal.' }, 0, 7);
  assert.match(h, /The agent&#39;s proposal\./);
  assert.match(h, /1 of 7/);
  assert.match(h, /data-sc-act="tourskip"/);
  assert.match(h, /data-sc-act="tournext"[^>]*>Next/);
  assert.doesNotMatch(h, /data-sc-act="tourback"/, 'no Back on the first step');
  const last = buildTourTip({ text: 'Send.' }, 6, 7);
  assert.match(last, /data-sc-act="tourback"/);
  assert.match(last, /data-sc-act="tournext"[^>]*>Done/);
  assert.equal(/<a [^>]*href="#"/.test(h + last), false);
});

test('the empty panel says how to start', () => {
  const h = emptyPanel({ repo: 'acme/w', number: 7 }, true);
  assert.match(h, /No proposals for this pull request yet/);
  assert.match(h, /\/second-chair:respond 7/); assert.match(h, /\/second-chair:review 7/);
  assert.doesNotMatch(h, /sc-paste/);
  const down = emptyPanel({ repo: 'acme/w', number: 7 }, false);
  assert.match(down, /second-chair start/);
  assert.match(down, /sc-paste/);
});

test('rows show the file and line, not general, when an item has no author', () => {
  const s = stateFor(payload({ mode: 'review', items: [{ thread_id: 'C1', comment_id: 1, path: 'src/a.js', line: 11, verdict: 'post', reply_en: 'x' }] }), null);
  const html = buildPanelList(s, null, 'all', () => ({}));
  assert.doesNotMatch(html, /general/);
  assert.match(html, /class="sc-row-meta">line 11/);
  assert.match(buildPanelList(stateFor(payload(), null), null, 'all', () => ({})), /class="sc-row-meta">general/, 'a general item still says so');
});

test('the mode names follow the commands, and commits show short', () => {
  assert.deepEqual(SC_MODE_NAME, { reply: 'Respond', review: 'Review' });
  const p = payload({ round: 2 });
  p.items[0] = { ...p.items[0], verdict: 'publish', commits: ['854a392a366d20777f0dae5f670d56b215cbd19e'] };
  const s = stateFor(p, null);
  assert.match(buildPanelList(s, null, 'all', () => ({})), /commit <code title="854a392a366d20777f0dae5f670d56b215cbd19e">854a392<\/code>/);
  assert.match(buildCard(s, s.payload.items[0], 'inline', { expanded: true }), /Commits: <code title="854a392a[0-9a-f]+">854a392<\/code>/);
});

test('a card from an earlier pass says so and folds the earlier text', () => {
  const s = stateFor(payload({ mode: 'review', items: [{ thread_id: 'C1', comment_id: 1, path: 'a', line: 1, verdict: 'post', origin: 'earlier', original_en: 'old', reply_en: 'new' }] }), null);
  const h = buildCard(s, s.payload.items[0], 'inline', { expanded: true });
  assert.match(h, /<b>Second Chair<\/b> <span class="sc-muted">earlier pass<\/span>/);
  assert.match(h, /<summary>Earlier text<\/summary>/);
});

test('the export names the publication it answers', () => {
  const s = stateFor(payload({ published_at: 'p7' }), null);
  for (const it of s.payload.items) s.decisions[it.thread_id].decision = 'manual';
  assert.equal(buildExport(s, 'now').published_at, 'p7');
});

test('a Revise clears on the new version, also when the user had edited the reply', () => {
  const s = stateFor(payload({ round: 2, published_at: 'p1' }), null);
  s.decisions.T1 = { decision: 'revise', note: 'shorter', reply: 'My own words.', replyEdited: true };
  const p = payload({ round: 2, published_at: 'p2' });
  p.items[0] = { ...p.items[0], reply_en: 'Shorter.' };
  const next = stateFor(p, s);
  assert.deepEqual(next.decisions.T1, { decision: null, note: '', reply: 'Shorter.', replyEdited: false });
});

test('the summary counts only the threads of this round', () => {
  const s = decideAll(at(2), 'publish');
  assert.equal(publishedSummary(s, { items: { T1: { action: 'replied' }, OLD1: { action: 'replied' }, OLD2: { action: 'replied' } } }), 'Posted 1 reply. 1 not posted.');
});

test('the derived change key is no button, no number key and no filter option', () => {
  const p = { ...payload({ round: 2 }), items: [{ thread_id: 'T1', comment_id: 11, verdict: 'publish', reply_en: 'x' }] };
  assert.deepEqual(choicesFor(p).map((b) => b.key), ['publish', 'revise', 'hold', 'manual']);
  const s = stateFor(p, null);
  assert.doesNotMatch(buildCard(s, p.items[0], 'inline', {}), /data-sc-val="change"/);
  assert.doesNotMatch(buildFilterBar(s, 'all'), /d:change/);
});

const SA = 'a'.repeat(40);
const SB = 'b'.repeat(40);
const r2 = (over = {}) => ({
  tool: 'second-chair', kind: 'proposals', repo: 'acme/w', pr: 7, round: 2, head: SB, published_at: 'p1',
  items: [
    { thread_id: 'T1', comment_id: 11, verdict: 'publish', reply_en: 'Fixed in a.', commits: [SA] },
    { thread_id: 'T2', comment_id: 22, verdict: 'publish', reply_en: 'Fixed in b.', commits: [SB] },
  ],
  changes: { base: 'c'.repeat(40), head: SB, add: 2, del: 0, commits: [{ sha: SA, subject: 'a', add: 1, del: 0, files: [{ path: 'f', add: 1, del: 0, binary: false }] }, { sha: SB, subject: 'b', add: 1, del: 0, files: [{ path: 'g', add: 1, del: 0, binary: false }] }], range: { files: [] } },
  ...over,
});
const noteA = { sha: SA, path: 'f', view: 'commit', lines: [{ side: 'new', n: 3 }], text: 'Not like this.' };

test('a note on a cited commit makes the reply Change code, and deleting it brings the choice back', () => {
  const s = stateFor(r2(), null);
  s.decisions.T1.decision = 'publish';
  s.codeNotes[noteKey(noteA)] = noteA;
  assert.deepEqual(effective(s, s.payload.items[0]), { decision: 'change', auto: false });
  assert.deepEqual(effective(s, s.payload.items[1]), { decision: null, auto: false });
  assert.equal(notesFor(s, s.payload.items[0]).length, 1);
  assert.equal(hasRevise(s), true);
  delete s.codeNotes[noteKey(noteA)];
  assert.deepEqual(effective(s, s.payload.items[0]), { decision: 'publish', auto: false });
});

test('the export carries the code notes with the threads they lock', () => {
  const s = stateFor(r2(), null);
  s.decisions.T2.decision = 'hold';
  s.codeNotes[noteKey(noteA)] = noteA;
  const out = buildExport(s, 'now');
  assert.deepEqual(out.decisions.map((d) => [d.thread_id, d.decision]), [['T1', 'change'], ['T2', 'hold']]);
  assert.deepEqual(out.code_notes, [{ ...noteA, thread_ids: ['T1'] }]);
  const plain = stateFor(r2({ changes: undefined }), null);
  plain.decisions.T1.decision = 'hold';
  plain.decisions.T2.decision = 'hold';
  assert.equal('code_notes' in buildExport(plain, 'now'), false);
});

test('a new publication drops the notes and asks again for a reply that was Change code or cites new commits', () => {
  const s = stateFor(r2(), null);
  s.decisions.T1.decision = 'publish';
  s.decisions.T2.decision = 'publish';
  s.codeNotes[noteKey(noteA)] = noteA;
  const same = stateFor(r2(), s);
  assert.equal(Object.keys(same.codeNotes).length, 1, 'the same publication keeps the notes');
  const next = r2({ published_at: 'p2' });
  const n = stateFor(next, s);
  assert.deepEqual(n.codeNotes, {});
  assert.equal(n.decisions.T1.decision, null, 'Change code was answered by the new publication');
  assert.equal(n.decisions.T2.decision, 'publish', 'an untouched reply keeps its choice');
  const moved = r2({ published_at: 'p3' });
  moved.items[1] = { ...moved.items[1], commits: [SA] };
  assert.equal(stateFor(moved, n).decisions.T2.decision, null, 'a reply that now cites other commits is decided again');
});

test('withoutPatches strips patches and hasPatches tells', () => {
  const p = r2();
  p.changes.commits[0].files[0].patch = '@@ -1 +1 @@\n+x\n';
  assert.equal(hasPatches(p), true);
  assert.equal(hasPatches(withoutPatches(p)), false);
  assert.equal(withoutPatches(p).changes.commits[0].files[0].add, 1);
});

test('round 2 waiting says the agent changes the code when a note was sent', () => {
  const s = stateFor(r2(), null);
  s.codeNotes[noteKey(noteA)] = noteA;
  s.sentAt = 'now';
  assert.match(statusOf(s, 'waiting').text, /changes the code you noted/);
});

test('a payload with patches is split, so the stored state never holds them', () => {
  const p = r2();
  p.changes.commits[0].files[0].patch = '@@ -1 +1 @@\n+x\n';
  const { payload, patches } = splitPatches(p);
  assert.equal(hasPatches(payload), false);
  assert.equal(patches.commits[0].files[0].patch, '@@ -1 +1 @@\n+x\n');
  assert.equal(splitPatches(r2()).patches, null);
  assert.equal(JSON.stringify(stateFor(payload, null)).includes('+x'), false);
});

test('parsePatch numbers old and new lines and keeps the no-newline marker', () => {
  const lines = parsePatch('@@ -9,3 +9,4 @@ class X\n a\n-b\n+B\n+C\n c\n\\ No newline at end of file\n');
  assert.deepEqual(lines.map((l) => [l.kind, l.old, l.new, l.text]), [
    ['hunk', null, null, '@@ -9,3 +9,4 @@ class X'], ['ctx', 9, 9, 'a'], ['del', 10, null, 'b'], ['add', null, 10, 'B'], ['add', null, 11, 'C'], ['ctx', 11, 12, 'c'], ['meta', null, null, '\\ No newline at end of file'],
  ]);
  assert.deepEqual(parsePatch(''), []);
});

test('markLabel joins runs per side', () => {
  assert.equal(markLabel([{ side: 'new', n: 42 }, { side: 'new', n: 40 }, { side: 'new', n: 41 }, { side: 'old', n: 12 }]), 'L40–42, old L12');
  assert.equal(markLabel([{ side: 'new', n: 3 }, { side: 'new', n: 5 }]), 'L3, L5');
  assert.equal(markLabel([]), '');
});

test('a range note goes to the newest commit that changed the file', () => {
  const ch = { range: { files: [{ path: 'f', commits: ['a'.repeat(40), 'b'.repeat(40)] }] } };
  assert.equal(noteTarget(ch, { kind: 'range' }, 'f'), 'b'.repeat(40));
  assert.equal(noteTarget(ch, { kind: 'commit', sha: 'a'.repeat(40) }, 'f'), 'a'.repeat(40));
});

test('large files fold by lines or by size', () => {
  assert.equal(isLargeFile({ add: 401, del: 0, patch: '' }), true);
  assert.equal(isLargeFile({ add: 1, del: 0, patch: `@@ -0,0 +1 @@\n+${'x'.repeat(200001)}\n` }), true);
  assert.equal(isLargeFile({ add: 10, del: 10, patch: '@@' }), false);
});

test('isSafeSha guards the copied git command', () => {
  assert.equal(isSafeSha('a'.repeat(40)), true);
  assert.equal(isSafeSha('a'.repeat(39) + ';'), false);
});

const SH = 'b'.repeat(40);
const diffState = () => {
  const s = stateFor(r2(), null);
  return s;
};
const patches = () => ({
  published_at: 'p1',
  commits: [
    { sha: 'a'.repeat(40), subject: 'a', add: 1, del: 0, files: [{ path: 'f', add: 1, del: 0, binary: false, patch: '@@ -1 +1,2 @@\n x\n+<script>alert(1)</script>\n' }] },
    { sha: SH, subject: 'b', add: 1, del: 0, files: [{ path: 'g', add: 0, del: 0, binary: false, patch: '' }, { path: 'logo.png', add: 0, del: 0, binary: true }] },
  ],
  range: { files: [{ path: 'f', add: 1, del: 0, binary: false, commits: ['a'.repeat(40)], patch: '@@ -1 +1,2 @@\n x\n+<script>alert(1)</script>\n' }] },
});
const popup = (over = {}) => ({ view: { kind: 'range' }, folded: {}, editing: null, draftText: '', draftLines: [], warn: null, ...over });

test('the popup escapes patch text and shows the range by default', () => {
  const html = buildDiff(diffState(), patches(), popup(), false);
  assert.match(html, /Changes not pushed yet/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /data-sc-act="dclose"/);
  assert.match(html, /class="sc-diff-backdrop"/);
});

test('the popup on one commit shows its files, an empty file and a binary file', () => {
  const html = buildDiff(diffState(), patches(), popup({ view: { kind: 'commit', sha: SH } }), false);
  assert.match(html, /Commit bbbbbbb · b/);
  assert.match(html, /No content changes/);
  assert.match(html, /Binary file, not shown/);
});

test('without patches the popup shows the counts and the git command', () => {
  const html = buildDiff(diffState(), null, popup(), false);
  assert.match(html, /The diff needs the local server/);
  assert.match(html, /git log -p cccccc/);
});

test('a saved note shows under its file with its marks, and read only hides the controls', () => {
  const s = diffState();
  s.codeNotes[noteKey(noteA)] = noteA;
  const html = buildDiff(s, patches(), popup({ view: { kind: 'commit', sha: 'a'.repeat(40) } }), false);
  assert.match(html, /Not like this\./);
  assert.match(html, /L3/);
  assert.match(html, /data-sc-act="dnote"/);
  assert.doesNotMatch(buildDiff(s, patches(), popup({ view: { kind: 'commit', sha: 'a'.repeat(40) } }), true), /data-sc-act="(dnote|ddelete|dmark)"/);
});
