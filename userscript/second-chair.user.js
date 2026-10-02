// ==UserScript==
// @name         Second Chair
// @namespace    https://github.com/Patras3/second-chair
// @version      0.9.0
// @description  AI prepares. You decide. Your agent's proposal for every review thread, next to it on GitHub.
// @match        https://github.com/*
// @require      https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js
// @require      https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @updateURL    http://127.0.0.1:7788/second-chair.user.js
// @downloadURL  http://127.0.0.1:7788/second-chair.user.js
// @run-at       document-idle
// ==/UserScript==

/* Second Chair userscript.
   An agent writes a proposals payload: one item per review thread, round 1 to decide, round 2 to
   publish. In review mode the items are the comments of the agent's pending review on someone
   else's pull request instead, and you post, revise or drop each one. The script loads it from the local second-chair server (or from the clipboard), shows a card
   under every thread, and sends your decisions back once every thread has one. An item the agent
   marks `auto` counts as decided with its proposal until you pick something else. Pure helpers live
   at top level so the test suite can evaluate this file with `new Function`; the DOM bootstrap at
   the bottom runs only in a browser. */

const SC_TOOL = 'second-chair';
const SC_FINAL_ROUND = 2;
const SC_SERVER = 'http://127.0.0.1:7788';

// Decision buttons per mode and round. `reply` answers the threads on your own pull request; `review`
// decides the comments of a pending review you are about to submit. A decision with `needsNote` counts
// only once the note says what to change. A decision with `posts` puts text on GitHub, so `auto` never
// picks it: the user approves every posted text.
const SC_DECISIONS = {
  reply: {
    1: [
      { key: 'reply', label: 'Reply' },
      { key: 'fix', label: 'Fix' },
      { key: 'pushback', label: 'Push back' },
      { key: 'manual', label: 'Manual' },
    ],
    2: [
      { key: 'publish', label: 'Publish', posts: true },
      { key: 'hold', label: 'Hold' },
      { key: 'manual', label: 'Manual' },
    ],
  },
  review: {
    1: [
      { key: 'post', label: 'Post' },
      { key: 'revise', label: 'Revise', needsNote: true },
      { key: 'drop', label: 'Drop' },
    ],
    2: [
      { key: 'post', label: 'Post', posts: true },
      { key: 'drop', label: 'Drop' },
    ],
  },
};

function modeOf(payload) {
  return payload?.mode ?? 'reply';
}

/** The decision buttons for a payload's mode and round, or undefined when either is unknown. */
function decisionsFor(payload) {
  return SC_DECISIONS[modeOf(payload)]?.[payload?.round];
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Escaped text with `code` spans and line breaks, nothing else. */
function richText(s) {
  return esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
}

/** Markdown as sanitized HTML when marked and DOMPurify are loaded; plain text with code spans otherwise. */
function renderMarkdown(md) {
  const text = String(md ?? '');
  if (!text.trim()) return '';
  const m = typeof marked !== 'undefined' ? marked : null;
  const purify = typeof DOMPurify !== 'undefined' ? DOMPurify : null;
  if (m && purify && typeof purify.sanitize === 'function') {
    return purify.sanitize(m.parse(text, { gfm: true, breaks: false }));
  }
  return `<p>${richText(text)}</p>`;
}

/** An item's text field; `summary` also reads the older `summary_pl` spelling. */
function field(item, name) {
  return item[name] ?? item[`${name}_pl`] ?? '';
}

/** `/owner/name/pull/N[/...]` → { repo, number }; anything else → null. */
function parseLocation(pathname) {
  const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(pathname);
  return m ? { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
}

function storageKey(repo, number) {
  return `sc:${repo}#${number}`;
}

/** Checks a proposals object; returns { payload } or { error } with a message you can act on. */
function checkPayload(p) {
  if (!p || p.tool !== SC_TOOL || p.kind !== 'proposals') return { error: 'Not a second-chair proposals payload ("tool": "second-chair", "kind": "proposals").' };
  if (!/^[^/]+\/[^/]+$/.test(p.repo ?? '') || !Number.isInteger(p.pr)) return { error: 'Missing "repo" or "pr".' };
  if (!SC_DECISIONS[modeOf(p)]) return { error: `Unknown mode: ${p.mode}` };
  if (!decisionsFor(p)) return { error: `Unknown round: ${p.round}` };
  if (!Array.isArray(p.items) || p.items.length === 0) return { error: 'Missing "items".' };
  const seen = new Set();
  for (const it of p.items) {
    if (!it.thread_id) return { error: 'An item has no "thread_id".' };
    if (seen.has(it.thread_id)) return { error: `Duplicate thread_id: ${it.thread_id}` };
    seen.add(it.thread_id);
  }
  return { payload: p };
}

/** Parses pasted text; returns { payload } or { error }. */
function parsePayload(text) {
  let p;
  try {
    p = JSON.parse(String(text).trim());
  } catch (e) {
    return { error: `Not JSON: ${e.message}` };
  }
  return checkPayload(p);
}

/** A fresh state for a payload, keeping decisions from `previous` when it is the same round. */
function stateFor(payload, previous) {
  const sameRound = Boolean(previous && previous.payload && previous.payload.round === payload.round);
  const keep = sameRound ? previous.decisions : {};
  const decisions = {};
  for (const it of payload.items) {
    const old = keep[it.thread_id];
    // A reply you edited survives a re-import; an untouched one takes the agent's new draft.
    decisions[it.thread_id] = old
      ? { decision: old.decision, note: old.note ?? '', reply: old.replyEdited ? old.reply : (it.reply_en ?? ''), replyEdited: Boolean(old.replyEdited) }
      : { decision: null, note: '', reply: it.reply_en ?? '', replyEdited: false };
  }
  // A send answers one publication of the proposals; a new publication needs a new send.
  const samePublication = sameRound && (previous.payload.published_at ?? null) === (payload.published_at ?? null);
  const sentAt = samePublication ? previous.sentAt ?? null : null;
  const doneAt = samePublication ? previous.doneAt ?? null : null;
  const sentVia = samePublication && sentAt ? previous.sentVia ?? null : null;
  return { payload, decisions, sentAt, sentVia, doneAt };
}

/** Why and since when this pull request's triage is over, or null while it is open. */
function doneInfo(state) {
  if (!state) return null;
  const p = state.payload;
  if (p.closed_at) return { at: p.closed_at, reason: 'closed' };
  if (state.doneAt) return { at: state.doneAt, reason: 'marked' };
  if (state.sentAt && p.round === SC_FINAL_ROUND) return { at: state.sentAt, reason: 'final-sent' };
  return null;
}

/** A readable local time; a value that is not a date shows as it came. */
function formatTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

const SC_DONE_REASON = { closed: 'closed', 'final-sent': 'final round sent', marked: 'marked as done' };

/** The banner text for a round that was sent; it names the server only when the server took the decisions. */
function sentNote(state) {
  const when = `Decisions sent ${formatTime(state.sentAt)}.`;
  if (state.sentVia === 'server') return `${when} The agent picks them up from the server; the next round loads here.`;
  if (state.sentVia === 'clipboard') return `${when} They are on the clipboard. Paste them to the agent; the next round loads here.`;
  return when;
}

/** True when the server holds a payload this state has not loaded: a later round, another head, a re-publish or a close. */
function isNewer(serverPayload, state) {
  if (!state) return true;
  const mine = state.payload;
  if (serverPayload.round !== mine.round) {
    // A new review cycle starts again at round 1, so a later publication wins over a higher round number.
    const theirs = serverPayload.published_at ?? null;
    const ours = mine.published_at ?? null;
    return theirs && ours ? theirs > ours : serverPayload.round > mine.round;
  }
  return (serverPayload.head ?? null) !== (mine.head ?? null)
    || (serverPayload.published_at ?? null) !== (mine.published_at ?? null)
    || (serverPayload.closed_at ?? null) !== (mine.closed_at ?? null);
}

/** The decision that counts for an item: yours, or the proposal when the agent marked it `auto` and it posts nothing. */
function effective(state, item) {
  const d = state.decisions[item.thread_id];
  if (d?.decision) return { decision: d.decision, auto: false };
  const b = item.auto && item.verdict ? decisionsFor(state.payload).find((x) => x.key === item.verdict) : null;
  if (b && !b.posts) return { decision: item.verdict, auto: true };
  return { decision: null, auto: false };
}

/** True when the item's decision still waits for a note, as Revise does. */
function missingNote(state, item) {
  const e = effective(state, item);
  const b = decisionsFor(state.payload).find((x) => x.key === e.decision);
  return Boolean(b?.needsNote) && !String(state.decisions[item.thread_id]?.note ?? '').trim();
}

function progress(state) {
  const items = state.payload.items;
  let done = 0;
  let auto = 0;
  for (const it of items) {
    const e = effective(state, it);
    if (e.decision && !missingNote(state, it)) done++;
    if (e.auto) auto++;
  }
  return { done, auto, total: items.length, complete: done === items.length };
}

const SC_FILTERS = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'todo', label: 'To decide', test: (e) => !e.decision },
  { key: 'auto', label: 'Auto', test: (e) => e.auto },
  { key: 'mine', label: 'Mine', test: (e) => e.decision && !e.auto },
];

