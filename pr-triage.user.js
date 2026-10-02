// ==UserScript==
// @name         PR triage
// @namespace    pr-triage
// @version      0.4.0
// @description  An agent's proposal for every review thread, or for every comment of a draft review, shown next to it on GitHub; your decisions go back to the agent.
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
// @updateURL    http://127.0.0.1:7788/pr-triage.user.js
// @downloadURL  http://127.0.0.1:7788/pr-triage.user.js
// @run-at       document-idle
// ==/UserScript==

/* PR triage userscript.
   An agent writes a proposals payload: one item per review thread, round 1 to decide, round 2 to
   publish. In review mode the items are the comments of the agent's pending review on someone
   else's pull request instead, and you post, revise or drop each one. The script loads it from the local pr-triage server (or from the clipboard), shows a card
   under every thread, and sends your decisions back once every thread has one. An item the agent
   marks `auto` counts as decided with its proposal until you pick something else. Pure helpers live
   at top level so the test suite can evaluate this file with `new Function`; the DOM bootstrap at
   the bottom runs only in a browser. */

const PRT_TOOL = 'pr-triage';
const PRT_SERVER = 'http://127.0.0.1:7788';

// Decision buttons per mode and round. `reply` answers the threads on your own pull request; `review`
// decides the comments of a pending review you are about to submit. A decision with `needsNote` counts
// only once the note says what to change.
const PRT_DECISIONS = {
  reply: {
    1: [
      { key: 'reply', label: 'Reply' },
      { key: 'fix', label: 'Fix' },
      { key: 'pushback', label: 'Push back' },
      { key: 'manual', label: 'Manual' },
    ],
    2: [
      { key: 'publish', label: 'Publish' },
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
      { key: 'post', label: 'Post' },
      { key: 'drop', label: 'Drop' },
    ],
  },
};

const PRT_VERDICT_LABEL = { reply: 'reply', fix: 'fix', pushback: 'push back', manual: 'manual', publish: 'publish', hold: 'hold', post: 'post', revise: 'revise', drop: 'drop' };

function modeOf(payload) {
  return payload?.mode ?? 'reply';
}

/** The decision buttons for a payload's mode and round, or undefined when either is unknown. */
function decisionsFor(payload) {
  return PRT_DECISIONS[modeOf(payload)]?.[payload?.round];
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
  return `prt:${repo}#${number}`;
}

/** Checks a proposals object; returns { payload } or { error } with a message you can act on. */
function checkPayload(p) {
  if (!p || p.tool !== PRT_TOOL || p.kind !== 'proposals') return { error: 'Not a pr-triage proposals payload ("tool": "pr-triage", "kind": "proposals").' };
  if (!/^[^/]+\/[^/]+$/.test(p.repo ?? '') || !Number.isInteger(p.pr)) return { error: 'Missing "repo" or "pr".' };
  if (!PRT_DECISIONS[modeOf(p)]) return { error: `Unknown mode: ${p.mode}` };
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
  const sentAt = sameRound && (previous.payload.published_at ?? null) === (payload.published_at ?? null) ? previous.sentAt ?? null : null;
  return { payload, decisions, sentAt };
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

/** The decision that counts for an item: yours, or the proposal when the agent marked it `auto`. */
function effective(state, item) {
  const d = state.decisions[item.thread_id];
  if (d?.decision) return { decision: d.decision, auto: false };
  if (item.auto && item.verdict && decisionsFor(state.payload).some((b) => b.key === item.verdict)) return { decision: item.verdict, auto: true };
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

const PRT_FILTERS = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'todo', label: 'To decide', test: (e) => !e.decision },
  { key: 'auto', label: 'Auto', test: (e) => e.auto },
  { key: 'mine', label: 'Mine', test: (e) => e.decision && !e.auto },
];

/** The filter chips for a round: the fixed ones, then one per decision. */
function filtersFor(payload) {
  return [...PRT_FILTERS, ...decisionsFor(payload).map((b) => ({ key: `d:${b.key}`, label: b.label, test: (e) => e.decision === b.key }))];
}