/** The filter chips for a round: the fixed ones, then one per decision. */
function filtersFor(payload) {
  return [...SC_FILTERS, ...decisionsFor(payload).map((b) => ({ key: `d:${b.key}`, label: b.label, test: (e) => e.decision === b.key }))];
}

function visibleItems(state, filterKey) {
  const f = filtersFor(state.payload).find((x) => x.key === filterKey) ?? SC_FILTERS[0];
  return state.payload.items.filter((it) => f.test(effective(state, it)));
}

/** Items in the order the panel shows them: grouped by file, general first. */
function displayOrder(items) {
  return groupItems(items).flatMap((g) => g.items);
}

/** The next or previous item id among `items`, wrapping around; the first one when nothing is selected. */
function step(items, currentId, delta) {
  if (items.length === 0) return null;
  const i = items.findIndex((it) => it.thread_id === currentId);
  if (i < 0) return items[delta > 0 ? 0 : items.length - 1].thread_id;
  return items[(i + delta + items.length) % items.length].thread_id;
}

/** The export object, or null while a thread is still undecided. */
function buildExport(state, now) {
  if (!progress(state).complete) return null;
  const p = state.payload;
  return {
    tool: SC_TOOL,
    kind: 'decisions',
    mode: modeOf(p),
    repo: p.repo,
    pr: p.pr,
    round: p.round,
    head: p.head ?? null,
    exported_at: now,
    decisions: p.items.map((it) => {
      const d = state.decisions[it.thread_id];
      const e = effective(state, it);
      return {
        thread_id: it.thread_id,
        comment_id: it.comment_id ?? null,
        proposed: it.verdict ?? null,
        decision: e.decision,
        auto: e.auto,
        reply_en: d.reply,
        reply_edited: d.replyEdited,
        note: d.note,
      };
    }),
  };
}

function threadLinks(repo, number, commentId) {
  if (!commentId) return null;
  const base = `https://github.com/${repo}/pull/${number}`;
  return { conversation: `${base}#discussion_r${commentId}`, files: `${base}/files#r${commentId}` };
}

function shortPath(path, line) {
  if (!path) return '';
  const parts = path.split('/');
  return `${parts.length > 2 ? '…/' : ''}${parts.slice(-2).join('/')}${line ? `:${line}` : ''}`;
}

/** Rows a textarea needs to show `text` without scrolling, for about `cols` characters per row. */
function rowsFor(text, cols) {
  return String(text ?? '').split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / cols)), 0) + 1;
}

function decisionLabel(payload, key) {
  return decisionsFor(payload).find((b) => b.key === key)?.label ?? key;
}

/**
 * One thread's card. `where` is 'inline' (under the GitHub thread) or 'panel'. `view` carries what the page
 * remembers per thread: { expanded, editing, hidden } plus `sent`/`done`/`readOnly` for the whole round.
 */
function buildCard(state, item, where, view = {}) {
  const p = state.payload;
  const d = state.decisions[item.thread_id];
  const e = effective(state, item);
  const id = esc(item.thread_id);
  const review = modeOf(p) === 'review';
  const compact = !view.expanded && (e.auto || view.sent || view.done);
  const verdictLabel = item.verdict ? `<span class="sc-label sc-v-${esc(item.verdict)}">${esc(decisionLabel(p, item.verdict))}</span>` : '';
  const who = item.origin === 'user' ? '<b>Your draft comment</b>' : `<b>Second Chair</b> <span class="sc-muted">${review ? 'draft comment' : 'proposes'}</span>`;
  const links = threadLinks(p.repo, p.pr, item.comment_id);
  const jump = where === 'panel' && links
    ? `<a href="#" data-sc-act="jump" data-sc-id="${id}">jump</a><a href="${esc(links.files)}">in files</a>`
    : '';
  const pos = view.position ? `<span class="sc-muted">${esc(view.position)}</span>` : '';
  const moves = view.position && !view.readOnly
    ? `<a href="#" data-sc-act="prev" data-sc-id="${id}">‹</a><a href="#" data-sc-act="next" data-sc-id="${id}">›</a>`
    : '';
  const hidden = view.hidden ? '<span class="sc-label" title="GitHub has not loaded this thread on the page">hidden</span>' : '';
  const cls = `sc-card${e.decision && !missingNote(state, item) ? ' sc-decided' : ''}${compact ? ' sc-compact' : ''}`;
  const open = `<div class="${cls}" data-sc-card="${id}" data-sc-where="${where}">`;
  const mark = '<span class="sc-mark" aria-hidden="true">SC</span>';
  if (compact) {
    const first = String(d.reply || field(item, 'summary')).split('\n').find((l) => l.trim()) ?? '';
    const label = e.decision ? `<span class="sc-label${e.auto ? ' sc-auto' : ''} sc-v-${esc(e.decision)}">${e.auto ? 'auto · ' : ''}${esc(decisionLabel(p, e.decision))}</span>` : '';
    return `${open}<div class="sc-oneline">${mark}${label}<span class="sc-oneline-text">${richText(first)}</span><a href="#" data-sc-act="expand" data-sc-id="${id}">expand</a></div></div>`;
  }
  const context = [field(item, 'context'), field(item, 'fix') ? `**Plan:** ${field(item, 'fix')}` : ''].filter(Boolean).join('\n\n');
  const summary = field(item, 'summary');
  const commits = Array.isArray(item.commits) && item.commits.length ? `<div class="sc-commits">Commits: ${item.commits.map((c) => `<code>${esc(c)}</code>`).join(' ')}</div>` : '';
  const needNote = missingNote(state, item);
  const reply = view.editing && !view.readOnly
    ? `<textarea class="sc-reply" data-sc-field="reply" data-sc-id="${id}" rows="${rowsFor(d.reply, where === 'panel' ? 70 : 110)}">${esc(d.reply)}</textarea>`
    : `<div class="sc-md markdown-body">${renderMarkdown(d.reply) || '<span class="sc-empty">Nothing to post.</span>'}</div>`;
  const tabs = view.readOnly ? '' : `<div class="sc-tabs"><a href="#" class="sc-tab${view.editing ? ' sc-tab-on' : ''}" data-sc-tab="write" data-sc-act="tab" data-sc-val="write" data-sc-id="${id}">Write</a><a href="#" class="sc-tab${view.editing ? '' : ' sc-tab-on'}" data-sc-tab="preview" data-sc-act="tab" data-sc-val="preview" data-sc-id="${id}">Preview</a></div>`;
  const original = item.origin === 'user' && item.original_en && item.original_en !== d.reply
    ? `<details class="sc-original"><summary>Your original</summary><div class="sc-md markdown-body">${renderMarkdown(item.original_en)}</div></details>` : '';
  const buttons = decisionsFor(p).map((b, i) => {
    const bc = ['sc-btn'];
    if (d.decision === b.key) bc.push('sc-on');
    else if (e.auto && e.decision === b.key) bc.push('sc-on-auto');
    else if (!e.decision && item.verdict === b.key) bc.push('sc-suggested');
    return `<button type="button" class="${bc.join(' ')}" data-sc-act="decide" data-sc-id="${id}" data-sc-val="${b.key}" title="${i + 1}">${d.decision === b.key ? '✓ ' : ''}${esc(b.label)}</button>`;
  }).join('');
  const footer = view.readOnly
    ? `<div class="sc-card-foot"><span class="sc-muted">Decision:</span> <b>${esc(e.decision ? decisionLabel(p, e.decision) : 'none')}</b></div>`
    : `<div class="sc-card-foot"><div class="sc-seg">${buttons}</div><input class="sc-note${needNote ? ' sc-note-needed' : ''}" data-sc-field="note" data-sc-id="${id}" placeholder="${needNote ? 'What should change? Revise needs a note' : 'Note for the agent (optional)'}" value="${esc(d.note)}"></div>`;
  const expander = e.auto || view.sent || view.done ? `<a href="#" data-sc-act="expand" data-sc-id="${id}">collapse</a>` : '';
  return `${open}
  <div class="sc-card-head">${mark}${who}${verdictLabel}${hidden}<span class="sc-head-right">${pos}${moves}${jump}${expander}</span></div>
  <div class="sc-card-body">
    ${summary ? `<div class="sc-summary sc-md">${renderMarkdown(summary)}</div>` : ''}
    ${context ? `<div class="sc-foryou"><div class="sc-foryou-title">For you <span class="sc-muted">· never posted</span></div><div class="sc-md markdown-body">${renderMarkdown(context)}</div></div>` : ''}
    ${commits}
    <div class="sc-caption">${review ? (item.comment_id ? 'Comment to post' : 'Review body') : 'Reply to post'}${d.replyEdited ? ' <span class="sc-edited">· edited</span>' : ''}</div>
    <div class="sc-reply-box">${tabs}${reply}</div>
    ${original}
  </div>
  ${footer}
</div>`;
}

/** Panel rows grouped by file: general items first under "General", then each path in first-seen order. */
function groupItems(items) {
  const groups = new Map();
  const general = items.filter((it) => !it.path);
  if (general.length) groups.set('', { key: '', label: 'General', items: general });
  for (const it of items) {
    if (!it.path) continue;
    if (!groups.has(it.path)) groups.set(it.path, { key: it.path, label: it.path, items: [] });
    groups.get(it.path).items.push(it);
  }
  return [...groups.values()];
}

const SC_ICON = {
  // SVG presentation attributes do not take var(), so the theme colors go through style.
  open: '<svg class="sc-st" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" style="fill:none;stroke:var(--fgColor-attention,#9a6700);stroke-width:1.5"/></svg>',
  done: (color) => `<svg class="sc-st" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" style="fill:${color}"/><path d="M5 8.2l2 2 4-4.2" style="stroke:#fff;stroke-width:1.6;fill:none"/></svg>`,
};

/** The status icon and decision label of a panel row, and whether the row counts as decided. */
function rowParts(state, it, v) {
  const e = effective(state, it);
  const needNote = missingNote(state, it);
  const decided = Boolean(e.decision) && !needNote;
  const icon = v.done ? SC_ICON.done('var(--fgColor-done,#8250df)') : !decided ? SC_ICON.open : SC_ICON.done(e.auto ? 'var(--fgColor-muted,#8c959f)' : 'var(--fgColor-success,#1a7f37)');
  const label = e.decision ? `<span class="sc-label${e.auto ? ' sc-auto' : ''} sc-v-${esc(e.decision)}">${e.auto ? 'auto · ' : ''}${esc(decisionLabel(state.payload, e.decision))}${needNote ? ' · needs a note' : ''}</span>` : '<span class="sc-muted">—</span>';
  return { decided, icon, label };
}

function buildPanelList(state, openId, filterKey, viewOf) {
  const p = state.payload;
  const items = visibleItems(state, filterKey);
  return groupItems(items).map((g) => `<div class="sc-group"><span>${esc(g.label)}</span><span>${g.items.length}</span></div>${g.items.map((it) => {
    const e = effective(state, it);
    const v = viewOf(it);
    const { decided, icon, label } = rowParts(state, it, v);
    const meta = [esc(it.author ?? 'general'), it.line ? `line ${esc(it.line)}` : '', !e.decision && it.verdict ? `proposed ${esc(decisionLabel(p, it.verdict))}` : '', v.hidden ? '<span class="sc-hidden">not loaded on page</span>' : '', Array.isArray(it.commits) && it.commits.length ? `commit <code>${esc(it.commits[0])}</code>` : ''].filter(Boolean).join(' · ');
    const open = it.thread_id === openId;
    return `<div class="sc-row${decided ? ' sc-decided' : ''}${open ? ' sc-selected' : ''}" data-sc-item="${esc(it.thread_id)}">
  <div class="sc-row-main" data-sc-act="toggle" data-sc-id="${esc(it.thread_id)}">${icon}<div class="sc-row-text"><div class="sc-row-sum">${richText(field(it, 'summary') || String(it.reply_en ?? '').split('\n')[0])}</div><div class="sc-row-meta">${meta}</div></div>${label}</div>
  ${open && (v.expandedInPanel || v.hidden || !it.comment_id) ? buildCard(state, it, 'panel', { ...v, expanded: true }) : ''}
</div>`;
  }).join('')}`).join('');
}

function buildFilterBar(state, filterKey) {
  const count = (test) => state.payload.items.filter((it) => test(effective(state, it))).length;
  const tabs = SC_FILTERS.map((f) => `<a href="#" class="sc-ftab${f.key === filterKey ? ' sc-ftab-on' : ''}" data-sc-act="filter" data-sc-val="${f.key}">${esc(f.label)}<b>${count(f.test)}</b></a>`).join('');
  const options = decisionsFor(state.payload).map((b) => `<option value="d:${b.key}"${`d:${b.key}` === filterKey ? ' selected' : ''}>${esc(b.label)} (${count((e) => e.decision === b.key)})</option>`).join('');
  return `<div class="sc-tabbar">${tabs}<select class="sc-fdecision" data-sc-act="filterselect"><option value="">Decision</option>${options}</select></div>`;
}