function visibleItems(state, filterKey) {
  const f = filtersFor(state.payload).find((x) => x.key === filterKey) ?? PRT_FILTERS[0];
  return state.payload.items.filter((it) => f.test(effective(state, it)));
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
    tool: PRT_TOOL,
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
 * remembers per thread: { expanded, editing, hidden } plus `sent`/`closed` for the whole round.
 */
function buildCard(state, item, where, view = {}) {
  const p = state.payload;
  const d = state.decisions[item.thread_id];
  const e = effective(state, item);
  const links = threadLinks(p.repo, p.pr, item.comment_id);
  const compact = !view.expanded && (e.auto || view.sent || view.closed);
  const verdict = item.verdict ? `<span class="prt-verdict prt-v-${esc(item.verdict)}">Proposed: ${esc(PRT_VERDICT_LABEL[item.verdict] ?? item.verdict)}</span>` : '';
  const badges = [
    e.auto ? '<span class="prt-badge prt-auto">auto</span>' : '',
    view.hidden ? '<span class="prt-badge prt-hidden" title="GitHub has not loaded this thread on the page">hidden</span>' : '',
    e.decision ? `<span class="prt-done">✓ ${esc(decisionLabel(p, e.decision))}</span>` : '',
  ].join(' ');
  const head = [
    `<span class="prt-author">${esc(item.author ?? 'general')}</span>`,
    item.path ? `<code class="prt-path" title="${esc(item.path)}">${esc(shortPath(item.path, item.line))}</code>` : '',
    verdict,
    badges,
  ].join(' ');
  const jump = where === 'panel' && links
    ? `<a href="#" data-prt-act="jump" data-prt-id="${esc(item.thread_id)}">jump</a> · <a href="${esc(links.files)}">in files</a>`
    : '';
  const expander = `<a href="#" data-prt-act="expand" data-prt-id="${esc(item.thread_id)}">${compact ? 'expand' : 'collapse'}</a>`;
  const showExpander = e.auto || view.sent || view.closed;
  const cls = `prt-card${e.decision ? ' prt-decided' : ''}${compact ? ' prt-compact' : ''}`;
  const open = `<div class="${cls}" data-prt-card="${esc(item.thread_id)}" data-prt-where="${where}">
  <div class="prt-head">${head}<span class="prt-links">${jump}${jump && showExpander ? ' · ' : ''}${showExpander ? expander : ''}</span></div>`;
  if (compact) {
    const firstLine = String(d.reply || field(item, 'summary')).split('\n').find((l) => l.trim()) ?? '';
    return `${open}<div class="prt-oneline">${richText(firstLine)}</div></div>`;
  }
  const summary = field(item, 'summary');
  const context = field(item, 'context');
  const fix = field(item, 'fix');
  const commits = Array.isArray(item.commits) && item.commits.length ? `<div class="prt-row"><b>Commits:</b> ${item.commits.map((c) => `<code>${esc(c)}</code>`).join(' ')}</div>` : '';
  const review = modeOf(p) === 'review';
  const needNote = missingNote(state, item);
  const buttons = decisionsFor(p).map((b) => {
    const bc = ['prt-btn'];
    if (d.decision === b.key) bc.push('prt-on');
    else if (e.auto && e.decision === b.key) bc.push('prt-on-auto');
    else if (!e.decision && item.verdict === b.key) bc.push('prt-suggested');
    return `<button type="button" class="${bc.join(' ')}" data-prt-act="decide" data-prt-id="${esc(item.thread_id)}" data-prt-val="${b.key}">${esc(b.label)}</button>`;
  }).join('');
  const replyBody = view.editing
    ? `<textarea class="prt-reply" data-prt-field="reply" data-prt-id="${esc(item.thread_id)}" rows="${rowsFor(d.reply, where === 'panel' ? 70 : 110)}">${esc(d.reply)}</textarea>`
    : `<div class="prt-md prt-reply-view">${renderMarkdown(d.reply) || '<span class="prt-empty">Nothing to post.</span>'}</div>`;
  return `${open}
  ${summary ? `<div class="prt-summary prt-md">${renderMarkdown(summary)}</div>` : ''}
  ${context ? `<div class="prt-context"><div class="prt-label">Context — for you</div><div class="prt-md">${renderMarkdown(context)}</div></div>` : ''}
  ${fix ? `<div class="prt-row"><b>How to fix:</b> <span class="prt-md prt-inline-md">${renderMarkdown(fix)}</span></div>` : ''}
  ${commits}
  <div class="prt-label">${review ? (item.comment_id ? 'Comment to post' : 'Review body') : 'Reply to post'}${d.replyEdited ? ' <span class="prt-edited">(edited)</span>' : ''} <a href="#" class="prt-edit" data-prt-act="edit" data-prt-id="${esc(item.thread_id)}">${view.editing ? 'preview' : 'edit'}</a></div>
  ${replyBody}
  <div class="prt-buttons">${buttons}</div>
  <input class="prt-note${needNote ? ' prt-note-needed' : ''}" data-prt-field="note" data-prt-id="${esc(item.thread_id)}" placeholder="${needNote ? 'What should change? Revise needs a note' : 'Note for the agent (optional)'}" value="${esc(d.note)}">
</div>`;
}

function buildPanelList(state, openId, filterKey, viewOf) {
  const p = state.payload;
  return visibleItems(state, filterKey).map((it) => {
    const e = effective(state, it);
    const v = viewOf(it);
    const label = e.decision ? `${e.auto ? 'auto: ' : ''}${decisionLabel(p, e.decision)}${missingNote(state, it) ? ' (needs a note)' : ''}` : '—';
    const open = it.thread_id === openId;
    return `<div class="prt-item${e.decision ? ' prt-decided' : ''}${e.auto ? ' prt-is-auto' : ''}${open ? ' prt-open' : ''}" data-prt-item="${esc(it.thread_id)}">
  <div class="prt-item-head" data-prt-act="toggle" data-prt-id="${esc(it.thread_id)}">
    <span class="prt-dot"></span><span class="prt-author">${esc(it.author ?? 'general')}</span>
    <code class="prt-path">${esc(shortPath(it.path, it.line))}</code>
    ${v.hidden ? '<span class="prt-badge prt-hidden">hidden</span>' : ''}
    <span class="prt-item-dec">${esc(label)}</span>
    <div class="prt-item-sum">${esc(field(it, 'summary'))}</div>
  </div>
  ${open ? buildCard(state, it, 'panel', { ...v, expanded: true }) : ''}
</div>`;
  }).join('');
}

function buildFilterBar(state, filterKey) {
  return filtersFor(state.payload).map((f) => {
    const n = state.payload.items.filter((it) => f.test(effective(state, it))).length;
    if (n === 0 && f.key !== 'all' && f.key !== filterKey) return '';
    return `<button type="button" class="prt-chip${f.key === filterKey ? ' prt-chip-on' : ''}" data-prt-act="filter" data-prt-val="${f.key}">${esc(f.label)} <b>${n}</b></button>`;
  }).join('');
}

const PRT_CSS = `
.prt-toggle{position:fixed;right:16px;bottom:16px;z-index:9999;padding:8px 14px;border-radius:20px;border:1px solid var(--borderColor-default,#d0d7de);background:var(--bgColor-default,#fff);color:var(--fgColor-default,#1f2328);font:600 13px/1.2 -apple-system,system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2)}
.prt-toggle.prt-complete{border-color:var(--fgColor-success,#1a7f37);color:var(--fgColor-success,#1a7f37)}
.prt-panel{position:fixed;top:0;right:0;bottom:0;width:min(520px,92vw);z-index:9998;display:flex;flex-direction:column;background:var(--bgColor-default,#fff);color:var(--fgColor-default,#1f2328);border-left:1px solid var(--borderColor-default,#d0d7de);box-shadow:-4px 0 16px rgba(0,0,0,.15);font:13px/1.55 -apple-system,system-ui,sans-serif}
.prt-panel.prt-wide{width:50vw}
.prt-panel[hidden]{display:none}
html.prt-shift-narrow body{margin-right:min(520px,92vw)!important}
html.prt-shift-wide body{margin-right:50vw!important}
.prt-bar{padding:8px 12px;border-bottom:1px solid var(--borderColor-default,#d0d7de);display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.prt-bar .prt-title{font-weight:600;margin-right:auto}
.prt-server{font-size:11px;padding:1px 7px;border-radius:10px;border:1px solid currentColor}
.prt-server.prt-up{color:var(--fgColor-success,#1a7f37)}
.prt-server.prt-down{color:var(--fgColor-muted,#59636e)}
.prt-bar button,.prt-btn,.prt-chip{padding:3px 10px;border-radius:6px;border:1px solid var(--borderColor-default,#d0d7de);background:var(--bgColor-muted,#f6f8fa);color:inherit;font:inherit;cursor:pointer}
.prt-bar button:disabled{opacity:.45;cursor:not-allowed}
.prt-chip{border-radius:12px;font-size:12px;padding:1px 9px}
.prt-chip b{font-weight:600;margin-left:2px}
.prt-chip.prt-chip-on{background:var(--fgColor-accent,#0969da);border-color:var(--fgColor-accent,#0969da);color:#fff}
.prt-nav{font-size:12px;color:var(--fgColor-muted,#59636e)}
.prt-nav button{font-size:14px;padding:0 10px}
.prt-list{overflow:auto;flex:1;padding:8px 10px 60px}
.prt-msg{padding:8px 12px;font-size:12px;border-bottom:1px solid var(--borderColor-default,#d0d7de)}
.prt-msg.prt-err{color:var(--fgColor-danger,#d1242f)}
.prt-banner{padding:8px 12px;border-bottom:1px solid var(--borderColor-default,#d0d7de);background:var(--bgColor-success-muted,#dafbe1)}
.prt-paste{margin:8px 12px;width:calc(100% - 24px);min-height:90px;font:12px ui-monospace,monospace}
.prt-item{border:1px solid var(--borderColor-default,#d0d7de);border-radius:6px;margin-bottom:6px}
.prt-item-head{padding:6px 8px;cursor:pointer;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.prt-item-sum{flex-basis:100%;color:var(--fgColor-muted,#59636e);font-size:12px}
.prt-item-dec{margin-left:auto;font-size:12px;font-weight:600}
.prt-dot{width:8px;height:8px;border-radius:50%;background:var(--fgColor-attention,#9a6700)}
.prt-decided .prt-dot{background:var(--fgColor-success,#1a7f37)}
.prt-is-auto .prt-dot{background:var(--fgColor-muted,#8c959f)}
.prt-item.prt-open{border-color:var(--fgColor-accent,#0969da);box-shadow:0 0 0 1px var(--fgColor-accent,#0969da)}
.prt-card{padding:10px 12px;border-top:1px dashed var(--borderColor-default,#d0d7de);font:13px/1.6 -apple-system,system-ui,sans-serif;color:var(--fgColor-default,#1f2328)}
.prt-card[data-prt-where=inline]{margin:8px 0;border:2px solid var(--fgColor-accent,#0969da);border-radius:6px;background:var(--bgColor-default,#fff)}
.prt-card[data-prt-where=inline].prt-decided{border-color:var(--fgColor-success,#1a7f37)}
.prt-card[data-prt-where=inline].prt-compact{border-width:1px;border-style:dashed;padding:6px 10px}
.prt-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:6px}
.prt-compact .prt-head{margin-bottom:2px}
.prt-oneline{color:var(--fgColor-muted,#59636e);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.prt-links{margin-left:auto;font-size:12px}
.prt-author{font-weight:600}
.prt-path{font-size:11px}
.prt-verdict,.prt-badge{font-size:11px;padding:1px 7px;border-radius:10px;border:1px solid currentColor}
.prt-badge.prt-auto{color:var(--fgColor-muted,#59636e)}
.prt-badge.prt-hidden{color:var(--fgColor-attention,#9a6700)}
.prt-v-fix{color:var(--fgColor-accent,#0969da)}
.prt-v-pushback,.prt-v-hold{color:var(--fgColor-severe,#bc4c00)}
.prt-v-manual{color:var(--fgColor-danger,#d1242f)}
.prt-v-reply,.prt-v-publish,.prt-v-post{color:var(--fgColor-success,#1a7f37)}
.prt-v-revise{color:var(--fgColor-accent,#0969da)}
.prt-v-drop{color:var(--fgColor-severe,#bc4c00)}
.prt-note.prt-note-needed{border-color:var(--fgColor-danger,#d1242f)}
.prt-done{color:var(--fgColor-success,#1a7f37);font-weight:600;font-size:12px}
.prt-summary{font-weight:600;margin-bottom:6px}
.prt-context{background:var(--bgColor-attention-muted,#fff8c5);border-left:3px solid var(--fgColor-attention,#9a6700);padding:6px 10px;margin:6px 0;border-radius:4px}
.prt-label{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--fgColor-muted,#59636e);margin:8px 0 3px}
.prt-label a{text-transform:none;letter-spacing:0;margin-left:6px}
.prt-context .prt-label{margin-top:0}
.prt-edited{text-transform:none;color:var(--fgColor-severe,#bc4c00)}
.prt-row{margin:6px 0}
.prt-md>:first-child{margin-top:0}.prt-md>:last-child{margin-bottom:0}
.prt-md p,.prt-md ul,.prt-md ol,.prt-md pre,.prt-md table,.prt-md blockquote{margin:0 0 8px}
.prt-md ul,.prt-md ol{padding-left:22px}
.prt-md h1,.prt-md h2,.prt-md h3,.prt-md h4{font-size:14px;margin:10px 0 6px}
.prt-md table{border-collapse:collapse}
.prt-md th,.prt-md td{border:1px solid var(--borderColor-default,#d0d7de);padding:2px 8px}
.prt-md pre{padding:8px;border-radius:6px;background:var(--bgColor-muted,#f6f8fa);overflow:auto}
.prt-md blockquote{padding-left:10px;border-left:3px solid var(--borderColor-default,#d0d7de);color:var(--fgColor-muted,#59636e)}
.prt-inline-md,.prt-inline-md>p{display:inline}
.prt-reply-view{padding:8px 10px;border:1px solid var(--borderColor-default,#d0d7de);border-radius:6px;background:var(--bgColor-default,#fff)}
.prt-empty{color:var(--fgColor-muted,#59636e);font-style:italic}
.prt-reply{width:100%;box-sizing:border-box;font:13px/1.5 ui-monospace,SFMono-Regular,monospace;padding:6px;border:1px solid var(--fgColor-accent,#0969da);border-radius:6px;background:var(--bgColor-default,#fff);color:inherit;resize:vertical;overflow:hidden}
.prt-note{width:100%;box-sizing:border-box;margin-top:6px;padding:4px 6px;border:1px solid var(--borderColor-default,#d0d7de);border-radius:6px;background:var(--bgColor-default,#fff);color:inherit;font:12px -apple-system,system-ui,sans-serif}
.prt-buttons{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.prt-btn.prt-suggested{border-style:dashed;border-color:var(--fgColor-accent,#0969da)}
.prt-btn.prt-on{background:var(--fgColor-accent,#0969da);border-color:var(--fgColor-accent,#0969da);color:#fff}
.prt-btn.prt-on-auto{border-color:var(--fgColor-accent,#0969da);color:var(--fgColor-accent,#0969da);font-weight:600}
.prt-card code,.prt-item code{font-size:11.5px;padding:0 4px;border-radius:4px;background:var(--bgColor-muted,#f6f8fa)}
.prt-md pre code{padding:0;background:none}
.prt-flash{outline:3px solid var(--fgColor-accent,#0969da);outline-offset:2px;transition:outline-color 1.5s}
`;

function prTriageBootstrap() {
  let loc = null;
  let state = null;
  let openId = null;
  let message = null;
  let serverUp = null;
  let rendering = false;
  let timer = null;
  const expanded = new Set();
  const editing = new Set();
  const ui = (() => {
    try {
      return { filter: 'all', wide: false, open: false, showClosed: false, ...JSON.parse(GM_getValue('prt:ui', '{}')) };
    } catch {
      return { filter: 'all', wide: false, open: false, showClosed: false };
    }
  })();
  const saveUi = () => GM_setValue('prt:ui', JSON.stringify(ui));

  const load = () => {
    const raw = GM_getValue(storageKey(loc.repo, loc.number), null);
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  const save = () => GM_setValue(storageKey(loc.repo, loc.number), JSON.stringify(state));
  const closed = () => Boolean(state?.payload.closed_at);
  const itemById = (id) => state.payload.items.find((x) => x.thread_id === id);
  const viewOf = (it) => ({
    expanded: expanded.has(it.thread_id),
    editing: editing.has(it.thread_id),
    hidden: Boolean(it.comment_id) && !anchorFor(it),
    sent: Boolean(state.sentAt),
    closed: closed(),
  });

  /** Resolves { status, body } from the local server; rejects when it is not running. */
  function api(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: `${PRT_SERVER}${path}`,
        // The custom header is what the server checks to refuse requests a web page could forge.
        headers: { 'Content-Type': 'application/json', 'X-PR-Triage': '1' },
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
    if (!document.getElementById('prt-style')) {
      const style = document.createElement('style');
      style.id = 'prt-style';
      style.textContent = PRT_CSS;
      document.head.appendChild(style);
    }
    if (!document.querySelector('.prt-toggle')) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'prt-toggle';
      toggle.dataset.prtAct = 'panel';
      document.body.appendChild(toggle);
      const panel = document.createElement('div');
      panel.className = 'prt-panel';
      panel.hidden = !ui.open;
      document.body.appendChild(panel);
    }
  }

  function removeShell() {
    document.querySelectorAll('.prt-toggle, .prt-panel, .prt-card[data-prt-where=inline]').forEach((n) => n.remove());
    document.documentElement.classList.remove('prt-shift-narrow', 'prt-shift-wide');
  }

  function applyLayout() {
    const panel = document.querySelector('.prt-panel');
    if (!panel) return;
    panel.hidden = !ui.open;
    panel.classList.toggle('prt-wide', ui.wide);
    // The page narrows next to the panel instead of hiding under it.
    document.documentElement.classList.toggle('prt-shift-narrow', ui.open && !ui.wide);
    document.documentElement.classList.toggle('prt-shift-wide', ui.open && ui.wide);
  }

  function renderPanel() {
    const panel = document.querySelector('.prt-panel');
    const toggle = document.querySelector('.prt-toggle');
    if (!panel || !toggle) return;
    const listEl = panel.querySelector('.prt-list');
    const scrollTop = listEl ? listEl.scrollTop : 0;
    const pr = state ? progress(state) : null;
    toggle.textContent = !pr ? 'Triage' : closed() ? `Triage r${state.payload.round} ✓ closed` : `Triage r${state.payload.round} · ${pr.done}/${pr.total}`;
    toggle.classList.toggle('prt-complete', Boolean(pr && pr.complete));
    const title = state ? `#${state.payload.pr}${modeOf(state.payload) === 'review' ? ' review' : ''} round ${state.payload.round}${state.payload.head ? ` @ ${String(state.payload.head).slice(0, 8)}` : ''}` : 'No proposals';
    const server = serverUp === null ? '' : `<span class="prt-server ${serverUp ? 'prt-up' : 'prt-down'}" title="${PRT_SERVER}">server ${serverUp ? 'on' : 'off'}</span>`;
    const bar = `<div class="prt-bar"><span class="prt-title">${esc(title)}${pr ? ` — ${pr.done}/${pr.total}${pr.auto ? ` (${pr.auto} auto)` : ''}` : ''}</span>${server}
  <button type="button" data-prt-act="wide" title="Toggle half-screen width">${ui.wide ? '⇥ narrow' : '⇤ half screen'}</button>
  <button type="button" data-prt-act="panel">✕</button></div>
  <div class="prt-bar">
  <button type="button" data-prt-act="fetch" ${serverUp ? '' : 'disabled'}>Load from server</button>
  <button type="button" data-prt-act="import">Load from clipboard</button>
  <button type="button" data-prt-act="export" ${pr && pr.complete && !closed() ? '' : 'disabled'} title="${pr && !pr.complete ? `${pr.total - pr.done} left` : ''}">Send decisions</button>
  ${state ? '<button type="button" data-prt-act="clear">Clear</button>' : ''}</div>`;
    let banner = '';
    if (closed()) banner = `<div class="prt-banner">This round is closed (${esc(state.payload.closed_at)}). Cards are hidden on the page. <a href="#" data-prt-act="showclosed">${ui.showClosed ? 'Hide them' : 'Show them anyway'}</a></div>`;
    else if (state?.sentAt) banner = `<div class="prt-banner">Decisions sent ${esc(state.sentAt)}. The agent picks them up from the server; the next round loads here.</div>`;
    let tools = '';
    if (state) {
      const items = visibleItems(state, ui.filter);
      const pos = items.findIndex((it) => it.thread_id === openId);
      tools = `<div class="prt-bar">${buildFilterBar(state, ui.filter)}</div>
  <div class="prt-bar prt-nav"><button type="button" data-prt-act="prev" title="Previous (↑ or k)">‹</button><span>${pos < 0 ? '–' : pos + 1} / ${items.length}</span><button type="button" data-prt-act="next" title="Next (↓ or j)">›</button><span>↑/↓ or j/k move · Enter expands</span></div>`;
    }
    const msg = message ? `<div class="prt-msg${message.error ? ' prt-err' : ''}">${richText(message.text)}</div>` : '';
    const paste = !state || message?.showPaste ? '<textarea class="prt-paste" placeholder="Or paste the proposals JSON here (Ctrl+V)"></textarea>' : '';
    panel.innerHTML = `${bar}${banner}${tools}${msg}${paste}<div class="prt-list">${state ? buildPanelList(state, openId, ui.filter, viewOf) : ''}</div>`;
    panel.querySelector('.prt-list').scrollTop = scrollTop;
    applyLayout();
  }

  /** Updates the counter, the send button and the note markers in place, so typing a note keeps its focus. */
  function updateProgress(id) {
    const pr = progress(state);
    const toggle = document.querySelector('.prt-toggle');
    if (toggle && !closed()) toggle.textContent = `Triage r${state.payload.round} · ${pr.done}/${pr.total}`;
    toggle?.classList.toggle('prt-complete', pr.complete);
    const send = document.querySelector('.prt-panel [data-prt-act=export]');
    if (send) send.disabled = !(pr.complete && !closed());
    const needed = missingNote(state, itemById(id));
    document.querySelectorAll(`.prt-note[data-prt-id="${CSS.escape(id)}"]`).forEach((n) => n.classList.toggle('prt-note-needed', needed));
  }

  function anchorFor(item) {
    if (!item.comment_id) return null;
    return document.getElementById(`discussion_r${item.comment_id}`) || document.getElementById(`r${item.comment_id}`);
  }

  const inlineCard = (id) => document.querySelector(`.prt-card[data-prt-where=inline][data-prt-card="${CSS.escape(id)}"]`);
  const showInline = () => Boolean(state) && (!closed() || ui.showClosed);

  function cardElement(it) {
    const holder = document.createElement('div');
    holder.innerHTML = buildCard(state, it, 'inline', viewOf(it));
    return holder.firstElementChild;
  }

  /** Adds the cards that are missing, for threads GitHub loaded since the last pass; leaves the others alone. */
  function renderInline() {
    if (!showInline()) {
      document.querySelectorAll('.prt-card[data-prt-where=inline]').forEach((n) => n.remove());
      return;
    }
    for (const it of state.payload.items) {
      const anchor = anchorFor(it);
      if (!anchor || inlineCard(it.thread_id)) continue;
      anchor.insertAdjacentElement('afterend', cardElement(it));
    }
  }

  function rebuildInline() {
    document.querySelectorAll('.prt-card[data-prt-where=inline]').forEach((n) => n.remove());
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
      const wasClosed = closed();
      state = stateFor(res.payload, state);
      save();
      if (closed() && !wasClosed) ui.showClosed = false;
      message = { text: closed() ? 'This round is closed.' : `Loaded ${res.payload.items.length} ${modeOf(res.payload) === 'review' ? 'review comments' : 'threads'}, round ${res.payload.round}, from the ${source}.` };
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
      if (force) message = { error: true, text: `The server at ${PRT_SERVER} is not running. Start it with \`pr-triage serve\`, or load from the clipboard.` };
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
        save();
        message = null;
        renderAll(true);
        return;
      }
      GM_setClipboard(JSON.stringify(out, null, 2), 'text');
      message = { error: true, text: `The server refused the decisions (${r.status}: ${r.body?.error ?? 'no reason'}). They are on the clipboard instead.` };
    } catch {
      serverUp = false;
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
    target.classList.add('prt-flash');
    setTimeout(() => target.classList.remove('prt-flash'), 1600);
    if (message?.error) {
      message = null;
      renderPanel();
    }
  }

  function select(id) {
    openId = id;
    renderPanel();
    const row = document.querySelector(`.prt-item[data-prt-item="${CSS.escape(id)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
    jump(id);
  }

  function move(delta) {
    const next = step(visibleItems(state, ui.filter), openId, delta);
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
    const el = e.target.closest('[data-prt-act]');
    if (!el) return;
    const act = el.dataset.prtAct;
    const id = el.dataset.prtId;
    if (act !== 'toggle') e.preventDefault();
    if (act === 'panel') {
      ui.open = !ui.open;
      saveUi();
      applyLayout();
      if (ui.open) sync(false);
    } else if (act === 'wide') {
      ui.wide = !ui.wide;
      saveUi();
      renderPanel();
    } else if (act === 'filter') {
      ui.filter = el.dataset.prtVal;
      saveUi();
      renderPanel();
    } else if (act === 'prev' || act === 'next') {
      move(act === 'next' ? 1 : -1);
    } else if (act === 'showclosed') {
      ui.showClosed = !ui.showClosed;
      saveUi();
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
    } else if (act === 'edit') {
      toggleSet(editing, id);
      expanded.add(id);
      refreshThread(id);
      const where = el.closest('.prt-card')?.dataset.prtWhere;
      const area = document.querySelector(`.prt-card[data-prt-where="${where}"][data-prt-card="${CSS.escape(id)}"] textarea.prt-reply`);
      if (area) {
        autosize(area);
        area.focus();
      }
    } else if (act === 'decide') {
      const d = state.decisions[id];
      d.decision = d.decision === el.dataset.prtVal ? null : el.dataset.prtVal;
      save();
      refreshThread(id);
    }
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
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.classList?.contains('prt-paste')) {
      if (el.value.trim().startsWith('{') && el.value.trim().endsWith('}')) adopt(parsePayload(el.value), 'clipboard');
      return;
    }
    const name = el.dataset?.prtField;
    if (!name || !state) return;
    const id = el.dataset.prtId;
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
    document.querySelectorAll(`[data-prt-field="${name}"][data-prt-id="${CSS.escape(id)}"]`).forEach((other) => {
      if (other !== el) other.value = el.value;
    });
  });

  function needsRender() {
    const now = parseLocation(location.pathname);
    if (!now) return Boolean(document.querySelector('.prt-toggle'));
    if (!loc || now.repo !== loc.repo || now.number !== loc.number) return true;
    if (!document.querySelector('.prt-toggle')) return true;
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

if (typeof document !== 'undefined' && typeof GM_setValue !== 'undefined') prTriageBootstrap();