const SC_CSS = `
.sc-toggle{position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;align-items:center;gap:6px;height:32px;padding:0 12px 0 6px;border-radius:16px;border:1px solid var(--borderColor-default,#d0d7de);background:var(--bgColor-default,#fff);color:var(--fgColor-default,#1f2328);font:600 12px/1 -apple-system,system-ui,sans-serif;cursor:pointer;box-shadow:var(--shadow-floating-small,0 2px 8px rgba(0,0,0,.15))}
.sc-toggle.sc-complete{color:var(--fgColor-success,#1a7f37);border-color:var(--fgColor-success,#1a7f37)}
.sc-panel{position:fixed;top:0;right:0;bottom:0;width:min(440px,92vw);z-index:9998;display:flex;flex-direction:column;background:var(--bgColor-default,#fff);color:var(--fgColor-default,#1f2328);border-left:1px solid var(--borderColor-default,#d0d7de);box-shadow:var(--shadow-floating-large,-4px 0 16px rgba(0,0,0,.12));font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
.sc-panel.sc-wide{width:50vw}.sc-panel[hidden]{display:none}
html.sc-shift-narrow body{margin-right:min(440px,92vw)!important}html.sc-shift-wide body{margin-right:50vw!important}
html.sc-shift-narrow .sc-toggle{right:calc(min(440px,92vw) + 16px)}html.sc-shift-wide .sc-toggle{right:calc(50vw + 16px)}
.sc-panel-head{padding:12px 14px 10px;border-bottom:1px solid var(--borderColor-default,#d0d7de);position:relative}
.sc-hrow{display:flex;align-items:center;gap:8px}.sc-grow{flex:1}.sc-small{font-size:12px;margin-top:6px}.sc-fg{color:var(--fgColor-default,#1f2328)}
.sc-title{font-size:14px}
.sc-icon{width:28px;height:28px;border-radius:6px;border:1px solid transparent;background:none;color:var(--fgColor-muted,#59636e);cursor:pointer;font:16px/1 system-ui}
.sc-icon:hover{background:var(--bgColor-muted,#f6f8fa);border-color:var(--borderColor-default,#d0d7de)}
.sc-dot{width:8px;height:8px;border-radius:50%;background:var(--fgColor-muted,#8c959f)}.sc-dot.sc-up{background:var(--fgColor-success,#1a7f37)}.sc-dot.sc-down{background:var(--fgColor-danger,#d1242f)}
.sc-progress{display:flex;height:8px;margin-top:10px;border-radius:4px;overflow:hidden;background:var(--bgColor-muted,#f6f8fa);border:1px solid var(--borderColor-default,#d0d7de)}
.sc-progress i{display:block}.sc-p-mine{background:var(--fgColor-success,#1a7f37)}.sc-p-auto{background:var(--fgColor-muted,#8c959f)}
.sc-done-label{color:var(--fgColor-done,#8250df);border-color:var(--fgColor-done,#8250df);background:var(--bgColor-done-muted,#fbefff)}
.sc-menu{position:absolute;right:14px;top:48px;z-index:2;width:220px;padding:6px 0;background:var(--overlay-bgColor,var(--bgColor-default,#fff));border:1px solid var(--borderColor-default,#d0d7de);border-radius:8px;box-shadow:var(--shadow-floating-medium,0 8px 24px rgba(140,149,159,.3))}
.sc-menu a{display:block;padding:6px 14px;color:inherit!important;text-decoration:none!important}.sc-menu a:hover{background:var(--bgColor-muted,#f6f8fa)}.sc-menu hr{border:0;border-top:1px solid var(--borderColor-default,#d0d7de);margin:6px 0}.sc-menu .sc-danger{color:var(--fgColor-danger,#d1242f)!important}
.sc-tabbar{display:flex;align-items:center;gap:2px;padding:0 10px;border-bottom:1px solid var(--borderColor-default,#d0d7de);overflow-x:auto}
.sc-ftab{padding:8px;border-bottom:2px solid transparent;margin-bottom:-1px;color:inherit!important;text-decoration:none!important;white-space:nowrap}
.sc-ftab-on{border-bottom-color:var(--underlineNav-borderColor-active,#fd8c73);font-weight:600}
.sc-ftab b{font-weight:500;font-size:12px;margin-left:4px;padding:0 6px;border-radius:2em;background:var(--bgColor-neutral-muted,#afb8c133)}
.sc-fdecision{margin-left:auto;font:12px system-ui;border:1px solid var(--borderColor-default,#d0d7de);border-radius:6px;background:var(--bgColor-muted,#f6f8fa);color:inherit;padding:2px 6px}
.sc-list{flex:1;overflow:auto}
.sc-group{display:flex;justify-content:space-between;padding:6px 14px;background:var(--bgColor-muted,#f6f8fa);border-bottom:1px solid var(--borderColor-default,#d0d7de);font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fgColor-muted,#59636e)}
.sc-row{border-bottom:1px solid var(--borderColor-default,#d0d7de)}
.sc-row-main{display:flex;gap:10px;align-items:flex-start;padding:9px 14px;cursor:pointer}
.sc-row-main:hover{background:var(--bgColor-muted,#f6f8fa)}
.sc-row.sc-selected>.sc-row-main{background:var(--bgColor-accent-muted,#ddf4ff);box-shadow:inset 3px 0 0 var(--fgColor-accent,#0969da)}
.sc-st{width:16px;height:16px;flex:none;margin-top:2px}
.sc-row-text{flex:1;min-width:0}.sc-row-sum{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sc-row-meta{font-size:12px;color:var(--fgColor-muted,#59636e)}
.sc-hidden{color:var(--fgColor-attention,#9a6700)}
.sc-row .sc-card{margin:0 14px 10px 40px}
.sc-panel-foot{border-top:1px solid var(--borderColor-default,#d0d7de);padding:10px 14px;background:var(--bgColor-muted,#f6f8fa)}
.sc-primary{width:100%;height:32px;border-radius:6px;border:1px solid var(--button-primary-borderColor-rest,rgba(31,35,40,.15));background:var(--button-primary-bgColor-rest,#1f883d);color:var(--button-primary-fgColor-rest,#fff);font:600 13px system-ui;cursor:pointer}
.sc-primary:disabled{opacity:.5;cursor:not-allowed}
.sc-keys{margin-top:8px;text-align:center;font-size:12px;color:var(--fgColor-muted,#59636e)}
.sc-keys kbd{font:11px ui-monospace,monospace;border:1px solid var(--borderColor-default,#d0d7de);border-bottom-width:2px;border-radius:4px;padding:0 4px;background:var(--bgColor-default,#fff)}
.sc-banner{margin:10px 14px 0;padding:8px 12px;border-radius:6px;background:var(--bgColor-success-muted,#dafbe1);border:1px solid var(--borderColor-success-muted,#4ac26b66)}
.sc-banner-done{background:var(--bgColor-done-muted,#fbefff);border-color:var(--borderColor-done-muted,#c297ff66)}
.sc-msg{margin:10px 14px 0;font-size:12px}.sc-msg.sc-err{color:var(--fgColor-danger,#d1242f)}
.sc-paste{margin:10px 14px;width:calc(100% - 28px);min-height:90px;font:12px ui-monospace,monospace}
.sc-card,.sc-panel,.sc-toggle{--sc-accent:var(--fgColor-accent,#0969da);--sc-border:var(--borderColor-default,#d0d7de);--sc-subtle:var(--bgColor-muted,#f6f8fa);--sc-canvas:var(--bgColor-default,#fff);--sc-muted:var(--fgColor-muted,#59636e);--sc-success:var(--fgColor-success,#1a7f37)}
.sc-card{
  border:1px solid var(--sc-border);border-left:3px solid var(--sc-accent);border-radius:6px;background:var(--sc-canvas);color:var(--fgColor-default,#1f2328);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;overflow:hidden}
.sc-card[data-sc-where=inline]{margin:8px 16px 16px}
.sc-card[data-sc-where=panel]{margin:0 0 8px}
.sc-card.sc-decided{border-left-color:var(--sc-success)}
.sc-card-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 12px;background:var(--sc-subtle);border-bottom:1px solid var(--sc-border);font-size:13px}
.sc-head-right{margin-left:auto;display:flex;gap:10px;font-size:12px}
.sc-head-right a{text-decoration:none}
.sc-mark{width:20px;height:20px;border-radius:50%;flex:none;display:inline-grid;place-items:center;background:var(--fgColor-default,#1f2328);color:var(--sc-canvas);font:700 9px/1 system-ui}
.sc-muted{color:var(--sc-muted)}
.sc-label{display:inline-block;font:500 12px/18px -apple-system,system-ui,sans-serif;padding:0 7px;border-radius:2em;border:1px solid var(--sc-border);color:var(--sc-muted)}
.sc-v-fix,.sc-v-revise{color:var(--sc-accent);border-color:var(--sc-accent);background:var(--bgColor-accent-muted,#ddf4ff)}
.sc-v-reply,.sc-v-publish,.sc-v-post{color:var(--sc-success);border-color:var(--sc-success)}
.sc-v-pushback,.sc-v-hold,.sc-v-drop{color:var(--fgColor-severe,#bc4c00);border-color:var(--fgColor-severe,#bc4c00)}
.sc-label.sc-auto{color:var(--sc-success);border-color:var(--sc-success);background:none}
.sc-v-manual{color:var(--fgColor-danger,#d1242f);border-color:var(--fgColor-danger,#d1242f)}
.sc-card-body{padding:12px}
.sc-summary{font-weight:600;margin-bottom:8px}
.sc-foryou{background:var(--bgColor-attention-muted,#fff8c5);border:1px solid var(--borderColor-attention-muted,#d4a72c66);border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:13px}
.sc-foryou-title{font-weight:600;margin-bottom:2px}
.sc-caption{font-size:12px;font-weight:600;color:var(--sc-muted);margin-bottom:6px}
.sc-edited{font-weight:400;color:var(--fgColor-severe,#bc4c00)}
.sc-reply-box{border:1px solid var(--sc-border);border-radius:6px;overflow:hidden}
.sc-tabs{display:flex;background:var(--sc-subtle);border-bottom:1px solid var(--sc-border);padding:0 8px}
.sc-tab{padding:7px 12px;font-size:13px;color:var(--sc-muted)!important;margin-bottom:-1px;text-decoration:none!important}
.sc-tab-on{background:var(--sc-canvas);border:1px solid var(--sc-border);border-bottom-color:var(--sc-canvas);border-radius:6px 6px 0 0;color:var(--fgColor-default,#1f2328)!important}
.sc-reply-box .sc-md{padding:10px 12px}
.sc-reply{display:block;width:100%;box-sizing:border-box;border:0;padding:10px 12px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--sc-canvas);color:inherit;resize:vertical;overflow:hidden;outline:none}
.sc-original{margin-top:8px;font-size:13px}.sc-original summary{cursor:pointer;color:var(--sc-muted)}
.sc-commits{font-size:12px;margin-bottom:8px;color:var(--sc-muted)}
.sc-card-foot{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 12px;border-top:1px solid var(--sc-border);background:var(--sc-subtle)}
.sc-seg{display:inline-flex}
.sc-btn{height:28px;padding:0 12px;border:1px solid var(--sc-border);background:var(--sc-subtle);color:inherit;font:500 12px -apple-system,system-ui,sans-serif;cursor:pointer;margin-left:-1px}
.sc-seg .sc-btn:first-child{border-radius:6px 0 0 6px;margin-left:0}.sc-seg .sc-btn:last-child{border-radius:0 6px 6px 0}
.sc-btn:hover{background:var(--bgColor-neutral-muted,#eaeef2)}
.sc-btn.sc-suggested{border-style:dashed;border-color:var(--sc-accent);color:var(--sc-accent);position:relative;z-index:1}
.sc-btn.sc-on{background:var(--sc-accent);border-color:var(--sc-accent);color:var(--fgColor-onEmphasis,#fff);position:relative;z-index:1}
.sc-btn.sc-on-auto{border-color:var(--sc-accent);color:var(--sc-accent);font-weight:600}
.sc-note{flex:1;min-width:180px;height:28px;box-sizing:border-box;padding:0 10px;border:1px solid var(--sc-border);border-radius:6px;background:var(--sc-canvas);color:inherit;font:13px -apple-system,system-ui,sans-serif}
.sc-note.sc-note-needed{border-color:var(--fgColor-danger,#d1242f)}
.sc-oneline{display:flex;align-items:center;gap:8px;padding:7px 12px;font-size:13px}
.sc-oneline-text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--sc-muted)}
.sc-empty{color:var(--sc-muted);font-style:italic}
.sc-md>:first-child{margin-top:0}.sc-md>:last-child{margin-bottom:0}
.sc-md p,.sc-md ul,.sc-md ol,.sc-md pre,.sc-md table,.sc-md blockquote{margin:0 0 8px}
.sc-md ul,.sc-md ol{padding-left:22px}
.sc-md h1,.sc-md h2,.sc-md h3,.sc-md h4{font-size:14px;margin:10px 0 6px}
.sc-md table{border-collapse:collapse}
.sc-md th,.sc-md td{border:1px solid var(--borderColor-default,#d0d7de);padding:2px 8px}
.sc-md pre{padding:8px;border-radius:6px;background:var(--bgColor-muted,#f6f8fa);overflow:auto}
.sc-md blockquote{padding-left:10px;border-left:3px solid var(--borderColor-default,#d0d7de);color:var(--fgColor-muted,#59636e)}
.sc-card code,.sc-row code{font-size:11.5px;padding:0 4px;border-radius:4px;background:var(--bgColor-muted,#f6f8fa)}
.sc-md pre code{padding:0;background:none}
.sc-flash{outline:3px solid var(--fgColor-accent,#0969da);outline-offset:2px;transition:outline-color 1.5s}
`;

function secondChairBootstrap() {
  let loc = null;
  let state = null;
  let openId = null;
  let message = null;
  let serverUp = null;
  let menuOpen = false;
  let rendering = false;
  let timer = null;
  const expanded = new Set();
  const editing = new Set();
  const ui = (() => {
    try {
      return { filter: 'all', wide: false, open: false, ...JSON.parse(GM_getValue('sc:ui', '{}')) };
    } catch {
      return { filter: 'all', wide: false, open: false };
    }
  })();
  const saveUi = () => GM_setValue('sc:ui', JSON.stringify(ui));

  const load = () => {
    const raw = GM_getValue(storageKey(loc.repo, loc.number), null);
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  const save = () => GM_setValue(storageKey(loc.repo, loc.number), JSON.stringify(state));
  const done = () => Boolean(doneInfo(state));
  let showDoneCards = false;
  const itemById = (id) => state.payload.items.find((x) => x.thread_id === id);
  const viewOf = (it) => ({
    expanded: expanded.has(it.thread_id),
    expandedInPanel: expanded.has(it.thread_id),
    editing: editing.has(it.thread_id),
    hidden: Boolean(it.comment_id) && !anchorFor(it),
    position: `${displayOrder(state.payload.items).indexOf(it) + 1} of ${state.payload.items.length}`,
    sent: Boolean(state.sentAt),
    done: done(),
    readOnly: done(),
  });

  /** Resolves { status, body } from the local server; rejects when it is not running. */
  function api(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: `${SC_SERVER}${path}`,
        // The custom header is what the server checks to refuse requests a web page could forge.
        headers: { 'Content-Type': 'application/json', 'X-Second-Chair': '1' },
        data: body === undefined ? undefined : JSON.stringify(body),
        timeout: 4000,
        onload: (r) => {
          let parsed = null;
          try {
            parsed = r.responseText ? JSON.parse(r.responseText) : null;
          } catch {
            parsed = null;
          }
          resolve({ status: r.status, body: parsed });
        },
        onerror: () => reject(new Error('server not reachable')),
        ontimeout: () => reject(new Error('server timed out')),
      });
    });
  }

  function ensureShell() {
    if (!document.getElementById('sc-style')) {
      const style = document.createElement('style');
      style.id = 'sc-style';
      style.textContent = SC_CSS;
      document.head.appendChild(style);
    }
    if (!document.querySelector('.sc-toggle')) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'sc-toggle';
      toggle.dataset.scAct = 'panel';
      document.body.appendChild(toggle);
      const panel = document.createElement('div');
      panel.className = 'sc-panel';
      panel.hidden = !ui.open;
      document.body.appendChild(panel);
    }
  }

  function removeShell() {
    document.querySelectorAll('.sc-toggle, .sc-panel, .sc-card[data-sc-where=inline]').forEach((n) => n.remove());
    document.documentElement.classList.remove('sc-shift-narrow', 'sc-shift-wide');
  }

  function applyLayout() {
    const panel = document.querySelector('.sc-panel');
    if (!panel) return;
    panel.hidden = !ui.open;
    panel.classList.toggle('sc-wide', ui.wide);
    // The page narrows next to the panel instead of hiding under it.
    document.documentElement.classList.toggle('sc-shift-narrow', ui.open && !ui.wide);
    document.documentElement.classList.toggle('sc-shift-wide', ui.open && ui.wide);
  }

  function renderPanel() {
    const panel = document.querySelector('.sc-panel');
    const toggle = document.querySelector('.sc-toggle');
    if (!panel || !toggle) return;
    const listEl = panel.querySelector('.sc-list');
    const scrollTop = listEl ? listEl.scrollTop : 0;
    const info = doneInfo(state);
    const pr = state ? progress(state) : null;
    toggle.innerHTML = `<span class="sc-mark">SC</span> ${info ? '✓ done' : pr ? `${pr.done}/${pr.total}` : ''}`;
    toggle.classList.toggle('sc-complete', Boolean(pr && pr.complete && !info));
    const pct = (n) => (pr && pr.total ? (100 * n) / pr.total : 0);
    const head = `<div class="sc-panel-head">
  <div class="sc-hrow"><span class="sc-mark">SC</span><b class="sc-title">Second Chair</b>${state ? `<span class="sc-muted">#${state.payload.pr} · ${modeOf(state.payload)} · round ${state.payload.round}</span>` : ''}<span class="sc-grow"></span>
    ${info ? '<span class="sc-label sc-done-label">✓ Done</span>' : ''}
    <span class="sc-dot ${serverUp ? 'sc-up' : serverUp === false ? 'sc-down' : ''}" title="server ${serverUp ? 'on' : 'off'} · ${SC_SERVER}"></span>
    <button type="button" class="sc-icon" data-sc-act="menu" aria-label="More">⋯</button><button type="button" class="sc-icon" data-sc-act="panel" aria-label="Close">✕</button></div>
  ${pr && !info ? `<div class="sc-progress"><i style="width:${pct(pr.done - pr.auto)}%" class="sc-p-mine"></i><i style="width:${pct(pr.auto)}%" class="sc-p-auto"></i></div>
  <div class="sc-hrow sc-muted sc-small"><span><b class="sc-fg sc-n-done">${pr.done}</b> of ${pr.total} decided</span>${pr.auto ? `<span>· ${pr.auto} auto</span>` : ''}<span class="sc-grow"></span><span class="sc-left">${pr.total - pr.done ? `${pr.total - pr.done} left` : 'ready to send'}</span></div>` : ''}
</div>`;
    const menu = menuOpen ? `<div class="sc-menu">
  <a href="#" data-sc-act="fetch">Load from server</a><a href="#" data-sc-act="import">Load from clipboard</a><hr>
  <a href="#" data-sc-act="wide">${ui.wide ? 'Narrow panel' : 'Half screen'}</a>
  ${state && !info ? '<hr><a href="#" data-sc-act="markdone">Mark as done</a>' : ''}
  ${state ? '<a href="#" class="sc-danger" data-sc-act="clear">Clear from this browser</a>' : ''}</div>` : '';
    let banner = '';
    if (info) banner = `<div class="sc-banner sc-banner-done"><b>Done</b> · ${esc(SC_DONE_REASON[info.reason])} ${esc(formatTime(info.at))}. Cards are hidden on the page. <a href="#" data-sc-act="showdone">${showDoneCards ? 'Hide cards' : 'Show cards on the page'}</a></div>`;
    else if (state?.sentAt) banner = `<div class="sc-banner">${esc(sentNote(state))}</div>`;
    const msg = message ? `<div class="sc-msg${message.error ? ' sc-err' : ''}">${richText(message.text)}</div>` : '';
    const paste = !state || message?.showPaste ? '<textarea class="sc-paste" placeholder="Or paste the proposals JSON here (Ctrl+V)"></textarea>' : '';
    const foot = state && !info
      ? `<div class="sc-panel-foot"><button type="button" class="sc-primary" data-sc-act="export" ${pr.complete ? '' : 'disabled'}>Send decisions${pr.complete ? '' : ` · ${pr.total - pr.done} left`}</button>
  <div class="sc-keys"><kbd>j</kbd> <kbd>k</kbd> move <kbd>Enter</kbd> expand <kbd>1</kbd>–<kbd>${decisionsFor(state.payload).length}</kbd> decide <kbd>e</kbd> edit</div></div>`
      : state ? '<div class="sc-panel-foot sc-muted sc-small">Read only. A new proposal from the agent reopens this pull request.</div>' : '';
    panel.innerHTML = `${head}${menu}${banner}${state ? buildFilterBar(state, ui.filter) : ''}${msg}${paste}<div class="sc-list">${state ? buildPanelList(state, openId, ui.filter, viewOf) : ''}</div>${foot}`;
    panel.querySelector('.sc-list').scrollTop = scrollTop;
    applyLayout();
  }

  /** Updates the counter, the send button and the note markers in place, so typing a note keeps its focus. */
  function updateProgress(id) {
    const pr = progress(state);
    const toggle = document.querySelector('.sc-toggle');
    if (toggle && !done()) toggle.innerHTML = `<span class="sc-mark">SC</span> ${pr.done}/${pr.total}`;
    toggle?.classList.toggle('sc-complete', pr.complete && !done());
    const send = document.querySelector('.sc-panel [data-sc-act=export]');
    if (send) {
      send.disabled = !(pr.complete && !done());
      send.textContent = pr.complete ? 'Send decisions' : `Send decisions · ${pr.total - pr.done} left`;
    }
    const bar = (n) => `${pr.total ? (100 * n) / pr.total : 0}%`;
    const mine = document.querySelector('.sc-panel .sc-p-mine');
    if (mine) mine.style.width = bar(pr.done - pr.auto);
    const nDone = document.querySelector('.sc-panel .sc-n-done');
    if (nDone) nDone.textContent = pr.done;
    const left = document.querySelector('.sc-panel .sc-left');
    if (left) left.textContent = pr.total - pr.done ? `${pr.total - pr.done} left` : 'ready to send';
    const it = itemById(id);
    const parts = rowParts(state, it, viewOf(it));
    const row = document.querySelector(`.sc-row[data-sc-item="${CSS.escape(id)}"]`);
    if (row) {
      row.classList.toggle('sc-decided', parts.decided);
      const main = row.querySelector('.sc-row-main');
      main.querySelector('.sc-st').outerHTML = parts.icon;
      main.lastElementChild.outerHTML = parts.label;
    }
    document.querySelectorAll(`.sc-card[data-sc-card="${CSS.escape(id)}"]`).forEach((c) => c.classList.toggle('sc-decided', parts.decided));
    const needed = missingNote(state, it);
    document.querySelectorAll(`.sc-note[data-sc-id="${CSS.escape(id)}"]`).forEach((n) => n.classList.toggle('sc-note-needed', needed));
  }

  function anchorFor(item) {
    if (!item.comment_id) return null;
    return document.getElementById(`discussion_r${item.comment_id}`) || document.getElementById(`r${item.comment_id}`);
  }

  const inlineCard = (id) => document.querySelector(`.sc-card[data-sc-where=inline][data-sc-card="${CSS.escape(id)}"]`);
  const showInline = () => Boolean(state) && (!done() || showDoneCards);

  function cardElement(it) {
    const holder = document.createElement('div');
    holder.innerHTML = buildCard(state, it, 'inline', viewOf(it));
    return holder.firstElementChild;
  }

  /** Adds the cards that are missing, for threads GitHub loaded since the last pass; leaves the others alone. */
  function renderInline() {
    if (!showInline()) {
      document.querySelectorAll('.sc-card[data-sc-where=inline]').forEach((n) => n.remove());
      return;
    }
    for (const it of state.payload.items) {
      const anchor = anchorFor(it);
      if (!anchor || inlineCard(it.thread_id)) continue;
      anchor.insertAdjacentElement('afterend', cardElement(it));
    }
  }

  function rebuildInline() {
    document.querySelectorAll('.sc-card[data-sc-where=inline]').forEach((n) => n.remove());
    renderInline();
  }

  function renderAll(rebuild) {
    rendering = true;
    try {
      ensureShell();
      renderPanel();
      if (rebuild) rebuildInline();
      else renderInline();
    } finally {
      setTimeout(() => { rendering = false; }, 0);
    }
  }

  /** Re-renders one thread's inline card and the panel, keeping focus in the other fields. */
  function refreshThread(id) {
    rendering = true;
    try {
      renderPanel();
      const card = inlineCard(id);
      if (card) card.replaceWith(cardElement(itemById(id)));
    } finally {
      setTimeout(() => { rendering = false; }, 0);
    }
  }

  function adopt(res, source) {
    if (res.error) {
      message = { error: true, text: res.error, showPaste: true };
    } else if (res.payload.repo !== loc.repo || res.payload.pr !== loc.number) {
      message = { error: true, text: `These proposals are for ${res.payload.repo}#${res.payload.pr}, and this page is ${loc.repo}#${loc.number}.`, showPaste: true };
    } else {
      const wasDone = done();
      state = stateFor(res.payload, state);
      save();
      if (done() && !wasDone) showDoneCards = false;
      message = { text: done() ? 'This triage is done.' : `Loaded ${res.payload.items.length} ${modeOf(res.payload) === 'review' ? 'review comments' : 'threads'}, round ${res.payload.round}, from the ${source}.` };
    }
    renderAll(true);
  }

  /** Asks the server for this PR's latest proposals; loads them when they are newer than what is shown. */
  async function sync(force) {
    const here = loc;
    try {
      const r = await api('GET', `/api/proposals?repo=${encodeURIComponent(here.repo)}&pr=${here.number}`);
      if (here !== loc) return;
      serverUp = true;
      if (r.status === 200 && r.body && (force || isNewer(r.body, state))) adopt(checkPayload(r.body), 'server');
      else if (force && r.status === 404) message = { text: 'The server has no proposals for this PR yet.' };
    } catch {
      if (here !== loc) return;
      serverUp = false;
      if (force) message = { error: true, text: `The server at ${SC_SERVER} is not running. Start it with \`second-chair start\`, or load from the clipboard.`, showPaste: true };
    }
    renderPanel();
  }

  async function sendDecisions() {
    const out = buildExport(state, new Date().toISOString());
    if (!out) return;
    try {
      const r = await api('POST', '/api/decisions', out);
      serverUp = true;
      if (r.status === 200) {
        state.sentAt = out.exported_at;
        state.sentVia = 'server';
        save();
        message = null;
        renderAll(true);
        return;
      }
      GM_setClipboard(JSON.stringify(out, null, 2), 'text');
      message = { error: true, text: `The server refused the decisions (${r.status}: ${r.body?.error ?? 'no reason'}). They are on the clipboard instead.` };
    } catch {
      serverUp = false;
      // An offline final send also ends the triage.
      state.sentAt = out.exported_at;
      state.sentVia = 'clipboard';
      save();
      GM_setClipboard(JSON.stringify(out, null, 2), 'text');
      message = { text: 'The server is not running, so the decisions are on the clipboard. Paste them to the agent.' };
    }
    renderPanel();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Opens every collapsed <details> around `el`, the way GitHub folds resolved and outdated threads. */
  function unfold(el) {
    for (let n = el; n; n = n.parentElement) {
      if (n.tagName === 'DETAILS' && !n.open) n.open = true;
    }
  }

  /** Waits for the thread's anchor, asking GitHub to load it: first by its hash, then by "Load more" buttons. */
  async function reveal(item) {
    let anchor = anchorFor(item);
    if (anchor) return anchor;
    history.replaceState(null, '', `#discussion_r${item.comment_id}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    for (let i = 0; i < 10 && !(anchor = anchorFor(item)); i++) await sleep(200);
    for (let round = 0; round < 6 && !anchor; round++) {
      const more = [...document.querySelectorAll('button, a')].find((b) => /load more|hidden items|show \d+ more/i.test(b.textContent) && b.offsetParent !== null);
      if (!more) break;
      more.click();
      for (let i = 0; i < 15 && !(anchor = anchorFor(item)); i++) await sleep(200);
    }
    return anchor;
  }

  async function jump(id) {
    const it = itemById(id);
    if (!it?.comment_id) return;
    const anchor = await reveal(it);
    if (!anchor) {
      message = { error: true, text: 'GitHub did not load this thread on the page. Use "in files", or open the conversation tab.' };
      renderPanel();
      return;
    }
    unfold(anchor);
    renderInline();
    const target = inlineCard(id) || anchor;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('sc-flash');
    setTimeout(() => target.classList.remove('sc-flash'), 1600);
    if (message?.error) {
      message = null;
      renderPanel();
    }
  }

  function select(id) {
    openId = id;
    renderPanel();
    const row = document.querySelector(`.sc-row[data-sc-item="${CSS.escape(id)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
    jump(id);
  }

  function move(delta) {
    const next = step(displayOrder(visibleItems(state, ui.filter)), openId, delta);
    if (next) select(next);
  }

  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }

  function toggleSet(set, id) {
    if (set.has(id)) set.delete(id);
    else set.add(id);
  }

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-sc-act]');
    if (!el) return;
    const act = el.dataset.scAct;
    const id = el.dataset.scId;
    if (act !== 'toggle') e.preventDefault();
    if (act !== 'menu' && menuOpen) {
      // Any other action closes the menu.
      menuOpen = false;
      renderPanel();
    }
    if (act === 'panel') {
      ui.open = !ui.open;
      menuOpen = false;
      saveUi();
      applyLayout();
      if (ui.open) sync(false);
    } else if (act === 'menu') {
      menuOpen = !menuOpen;
      renderPanel();
    } else if (act === 'wide') {
      ui.wide = !ui.wide;
      saveUi();
      renderPanel();
    } else if (act === 'filter') {
      ui.filter = el.dataset.scVal;
      saveUi();
      renderPanel();
    } else if (act === 'prev' || act === 'next') {
      if (el.dataset.scId) openId = el.dataset.scId;
      move(act === 'next' ? 1 : -1);
    } else if (act === 'markdone') {
      if (!confirm('Mark this pull request as done? Its cards leave the page.')) return;
      const now = new Date().toISOString();
      try {
        const r = await api('POST', '/api/close', { repo: loc.repo, pr: loc.number });
        if (r.status !== 200) throw new Error(r.body?.error ?? String(r.status));
        state.payload.closed_at = r.body.closed_at;
        message = null;
      } catch (err) {
        if (/not reachable|timed out/.test(err.message)) serverUp = false;
        state.doneAt = now;
        message = { text: `Marked as done in this browser. The server did not record it (${err.message}).` };
      }
      save();
      renderAll(true);
    } else if (act === 'showdone') {
      showDoneCards = !showDoneCards;
      renderAll(true);
    } else if (act === 'fetch') {
      sync(true);
    } else if (act === 'import') {
      try {
        adopt(parsePayload(await navigator.clipboard.readText()), 'clipboard');
      } catch (err) {
        message = { error: true, text: `Cannot read the clipboard (${err.message}). Paste the JSON into the box below.`, showPaste: true };
        renderPanel();
      }
    } else if (act === 'export') {
      sendDecisions();
    } else if (act === 'clear') {
      if (!confirm('Remove the proposals and decisions for this PR from this browser?')) return;
      GM_deleteValue(storageKey(loc.repo, loc.number));
      state = null;
      message = null;
      renderAll(true);
    } else if (act === 'toggle') {
      if (openId === id) {
        openId = null;
        renderPanel();
      } else {
        select(id);
      }
    } else if (act === 'jump') {
      jump(id);
    } else if (act === 'expand') {
      toggleSet(expanded, id);
      refreshThread(id);
    } else if (act === 'tab') {
      if (el.dataset.scVal === 'write') editing.add(id);
      else editing.delete(id);
      expanded.add(id);
      refreshThread(id);
      if (el.dataset.scVal === 'write') {
        const where = el.closest('.sc-card')?.dataset.scWhere;
        const area = document.querySelector(`.sc-card[data-sc-where="${where}"][data-sc-card="${CSS.escape(id)}"] textarea.sc-reply`);
        if (area) {
          autosize(area);
          area.focus();
        }
      }
    } else if (act === 'decide') {
      const d = state.decisions[id];
      d.decision = d.decision === el.dataset.scVal ? null : el.dataset.scVal;
      save();
      refreshThread(id);
    }
  });

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset?.scAct !== 'filterselect') return;
    ui.filter = el.value || 'all';
    saveUi();
    renderPanel();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target?.matches?.('.sc-reply, .sc-note')) e.target.blur();
  });

  document.addEventListener('keydown', (e) => {
    if (!state || !ui.open || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    // Arrows scroll the page as usual until a thread is selected in the panel; j/k always move.
    const arrows = Boolean(openId);
    if ((arrows && e.key === 'ArrowDown') || e.key === 'j') move(1);
    else if ((arrows && e.key === 'ArrowUp') || e.key === 'k') move(-1);
    else if (e.key === 'Enter' && openId) {
      toggleSet(expanded, openId);
      refreshThread(openId);
    } else if (openId && /^[1-9]$/.test(e.key)) {
      const b = decisionsFor(state.payload)[Number(e.key) - 1];
      if (!b || done()) return;
      const d = state.decisions[openId];
      d.decision = d.decision === b.key ? null : b.key;
      save();
      refreshThread(openId);
    } else if (openId && e.key === 'e' && !done()) {
      editing.add(openId);
      expanded.add(openId);
      refreshThread(openId);
      document.querySelector(`.sc-card[data-sc-card="${CSS.escape(openId)}"] textarea.sc-reply`)?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.classList?.contains('sc-paste')) {
      if (el.value.trim().startsWith('{') && el.value.trim().endsWith('}')) adopt(parsePayload(el.value), 'clipboard');
      return;
    }
    const name = el.dataset?.scField;
    if (!name || !state) return;
    const id = el.dataset.scId;
    const d = state.decisions[id];
    if (name === 'reply') {
      d.reply = el.value;
      d.replyEdited = d.reply !== (itemById(id).reply_en ?? '');
      autosize(el);
    } else {
      d.note = el.value;
      updateProgress(id);
    }
    save();
    // Keep the other copy of this card (panel vs inline) in step without stealing focus.
    document.querySelectorAll(`[data-sc-field="${name}"][data-sc-id="${CSS.escape(id)}"]`).forEach((other) => {
      if (other !== el) other.value = el.value;
    });
  });

  function needsRender() {
    const now = parseLocation(location.pathname);
    if (!now) return Boolean(document.querySelector('.sc-toggle'));
    if (!loc || now.repo !== loc.repo || now.number !== loc.number) return true;
    if (!document.querySelector('.sc-toggle')) return true;
    return showInline() && state.payload.items.some((it) => anchorFor(it) && !inlineCard(it.thread_id));
  }

  function render() {
    const now = parseLocation(location.pathname);
    if (!now) {
      loc = null;
      state = null;
      removeShell();
      return;
    }
    if (!loc || now.repo !== loc.repo || now.number !== loc.number) {
      loc = now;
      state = load();
      openId = null;
      message = null;
      showDoneCards = false;
      expanded.clear();
      editing.clear();
      renderAll(true);
      sync(false);
      return;
    }
    renderAll(false);
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(render, 300);
  }

  for (const eventName of ['turbo:load', 'turbo:render', 'pjax:end']) document.addEventListener(eventName, schedule);
  new MutationObserver(() => { if (!rendering && needsRender()) schedule(); }).observe(document.body, { childList: true, subtree: true });
  render();
}

if (typeof document !== 'undefined' && typeof GM_setValue !== 'undefined') secondChairBootstrap();
