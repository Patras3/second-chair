// ==UserScript==
// @name         Second Chair
// @namespace    https://github.com/Patras3/second-chair
// @version      1.3.0
// @icon         data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2016%2016%22%20fill=%22none%22%20stroke=%22%231f2328%22%20stroke-width=%221.5%22%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22%3E%3Cpath%20d=%22M5.75%201.75%205.25%209.25M3.75%209.25h8.5M5.25%209.25l-1%205M11%209.25l1%205%22/%3E%3C/svg%3E
// @description  AI prepares. You decide. Your agent's proposal for every review thread, next to it on GitHub.
// @match        https://github.com/*
// @require      https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js
// @require      https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
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

// The mark: one chair seen from the side. It draws in the current text colour, so it follows light and dark.
const SC_LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="sc-logo" aria-hidden="true"><path d="M5.75 1.75 5.25 9.25M3.75 9.25h8.5M5.25 9.25l-1 5M11 9.25l1 5"/></svg>';

// Decision buttons per mode and round. `reply` answers the threads on your own pull request; `review`
// decides the comments of a pending review you are about to submit. A decision with `needsNote` counts
// only once the note says what to change. A decision with `posts` puts text on GitHub, so `auto` never
// picks it: the user approves every posted text. A `derived` decision has no button: the page sets it from the
// notes on the code.
const SC_DECISIONS = {
  reply: {
    1: [
      { key: 'reply', label: 'Reply', help: 'Answer only. No code change. The reply is posted after round 2.' },
      { key: 'fix', label: 'Fix', help: 'The agent changes the code as planned and commits it, without pushing. You approve the reply in round 2.' },
      { key: 'pushback', label: 'Push back', help: 'Disagree. The reply explains why. Posted after round 2.' },
      { key: 'manual', label: 'Manual', help: 'You handle this thread yourself. The agent posts nothing.' },
    ],
    2: [
      { key: 'publish', label: 'Publish', posts: true, help: 'Post this reply on GitHub, with the text as shown.' },
      { key: 'revise', label: 'Revise', needsNote: true, help: 'Ask the agent for a new version. Say what to change in the note. Nothing is posted until you approve it.' },
      { key: 'hold', label: 'Hold', help: 'Post nothing for now. The thread stays open on GitHub.' },
      { key: 'manual', label: 'Manual', help: 'You answer this thread yourself. The agent posts nothing.' },
      { key: 'change', label: 'Change code', derived: true, help: 'Set by a note on the code. The agent changes the code, and you decide the reply again on the new commit.' },
    ],
  },
  review: {
    1: [
      { key: 'post', label: 'Keep', help: 'Keep this comment in your draft review, with the text as shown.' },
      { key: 'revise', label: 'Revise', needsNote: true, help: 'Ask the agent to rewrite this comment. Say what to change in the note.' },
      { key: 'drop', label: 'Drop', help: 'Remove this comment from your draft review.' },
    ],
    2: [
      { key: 'post', label: 'Keep', posts: true, help: 'Keep this comment in your review, with the text as shown.' },
      { key: 'revise', label: 'Revise', needsNote: true, help: 'Ask the agent for a new version. Nothing is applied until you approve it.' },
      { key: 'drop', label: 'Drop', help: 'Remove this comment from your draft review.' },
    ],
  },
};

// The modes as the commands name them; the payload keeps `reply` for respond.
const SC_MODE_NAME = { reply: 'Respond', review: 'Review' };
// Review submit events, as GitHub names them, with what each does.
const SC_EVENTS = [
  { key: 'COMMENT', label: 'Comment', help: 'Submit the review as a comment, without approving or blocking.' },
  { key: 'APPROVE', label: 'Approve', help: 'Submit the review and approve the pull request.' },
  { key: 'REQUEST_CHANGES', label: 'Request changes', help: 'Submit the review and ask for changes before merging. Needs a review body.' },
];

function modeOf(payload) {
  return payload?.mode ?? 'reply';
}

/** The decision buttons for a payload's mode and round, or undefined when either is unknown. */
function decisionsFor(payload) {
  return SC_DECISIONS[modeOf(payload)]?.[payload?.round];
}

/** The decisions the user picks with a button or a number key: all but the derived ones. */
function choicesFor(payload) {
  return decisionsFor(payload).filter((b) => !b.derived);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Escaped text with `code` spans and line breaks, nothing else. */
function richText(s) {
  return esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
}

// Markdown comes from the payload. It may not carry page styles, classes, forms or the data-sc-* attributes that the
// click handler acts on. A class could pose as the panel or pull in page and script styles. Task-list checkboxes are inputs, so they are lost too.
const SC_PURIFY = {
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'input'],
  FORBID_ATTR: ['style', 'class'],
};

/** Markdown as sanitized HTML when marked and DOMPurify are loaded; plain text with code spans otherwise. */
function renderMarkdown(md) {
  const text = String(md ?? '');
  if (!text.trim()) return '';
  const m = typeof marked !== 'undefined' ? marked : null;
  const purify = typeof DOMPurify !== 'undefined' ? DOMPurify : null;
  if (m && purify && typeof purify.sanitize === 'function') {
    return purify.sanitize(m.parse(text, { gfm: true, breaks: false }), SC_PURIFY);
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

/** True when the payload still carries patch texts, as a payload pasted from `build` does. */
function hasPatches(p) {
  return Boolean(p?.changes) && [...p.changes.commits, ...p.changes.range.files.map((f) => ({ files: [f] }))].some((k) => k.files.some((f) => typeof f.patch === 'string'));
}

/** A copy without patch texts. The stored state never holds them: GM storage is small and written on every key. */
function withoutPatches(p) {
  if (!p?.changes) return p;
  const lean = ({ patch, ...rest }) => rest;
  return { ...p, changes: { ...p.changes, commits: p.changes.commits.map((k) => ({ ...k, files: k.files.map(lean) })), range: { ...p.changes.range, files: p.changes.range.files.map(lean) } } };
}

/** A loaded payload split in two: the payload the state keeps, and the patches, or null when it has none. */
function splitPatches(payload) {
  return { payload: withoutPatches(payload), patches: hasPatches(payload) ? payload.changes : null };
}

const SC_FOLD_LINES = 400;
const SC_FOLD_CHARS = 200000;

const isSafeSha = (s) => /^[0-9a-f]{40}$/.test(String(s));

/**
 * A count from the payload, as text. A pasted payload is not checked by the server, so a count is forced to a number
 * before it reaches the markup. Thousands get a space: 2 424.
 */
function fmtCount(n) {
  return String(Math.max(0, Math.trunc(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** `+add −del` for a file, a commit or the range, with an empty side left out. */
function countsHtml(x) {
  const add = Number(x.add) || 0;
  const del = Number(x.del) || 0;
  return `<span class="sc-plus">${add ? `+${fmtCount(add)}` : ''}</span> <span class="sc-minus">${del ? `−${fmtCount(del)}` : ''}</span>`;
}

/** The lines of a unified diff, numbered on both sides. Lines before the first hunk header are git's header and are skipped. */
function parsePatch(patch) {
  const out = [];
  let o = 0;
  let n = 0;
  for (const raw of String(patch ?? '').split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      out.push({ kind: 'hunk', old: null, new: null, text: raw });
    } else if (!out.length) continue;
    else if (raw.startsWith('+')) out.push({ kind: 'add', old: null, new: n++, text: raw.slice(1) });
    else if (raw.startsWith('-')) out.push({ kind: 'del', old: o++, new: null, text: raw.slice(1) });
    else if (raw.startsWith(' ')) out.push({ kind: 'ctx', old: o++, new: n++, text: raw.slice(1) });
    else if (raw.startsWith('\\')) out.push({ kind: 'meta', old: null, new: null, text: raw });
  }
  return out;
}

/** Marked lines as the agent reads them: runs of new-side lines, then of removed lines. */
function markLabel(lines) {
  const runs = [];
  for (const side of ['new', 'old']) {
    for (const v of lines.filter((l) => l.side === side).map((l) => l.n).sort((a, b) => a - b)) {
      const last = runs.at(-1);
      if (last && last.side === side && v === last.to + 1) last.to = v;
      else runs.push({ side, from: v, to: v });
    }
  }
  return runs.map((r) => `${r.side === 'old' ? 'old ' : ''}L${r.from}${r.to > r.from ? `–${r.to}` : ''}`).join(', ');
}

/** The commit a note on `path` belongs to: the one shown, or in the range view the newest that changed the file. */
function noteTarget(changes, view, path) {
  if (view.kind === 'commit') return view.sha;
  return changes.range.files.find((f) => f.path === path)?.commits.at(-1) ?? null;
}

function isLargeFile(f) {
  return f.add + f.del > SC_FOLD_LINES || String(f.patch ?? '').length > SC_FOLD_CHARS;
}

/** The files a view shows: the net diff of the range, or one commit's. */
function diffFiles(changes, view) {
  if (view.kind === 'range') return changes.range.files;
  return changes.commits.find((k) => k.sha === view.sha)?.files ?? [];
}

/** The popup over the page: commits and files on the left, the diff with one note per file on the right. */
function buildDiff(state, patches, d, readOnly) {
  const ch = state.payload.changes;
  const src = patches ?? ch;
  const view = d.view;
  const commit = view.kind === 'commit' ? ch.commits.find((k) => k.sha === view.sha) : null;
  const cmd = commit ? `git show ${commit.sha}` : `git log -p ${ch.base}..${ch.head}`;
  const safe = isSafeSha(ch.base) && isSafeSha(ch.head) && (!commit || isSafeSha(commit.sha));
  const counts = countsHtml;
  const codeNotes = state.codeNotes ?? {};
  const notesOn = (sha) => Object.values(codeNotes).filter((n) => n.sha === sha).length;
  const cites = (sha) => state.payload.items.filter((it) => (it.commits ?? []).includes(sha)).map((it) => field(it, 'summary') || it.thread_id);
  const title = commit ? `Commit ${commit.sha.slice(0, 7)} · ${commit.subject}` : 'Changes not pushed yet';
  const sub = `${plural(ch.commits.length, 'commit', 'commits')} · from ${ch.base.slice(0, 7)} (PR head) to ${ch.head.slice(0, 7)} (your local HEAD)`;
  const side = `<button type="button" class="sc-dpick${view.kind === 'range' ? ' sc-on' : ''}" data-sc-act="dview" data-sc-val="range"><b>All commits</b><span class="sc-mono sc-muted">${counts(ch)}</span></button>
${ch.commits.map((k) => `<button type="button" class="sc-dpick${commit?.sha === k.sha ? ' sc-on' : ''}" data-sc-act="dview" data-sc-val="${esc(k.sha)}"><span><code class="sc-sha">${esc(k.sha.slice(0, 7))}</code> <span class="sc-mono">${counts(k)}</span>${notesOn(k.sha) ? ` <span class="sc-badge">${plural(notesOn(k.sha), 'note', 'notes')}</span>` : ''}</span><span>${esc(k.subject)}</span><span class="sc-muted sc-xs">${cites(k.sha).length ? `Reply: ${esc(cites(k.sha).join(', '))}` : 'No reply cites it'}</span></button>`).join('')}`;
  const files = diffFiles(src, view);
  const block = (f, i) => {
    const sha = noteTarget(ch, view, f.path);
    const key = noteKey({ sha, path: f.path, view: view.kind });
    const note = codeNotes[key];
    const editing = d.editing === key;
    const folded = d.folded[f.path] ?? isLargeFile(f);
    const marks = editing ? d.draftLines : note?.lines ?? [];
    const marked = (side, n) => marks.some((l) => l.side === side && l.n === n);
    const many = view.kind === 'range' && (f.commits?.length ?? 0) > 1;
    let body = '';
    if (!folded) {
      if (f.binary) body = '<div class="sc-dmsg">Binary file, not shown.</div>';
      else if (!patches) body = '';
      else if (!f.patch) body = '<div class="sc-dmsg">No content changes.</div>';
      else {
        body = parsePatch(f.patch).map((l) => {
          const lineSide = l.kind === 'del' ? 'old' : 'new';
          const num = l.kind === 'del' ? l.old : l.new;
          const mk = num != null && marked(lineSide, num);
          const nums = `<span class="sc-dno">${l.old ?? ''}</span><span class="sc-dno">${l.new ?? ''}</span>`;
          const gutter = num == null || readOnly ? `<span class="sc-dnums">${nums}</span>` : `<button type="button" class="sc-dnums" data-sc-act="dmark" data-sc-file="${i}" data-sc-side="${lineSide}" data-sc-n="${num}" aria-pressed="${mk}" title="Mark this line for your note">${nums}</button>`;
          return `<div class="sc-dl sc-dl-${l.kind}${mk ? ' sc-dl-mk' : ''}">${gutter}<span class="sc-dsg">${{ add: '+', del: '−' }[l.kind] ?? ''}</span><span class="sc-dtx">${esc(l.text)}</span></div>`;
        }).join('');
      }
    }
    const goes = many ? `<span class="sc-muted sc-xs">Goes to ${esc(String(sha).slice(0, 7))}, the newest commit that changed this file.</span>` : '';
    let foot = '';
    if (editing) {
      foot = `<label class="sc-dlabel" for="sc-dnote-${i}">Note on ${esc(f.path.split('/').pop())} <span class="sc-muted">for the agent · never posted on GitHub</span></label>
<span class="sc-xs">${d.draftLines.length ? `<span class="sc-chip">${esc(markLabel(d.draftLines))}</span> <button type="button" class="sc-link" data-sc-act="dclearmarks">clear</button>` : '<span class="sc-muted">Click line numbers to mark lines (optional)</span>'}</span>${goes}
<textarea id="sc-dnote-${i}" class="sc-dnote" data-sc-field="dnote" rows="3" placeholder="What should the agent change in this file?">${esc(d.draftText)}</textarea>
<div class="sc-drow"><button type="button" class="sc-btn" data-sc-act="dcancel">Cancel</button><button type="button" class="sc-btn sc-on" data-sc-act="dsave" data-sc-file="${i}">Save note</button></div>`;
    } else if (note) {
      foot = `<div class="sc-dsaved"><div class="sc-drow"><b>Your note on this file</b><span class="sc-muted sc-xs">for the agent · never posted</span>${note.lines.length ? `<span class="sc-chip">${esc(markLabel(note.lines))}</span>` : ''}${readOnly ? '' : `<span class="sc-grow"></span><button type="button" class="sc-link" data-sc-act="dnote" data-sc-file="${i}">Edit</button><button type="button" class="sc-link" data-sc-act="ddelete" data-sc-file="${i}">Delete</button>`}</div>${goes ? `<div>${goes}</div>` : ''}<div>${richText(note.text)}</div></div>`;
    } else if (!readOnly && patches) {
      foot = `<div class="sc-drow"><button type="button" class="sc-btn" data-sc-act="dnote" data-sc-file="${i}">Add a note on this file</button><span class="sc-muted sc-xs">You can mark lines by clicking their numbers.</span></div>`;
    }
    const foldNote = folded && isLargeFile(f) && d.folded[f.path] === undefined ? `<span class="sc-muted sc-xs">${fmtCount((Number(f.add) || 0) + (Number(f.del) || 0))} lines · folded because it is large, click to show</span>` : '';
    return `<div class="sc-dfile" id="sc-dfile-${i}">
<button type="button" class="sc-dfhead" data-sc-act="dfold" data-sc-file="${i}" aria-expanded="${!folded}"><span class="sc-muted">${folded ? '▸' : '▾'}</span><span class="sc-mono sc-grow">${esc(f.old_path ? `${f.old_path} → ${f.path}` : f.path)}</span>${foldNote}${note ? '<span class="sc-badge">note for the agent</span>' : ''}${view.kind === 'range' ? (f.commits ?? []).map((s) => `<code class="sc-sha">${esc(s.slice(0, 7))}</code>`).join('') : ''}<span class="sc-mono">${counts(f)}</span></button>
${body ? `<div class="sc-dbody">${body}</div>` : ''}${foot ? `<div class="sc-dfoot">${foot}</div>` : ''}</div>`;
  };
  const total = Object.keys(codeNotes).length;
  const locked = state.payload.items.filter((it) => notesFor(state, it).length).map((it) => `“${field(it, 'summary') || it.thread_id}”`);
  const footer = d.warn ? `<span class="sc-err">${esc(d.warn)}</span>`
    : total ? `<span><b>${plural(total, 'note', 'notes')}</b> for the agent. ${locked.length ? `${esc(locked.join(', '))} ${locked.length === 1 ? 'is' : 'are'} now Change code, locked until the agent changes the code or you delete the note.` : 'No reply cites the commit; the agent still carries the note out.'}</span>`
      : '<span class="sc-muted">Add a note under a file to ask the agent for a change. Nothing here goes to GitHub.</span>';
  const missing = patches ? '' : `<div class="sc-dmsg">The diff needs the local server. Start it with <code>second-chair start</code>, or run <code>${esc(cmd)}</code>.</div>`;
  return `<div class="sc-diff-backdrop" data-sc-act="dclose"></div>
<div class="sc-diff" tabindex="-1" role="dialog" aria-modal="true" aria-label="${esc(title)}">
<div class="sc-dhead">${SC_LOGO}<div class="sc-grow"><b>${esc(title)}</b><div class="sc-muted sc-xs">${esc(sub)}</div></div><span class="sc-label sc-notpushed">not pushed</span>${safe ? `<button type="button" class="sc-btn" data-sc-act="dcopy" data-sc-val="${esc(cmd)}">Copy git command</button>` : ''}<button type="button" class="sc-icon" data-sc-act="dclose" aria-label="Close">✕</button></div>
<div class="sc-dmain"><div class="sc-dside"><div class="sc-dsec">Commits</div>${side}<div class="sc-dsec">Files · ${files.length}</div>${files.map((f, i) => `<a class="sc-dflink" href="#sc-dfile-${i}" data-sc-act="djump" data-sc-file="${i}"><span class="sc-mono">${esc(f.path.split('/').pop())}</span><span class="sc-mono">${counts(f)}</span></a>`).join('')}</div>
<div class="sc-dlist">${missing}${files.map(block).join('')}<div class="sc-muted sc-xs">Snapshot taken when the agent sent round 2. If the agent changes a commit, its hash changes and the card shows the new one.</div></div></div>
<div class="sc-dfootbar">${footer}<span class="sc-grow"></span><button type="button" class="sc-btn sc-on" data-sc-act="dclose">Done</button></div>
</div>`;
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
    let old = keep[it.thread_id];
    const newPublication = sameRound && (previous.payload.published_at ?? null) !== (payload.published_at ?? null);
    const before = sameRound ? previous.payload.items.find((x) => x.thread_id === it.thread_id) : null;
    // A Revise or a Change code asked the agent for something new. Once a new publication brings it, the request is
    // answered: start over from the agent's new version, even when the user had edited the old text.
    const wasChange = Boolean(before) && notesFor(previous, before).length > 0;
    if (newPublication && (old?.decision === 'revise' || wasChange)) old = null;
    // A reply that now cites other commits is about other code: the user decides it again.
    const commitsMoved = Boolean(old) && (before?.commits ?? []).join() !== (it.commits ?? []).join();
    // A reply you edited survives a re-import; an untouched one takes the agent's new draft. A decision you
    // made on the old draft does not count for a new one: you approve the text that will be posted.
    const changed = Boolean(old) && ((!old.replyEdited && (before?.reply_en ?? '') !== (it.reply_en ?? '')) || commitsMoved);
    decisions[it.thread_id] = old
      ? { decision: changed ? null : old.decision, note: changed ? '' : old.note ?? '', reply: old.replyEdited ? old.reply : (it.reply_en ?? ''), replyEdited: Boolean(old.replyEdited) }
      : { decision: null, note: '', reply: it.reply_en ?? '', replyEdited: false };
  }
  // A send answers one publication of the proposals; a new publication needs a new send.
  const samePublication = sameRound && (previous.payload.published_at ?? null) === (payload.published_at ?? null);
  const sentAt = samePublication ? previous.sentAt ?? null : null;
  const doneAt = samePublication ? previous.doneAt ?? null : null;
  const sentVia = samePublication && sentAt ? previous.sentVia ?? null : null;
  // lastExport tells this tab's own send from another tab's; resendOf marks a round reopened by Edit and send again.
  const lastExport = samePublication ? previous.lastExport ?? null : null;
  const resendOf = samePublication ? previous.resendOf ?? null : null;
  const submit = sameRound ? previous.submit ?? null : null;
  // Notes on the code answer one publication of the commits, as a send does.
  const codeNotes = samePublication ? { ...(previous.codeNotes ?? {}) } : {};
  return { payload, decisions, sentAt, sentVia, doneAt, lastExport, resendOf, submit, codeNotes };
}

/** True when the user asked the agent for a new version or for a code change on at least one item. */
function hasRevise(state) {
  return state.payload.items.some((it) => ['revise', 'change'].includes(effective(state, it).decision));
}

/** Why and since when this pull request's triage is over, or null while it is open. */
function doneInfo(state) {
  if (!state) return null;
  const p = state.payload;
  if (p.closed_at) return { at: p.closed_at, reason: 'closed' };
  if (state.doneAt) return { at: state.doneAt, reason: 'marked' };
  // Only an offline final send ends the work here. With a server, the agent's close after publish does.
  if (state.sentAt && state.sentVia === 'clipboard' && p.round === SC_FINAL_ROUND && !hasRevise(state)) return { at: state.sentAt, reason: 'final-sent' };
  return null;
}

/**
 * Where a pull request's work stands: `empty` (nothing loaded), `decide` (the user's turn), `waiting` (the agent
 * prepares the next round), `publishing` (the agent carries out the final round) or `done`.
 */
function phaseOf(state) {
  if (!state) return 'empty';
  if (doneInfo(state)) return 'done';
  if (!state.sentAt) return 'decide';
  return state.payload.round < SC_FINAL_ROUND || hasRevise(state) ? 'waiting' : 'publishing';
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** What reached GitHub, for the done view, from the server's record of the final round. */
function publishedSummary(state, published) {
  const items = published?.items ?? {};
  if (modeOf(state.payload) === 'review') {
    const review = items.REVIEW;
    if (review) return `Submitted as ${SC_EVENTS.find((e) => e.key === review.event)?.label ?? review.event}.`;
    if (!Object.keys(items).length) return 'Closed. Nothing was changed on GitHub.';
    return 'Your review is ready and still a draft: submit it on GitHub, Files changed, Review changes, Submit.';
  }
  const posted = state.payload.items.filter((it) => items[it.thread_id]?.action === 'replied').length;
  if (!posted) return 'Closed. Nothing was posted.';
  const rest = state.payload.items.length - posted;
  return `Posted ${plural(posted, 'reply', 'replies')}.${rest ? ` ${rest} not posted.` : ''}`;
}

/** The agent's request to come to the terminal, while the work is with the agent; null otherwise. */
function attentionOf(phase, live = {}) {
  return (phase === 'waiting' || phase === 'publishing') && live.attention ? live.attention : null;
}

const SC_TITLE_MARK = '(!) ';
const SC_ATTN_WAIT = '<div class="sc-wait sc-wait-attn">⚠ The agent needs you in the terminal</div>';

/** The tab title with the mark that the agent needs you, or without it. */
function titleWith(title, on) {
  // The browser trims the title, so a mark on an empty title reads back as "(!)".
  const bare = title.replace(/^\(!\)\s*/, '');
  return on ? SC_TITLE_MARK + bare : bare;
}

/** The status line: whose turn it is and what happens, plus a warning that stays while it matters. */
function statusOf(state, phase, live = {}) {
  const p = state.payload;
  const review = modeOf(p) === 'review';
  const round1 = p.round < SC_FINAL_ROUND;
  const warn = review && (phase === 'decide' || phase === 'waiting' || attentionOf(phase, live)) ? 'Do not submit the review on GitHub yet. It still holds comments you have not decided.' : null;
  let who = null;
  let text = '';
  const asks = attentionOf(phase, live);
  if (asks) {
    // The agent stopped for you. Without this line the page would show a spinner that never ends.
    return { who: 'attention', text: `Your turn in the terminal. The agent stopped and waits for you there, since ${formatTime(asks.at)}.${asks.message ? `\n${asks.message}` : ''}`, warn };
  }
  if (phase === 'decide') {
    who = 'you';
    text = review
      ? (round1 ? 'Your turn. Decide each comment. Your review stays a draft that only you can see.' : 'Your turn. Approve the final comments, and choose what happens to the review.')
      : (round1 ? 'Your turn. Decide each thread. Nothing is posted yet.' : 'Your turn. Approve the final replies. Only Publish posts.');
  } else if (phase === 'waiting') {
    who = 'agent';
    text = !round1 ? (Object.keys(state.codeNotes ?? {}).length
      ? 'Agent\'s turn. It changes the code you noted and writes the new versions. Round 2 opens here again.'
      : 'Agent\'s turn. It writes the new versions you asked for. Round 2 opens here again.')
      : review ? 'Agent\'s turn. It rewrites the comments you asked to revise. Round 2 opens here.'
        : 'Agent\'s turn. It makes the fixes and commits them, without pushing. Round 2 opens here.';
    if (state.sentVia === 'clipboard') text += ' Your decisions are on the clipboard. Paste them to the agent.';
    else text += live.pickedUpAt ? ` The agent picked up your decisions at ${formatTime(live.pickedUpAt)}.` : ` Sent ${formatTime(state.sentAt)}.`;
  } else if (phase === 'publishing') {
    who = 'agent';
    const event = SC_EVENTS.find((e) => e.key === state.submit);
    text = review
      ? `Agent's turn. It updates your draft review on GitHub.${event ? ` Then it submits it as ${event.label}.` : ''}`
      : 'Agent\'s turn. It pushes the commits and posts the replies you approved.';
  } else if (phase === 'done') {
    const info = doneInfo(state);
    text = info?.reason === 'marked' ? 'Marked as done.' : info?.reason === 'final-sent' ? 'Sent through the clipboard. The agent posts what you approved.' : publishedSummary(state, live.published);
  }
  return { who, text, warn };
}

/** A readable local time; a value that is not a date shows as it came. */
function formatTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

const SC_DONE_REASON = { closed: 'closed', 'final-sent': 'final round sent', marked: 'marked as done' };

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

/** One note per file of a commit and view. */
function noteKey(n) {
  return `${n.sha} ${n.path} ${n.view}`;
}

/** The notes on the code of the commits an item cites. Any of them locks the reply as Change code. */
function notesFor(state, item) {
  if (!Array.isArray(item.commits) || !item.commits.length) return [];
  return Object.values(state.codeNotes ?? {}).filter((n) => item.commits.includes(n.sha));
}

/** The decision that counts for an item: yours, or the proposal when the agent marked it `auto` and it posts nothing. */
function effective(state, item) {
  // A note on the code wins over any choice. The choice stays stored and counts again once the notes are deleted.
  if (notesFor(state, item).length) return { decision: 'change', auto: false };
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
  return [...SC_FILTERS, ...choicesFor(payload).map((b) => ({ key: `d:${b.key}`, label: b.label, test: (e) => e.decision === b.key }))];
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

/**
 * Why the review's submit choice cannot go out as it stands, or null. GitHub adds a body to a pending review that
 * has none only with the submit, needs a body for Request changes, and needs a body or a comment for Comment.
 */
function submitLock(state) {
  const p = state.payload;
  if (modeOf(p) !== 'review' || p.round !== SC_FINAL_ROUND) return null;
  const body = p.items.find((it) => it.thread_id === 'BODY');
  const keptBody = Boolean(body) && effective(state, body).decision === 'post' && String(state.decisions.BODY?.reply ?? '').trim() !== '';
  const keptComment = p.items.some((it) => it.comment_id != null && effective(state, it).decision === 'post');
  if (keptBody && body.needs_submit && !state.submit) return 'GitHub adds this body only with the submit. Choose Comment, Approve or Request changes, or drop the body.';
  if (state.submit === 'REQUEST_CHANGES' && !keptBody) return 'Request changes needs a review body. Keep the body, or choose another option.';
  if (state.submit === 'COMMENT' && !keptBody && !keptComment) return 'Comment needs a review body or at least one kept comment.';
  return null;
}

/** The export object, or null while a thread is still undecided or the submit choice cannot go out. */
function buildExport(state, now) {
  if (!progress(state).complete || submitLock(state)) return null;
  const p = state.payload;
  const submit = modeOf(p) === 'review' && p.round === SC_FINAL_ROUND ? { submit: state.submit ?? null } : {};
  return {
    tool: SC_TOOL,
    kind: 'decisions',
    mode: modeOf(p),
    repo: p.repo,
    pr: p.pr,
    round: p.round,
    head: p.head ?? null,
    // The server refuses decisions for a publication the agent has replaced since.
    published_at: p.published_at ?? null,
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
    ...(p.changes ? { code_notes: Object.values(state.codeNotes ?? {}).map((n) => ({ ...n, thread_ids: p.items.filter((it) => (it.commits ?? []).includes(n.sha)).map((it) => it.thread_id) })) } : {}),
    ...submit,
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

/** A commit as GitHub shows it: seven characters, the full hash on hover. */
function shortCommit(c) {
  return `<code title="${esc(c)}">${esc(String(c).slice(0, 7))}</code>`;
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
  const who = item.origin === 'user' ? '<b>Your draft comment</b>'
    : `<b>Second Chair</b> <span class="sc-muted">${item.origin === 'earlier' ? 'earlier pass' : review ? 'draft comment' : 'proposes'}</span>`;
  const links = threadLinks(p.repo, p.pr, item.comment_id);
  const jump = where === 'panel' && links
    ? `<button type="button" class="sc-link" data-sc-act="jump" data-sc-id="${id}">jump</button><a href="${esc(links.files)}">in files</a>`
    : '';
  const pos = view.position ? `<span class="sc-muted">${esc(view.position)}</span>` : '';
  const moves = view.position && !view.readOnly
    ? `<button type="button" class="sc-link" data-sc-act="prev" data-sc-id="${id}" aria-label="Previous">‹</button><button type="button" class="sc-link" data-sc-act="next" data-sc-id="${id}" aria-label="Next">›</button>`
    : '';
  const hidden = view.hidden ? '<span class="sc-label" title="GitHub has not loaded this thread on the page">hidden</span>' : '';
  const cls = `sc-card${e.decision && !missingNote(state, item) ? ' sc-decided' : ''}${compact ? ' sc-compact' : ''}`;
  const open = `<div class="${cls}" data-sc-card="${id}" data-sc-where="${where}">`;
  const mark = SC_LOGO;
  if (compact) {
    const first = String(d.reply || field(item, 'summary')).split('\n').find((l) => l.trim()) ?? '';
    const label = e.decision ? `<span class="sc-label${e.auto ? ' sc-auto' : ''} sc-v-${esc(e.decision)}">${e.auto ? 'auto · ' : ''}${esc(decisionLabel(p, e.decision))}</span>` : '';
    return `${open}<div class="sc-oneline">${mark}${label}<span class="sc-oneline-text">${richText(first)}</span><button type="button" class="sc-link" data-sc-act="expand" data-sc-id="${id}">expand</button></div></div>`;
  }
  const context = [field(item, 'context'), field(item, 'fix') ? `**Plan:** ${field(item, 'fix')}` : ''].filter(Boolean).join('\n\n');
  const summary = field(item, 'summary');
  const ch = p.changes;
  const commitRow = (sha) => {
    const k = ch?.commits.find((x) => x.sha === sha);
    if (!k) return shortCommit(sha);
    const n = notesFor(state, { commits: [sha] }).length;
    return `<div class="sc-crow">${shortCommit(sha).replace('<code', '<code class="sc-sha"')}<span class="sc-grow sc-ellip">${esc(k.subject)}</span><span class="sc-mono">${countsHtml(k)} · ${plural(k.files.length, 'file', 'files')}</span><span class="sc-label sc-notpushed">not pushed</span>${n ? `<span class="sc-label sc-change">${plural(n, 'note', 'notes')}</span>` : ''}<button type="button" class="sc-btn" data-sc-act="diff" data-sc-val="${esc(sha)}">View changes</button></div>`;
  };
  const commits = Array.isArray(item.commits) && item.commits.length
    ? (ch ? item.commits.map(commitRow).join('') : `<div class="sc-commits">Commits: ${item.commits.map(shortCommit).join(' ')}</div>`)
    : '';
  const notes = notesFor(state, item);
  const changeBox = notes.length ? `<div class="sc-changebox"><div class="sc-drow"><span class="sc-label sc-change">Change code</span><b>${plural(notes.length, 'note', 'notes')} on the code</b><span class="sc-muted sc-xs">for the agent · never posted</span></div>${notes.map((n) => `<div class="sc-cnote"><div class="sc-drow"><span class="sc-mono">${esc(n.path.split('/').pop())}</span>${n.lines.length ? ` <span class="sc-chip">${esc(markLabel(n.lines))}</span>` : ''}<span class="sc-grow"></span><button type="button" class="sc-link" data-sc-act="diff" data-sc-val="${esc(n.view === 'range' ? 'range' : n.sha)}">Open in diff</button></div><div>${richText(n.text)}</div></div>`).join('')}</div>` : '';
  const needNote = missingNote(state, item);
  // The box shows the text as GitHub will show it. Edit swaps in a textarea; the user's text then wins.
  const editable = !view.readOnly;
  const editingNow = view.editing && editable;
  const shown = `<div class="sc-md markdown-body">${renderMarkdown(d.reply) || '<span class="sc-empty">Nothing to post.</span>'}</div>`;
  const reply = editingNow
    ? `<textarea class="sc-reply" data-sc-field="reply" data-sc-id="${id}" rows="${rowsFor(d.reply, where === 'panel' ? 70 : 110)}">${esc(d.reply)}</textarea><div class="sc-hint">${esc("Your text replaces the agent's. Esc to finish.")}</div>`
    : editable ? `<div class="sc-preview" data-sc-act="edit" data-sc-id="${id}" title="Click to edit">${shown}</div>` : shown;
  // Under its own pending comment the card would only repeat it. It shows the text once it differs from GitHub's:
  // the agent's rewrite of a comment, or the user's edit.
  const onPage = review && where === 'inline' && Boolean(item.comment_id) && !editingNow && Boolean(d.reply) && d.reply === (item.original_en ?? item.reply_en);
  const caption = review
    ? (onPage ? 'Comment above · stays in your draft review' : item.comment_id ? 'Comment · stays in your draft review' : 'Review body · added to your review')
    : p.round < SC_FINAL_ROUND ? 'Draft reply · posted only if you approve it in round 2' : 'Reply · posted when you choose Publish';
  const undo = d.replyEdited && editable ? `<button type="button" class="sc-link" data-sc-act="undo" data-sc-id="${id}">Undo my edits</button>` : '';
  const tool = !editable ? '' : editingNow
    ? `<button type="button" class="sc-link" data-sc-act="preview" data-sc-id="${id}">Preview</button>`
    : `<button type="button" class="sc-link" data-sc-act="edit" data-sc-id="${id}" title="Change the text. Your text replaces the agent's.">✎ Edit</button>`;
  const original = (item.origin === 'user' || item.origin === 'earlier') && item.original_en && item.original_en !== d.reply
    ? `<details class="sc-original"><summary>${item.origin === 'earlier' ? 'Earlier text' : 'Your original'}</summary><div class="sc-md markdown-body">${renderMarkdown(item.original_en)}</div></details>` : '';
  const lockedByNotes = notes.length > 0;
  const buttons = choicesFor(p).map((b, i) => {
    const bc = ['sc-btn'];
    if (!lockedByNotes && d.decision === b.key) bc.push('sc-on');
    else if (!lockedByNotes && e.auto && e.decision === b.key) bc.push('sc-on-auto');
    else if (!lockedByNotes && !e.decision && item.verdict === b.key) bc.push('sc-suggested');
    return `<button type="button" class="${bc.join(' ')}" data-sc-act="decide" data-sc-id="${id}" data-sc-val="${b.key}" title="${esc(b.help)} (key ${i + 1})"${lockedByNotes ? ' disabled' : ''}>${!lockedByNotes && d.decision === b.key ? '✓ ' : ''}${esc(b.label)}</button>`;
  }).join('') + (lockedByNotes ? `<button type="button" class="sc-btn sc-on sc-change-on" aria-pressed="true" disabled>✓ ${esc(decisionLabel(p, 'change'))}</button>` : '');
  const footer = view.readOnly
    ? `<div class="sc-card-foot"><span class="sc-muted">Decision:</span> <b>${esc(e.decision ? decisionLabel(p, e.decision) : 'none')}</b></div>`
    : `<div class="sc-card-foot"><div class="sc-seg">${buttons}</div><input class="sc-note${needNote ? ' sc-note-needed' : ''}" data-sc-field="note" data-sc-id="${id}" placeholder="${needNote ? 'What should change? Revise needs a note' : lockedByNotes ? 'Note on the reply text (optional)' : 'Note for the agent (optional)'}" value="${esc(d.note)}">${lockedByNotes ? '<div class="sc-xs sc-muted sc-lockline">Locked while the code note exists. The agent changes the code, and you decide the reply again on the new commit. Delete the note in the diff to unlock.</div>' : ''}</div>`;
  const expander = e.auto || view.sent || view.done ? `<button type="button" class="sc-link" data-sc-act="expand" data-sc-id="${id}">collapse</button>` : '';
  return `${open}
  <div class="sc-card-head">${mark}${who}${verdictLabel}${hidden}<span class="sc-head-right">${pos}${moves}${jump}${expander}</span></div>
  <div class="sc-card-body">
    ${summary ? `<div class="sc-summary sc-md">${renderMarkdown(summary)}</div>` : ''}
    ${context ? `<div class="sc-foryou"><div class="sc-foryou-title">For you <span class="sc-muted">· never posted</span></div><div class="sc-md markdown-body">${renderMarkdown(context)}</div></div>` : ''}
    ${commits}
    <div class="sc-caption"><span>${caption}${d.replyEdited ? ' <span class="sc-edited">· edited by you</span>' : ''}</span><span class="sc-caption-tools">${undo}${tool}</span></div>
    ${onPage ? '' : `<div class="sc-reply-box${editingNow ? ' sc-editing' : ''}">${reply}</div>`}
    ${original}
    ${changeBox}
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

/**
 * Review mode's own block at the top of the list: the review body, and in round 2 what happens to the review once
 * the agent applied the decisions. The agent may suggest an event; only the user picks one.
 */
function buildYourReview(state, view) {
  const p = state.payload;
  const body = p.items.find((it) => it.thread_id === 'BODY');
  if (modeOf(p) !== 'review' || !body) return '';
  let choice = '';
  if (p.round === SC_FINAL_ROUND) {
    const options = [{ key: '', label: 'Leave as draft', help: 'The agent updates your draft review. You submit it yourself on GitHub.' }, ...SC_EVENTS];
    const buttons = options.map((o) => {
      const on = (state.submit ?? '') === o.key;
      const cls = on ? 'sc-btn sc-on' : !state.submit && body.suggested_submit === o.key ? 'sc-btn sc-suggested' : 'sc-btn';
      return `<button type="button" class="${cls}" data-sc-act="submit" data-sc-val="${o.key}" title="${esc(o.help)}"${view.readOnly ? ' disabled' : ''}>${esc(o.label)}</button>`;
    }).join('');
    choice = `<div class="sc-submit"><div class="sc-caption">When the agent has applied this:</div><div class="sc-seg">${buttons}</div></div>`;
  }
  return `<div class="sc-yourreview"><div class="sc-group"><span>Your review</span></div><div class="sc-yourreview-body">${buildCard(state, body, 'panel', { ...view, expanded: true })}${choice}</div></div>`;
}

function buildPanelList(state, openId, filterKey, viewOf) {
  const p = state.payload;
  // In review mode the body has its own block above the list.
  const items = visibleItems(state, filterKey).filter((it) => !(modeOf(p) === 'review' && it.thread_id === 'BODY'));
  return groupItems(items).map((g) => `<div class="sc-group"><span>${esc(g.label)}</span><span>${g.items.length}</span></div>${g.items.map((it) => {
    const e = effective(state, it);
    const v = viewOf(it);
    const { decided, icon, label } = rowParts(state, it, v);
    // A review comment has no author to show; only an item without a file is general.
    const meta = [it.author ? esc(it.author) : (it.path ? '' : 'general'), it.line ? `line ${esc(it.line)}` : '', !e.decision && it.verdict ? `proposed ${esc(decisionLabel(p, it.verdict))}` : '', notesFor(state, it).length ? `<span class="sc-change-text">Change code · ${plural(notesFor(state, it).length, 'note', 'notes')}</span>` : '', v.hidden ? `<span class="sc-hidden">${modeOf(p) === 'review' ? 'folded on GitHub · decide here' : 'not loaded on page'}</span>` : '', Array.isArray(it.commits) && it.commits.length ? `commit ${shortCommit(it.commits[0])}` : ''].filter(Boolean).join(' · ');
    const open = it.thread_id === openId;
    return `<div class="sc-row${decided ? ' sc-decided' : ''}${open ? ' sc-selected' : ''}" data-sc-item="${esc(it.thread_id)}">
  <div class="sc-row-main" data-sc-act="toggle" data-sc-id="${esc(it.thread_id)}">${icon}<div class="sc-row-text"><div class="sc-row-sum">${richText(field(it, 'summary') || String(it.reply_en ?? '').split('\n')[0])}</div><div class="sc-row-meta">${meta}</div></div>${label}</div>
  ${open && (v.panelOpen || v.hidden || !it.comment_id) ? buildCard(state, it, 'panel', { ...v, expanded: true }) : ''}
</div>`;
  }).join('')}`).join('');
}

function buildFilterBar(state, filterKey) {
  const count = (test) => state.payload.items.filter((it) => test(effective(state, it))).length;
  const tabs = SC_FILTERS.map((f) => `<button type="button" class="sc-ftab${f.key === filterKey ? ' sc-ftab-on' : ''}" data-sc-act="filter" data-sc-val="${f.key}">${esc(f.label)}<b>${count(f.test)}</b></button>`).join('');
  const options = choicesFor(state.payload).map((b) => `<option value="d:${b.key}"${`d:${b.key}` === filterKey ? ' selected' : ''}>${esc(b.label)} (${count((e) => e.decision === b.key)})</option>`).join('');
  return `<div class="sc-tabbar">${tabs}<select class="sc-fdecision" data-sc-act="filterselect"><option value="">Decision</option>${options}</select></div>`;
}

/** The folded row above the tabs: what `git push` will send, and a way into the diff. */
function buildPushRow(state, open) {
  const ch = state.payload.changes;
  if (!ch) return '';
  const cited = new Set(state.payload.items.flatMap((it) => it.commits ?? []));
  const orphans = Object.values(state.codeNotes ?? {}).filter((n) => !cited.has(n.sha)).length;
  const rows = open ? `<div class="sc-pushlist">${ch.commits.map((k) => `<button type="button" class="sc-pushrow" data-sc-act="diff" data-sc-val="${esc(k.sha)}"><code class="sc-sha">${esc(k.sha.slice(0, 7))}</code><span class="sc-grow sc-ellip">${esc(k.subject)}</span><span class="sc-mono">${countsHtml(k)}</span></button>`).join('')}<div class="sc-xs sc-muted">from <code>${esc(ch.base.slice(0, 7))}</code> (PR head) to <code>${esc(ch.head.slice(0, 7))}</code> (local)</div></div>` : '';
  return `<div class="sc-push"><div class="sc-drow"><button type="button" class="sc-icon" data-sc-act="pushfold" aria-expanded="${open}" aria-label="Show the commits">${open ? '▾' : '▸'}</button><b>Push will send</b><span class="sc-muted">${plural(ch.commits.length, 'commit', 'commits')}</span><span class="sc-mono">${countsHtml(ch)}</span><span class="sc-grow"></span><button type="button" class="sc-btn" data-sc-act="diff" data-sc-val="range">View</button></div>${orphans ? `<div class="sc-xs sc-change-text">${plural(orphans, 'note', 'notes')} on a commit no reply cites</div>` : ''}${rows}</div>`;
}

// The tour for each screen: a few steps, each pointing at a part of Second Chair's own cards or panel, never at
// GitHub's markup. `at` says where to look: the card the tour shows, or the side panel. `sel` narrows it down.
const SC_TOURS = {
  'reply:1': [
    { at: 'card', sel: null, text: "The agent's proposal for this thread. Nothing is posted yet." },
    { at: 'card', sel: '.sc-foryou', text: 'The yellow box is only for you: what the agent checked, and its plan. It is never posted.' },
    { at: 'card', sel: '.sc-reply-box', text: 'The reply that would be posted. Click it to change the words.' },
    { at: 'card', sel: '.sc-seg', text: 'Pick what happens to this thread. The dashed button is the agent\'s suggestion.' },
    { at: 'card', sel: '.sc-note', text: 'A note tells the agent what to do differently, and is never posted. For example: "Also add a test for the empty list."' },
    { at: 'panel', sel: '.sc-status', text: 'This line always says whose turn it is.' },
    { at: 'panel', sel: '[data-sc-act=export]', text: 'Send when every thread is decided. The agent makes the fixes, and round 2 comes back here.' },
  ],
  'reply:2': [
    { at: 'card', sel: '.sc-seg', text: 'Publish posts this reply. Revise asks the agent for a new version, and Hold or Manual post nothing.' },
    { at: 'card', sel: '.sc-reply-box', text: 'This exact text is what gets posted. Click it to change the words.' },
    { at: 'card', sel: '.sc-note', text: 'With Revise, say what to change. For example: "Mention the commit with the fix."' },
    { at: 'panel', sel: '[data-sc-act=export]', text: 'Send, and the agent pushes the commits and posts the replies you chose.' },
  ],
  'review:1': [
    { at: 'card', sel: null, text: 'A comment in your draft review on GitHub. Only you can see it.' },
    { at: 'card', sel: '.sc-foryou', text: 'The yellow box is only for you: why the agent wrote this comment. It is never posted.' },
    { at: 'card', sel: '.sc-caption', text: 'Where the comment stays. ✎ Edit changes its words.' },
    { at: 'card', sel: '.sc-seg', text: 'Keep it, ask the agent to revise it, or drop it from the review.' },
    { at: 'card', sel: '.sc-note', text: 'A note tells the agent what to change, and is never posted. For example: "Shorter, and link the docs page."' },
    { at: 'panel', sel: '.sc-yourreview', text: 'The main comment sits at the top of your review, above the line comments. Approve or Request changes comes in round 2.' },
    { at: 'panel', sel: '.sc-status-warn', text: "Do not press GitHub's Submit button yet. It would publish every comment, decided or not." },
    { at: 'panel', sel: '[data-sc-act=export]', text: 'Send when every comment is decided. In round 2 you approve the final texts and choose Approve, Comment or Request changes.' },
  ],
  'review:2': [
    { at: 'panel', sel: '.sc-submit', text: 'Choose how the agent submits the review: Approve, Comment or Request changes. Leave as draft submits nothing.' },
    { at: 'panel', sel: '.sc-yourreview .sc-card', text: 'The main comment goes out with the review. Revise asks the agent for a new version.' },
    { at: 'card', sel: '.sc-note', text: 'With Revise, say what to change. For example: "Softer, this is only a nit."' },
    { at: 'panel', sel: '[data-sc-act=export]', text: 'Send, and the agent updates your review on GitHub.' },
  ],
};
// Before a tour starts by itself, it asks. A user who has seen no tour yet gets a welcome.
const SC_TOUR_INTROS = {
  'reply:1': { title: 'Replying to a review', text: 'The agent read the review threads on this pull request and wrote a proposal for each one. Nothing is posted until you decide.' },
  'reply:2': { title: 'Round 2', text: 'The agent did what you decided. Now you choose which replies get posted.' },
  'review:1': { title: 'Reviewing a pull request', text: 'The agent wrote a review of this pull request. It is a draft on GitHub that only you can see. There are two rounds: first you decide each comment, then you approve the final texts and choose Approve, Comment or Request changes.' },
  'review:2': { title: 'Round 2', text: 'The agent rewrote the comments you sent back. Now you choose what goes into the review, and how it is submitted.' },
};
function tourIntro(mode, round, firstEver) {
  const intro = SC_TOUR_INTROS[`${mode}:${round}`];
  if (!intro) return null;
  return firstEver ? { ...intro, title: 'Welcome to Second Chair' } : intro;
}
function buildTourIntro(intro, count) {
  return `<div class="sc-tour-title">${esc(intro.title)}</div>
<div class="sc-tour-text">${richText(intro.text)}</div>
<div class="sc-tour-text">Take a short tour of this screen? ${count} steps. You can start it later with ? in the panel.</div>
<div class="sc-tour-foot"><span class="sc-grow"></span>
  <button type="button" class="sc-btn" data-sc-act="tourskip">Not now</button>
  <button type="button" class="sc-btn sc-on" data-sc-act="tournext">Show me</button></div>`;
}
function tourSteps(mode, round) {
  return SC_TOURS[`${mode}:${round}`] ?? [];
}

/** The storage key that remembers a tour was seen. */
function tourKey(mode, round) {
  return `sc:tour:${mode}:${round}`;
}

/** The bubble of one tour step: the text, where you are, and how to move on. */
function buildTourTip(step, index, count) {
  const last = index === count - 1;
  return `<div class="sc-tour-text">${richText(step.text)}</div>
<div class="sc-tour-foot"><span class="sc-muted">${index + 1} of ${count}</span><span class="sc-grow"></span>
  <button type="button" class="sc-link" data-sc-act="tourskip">Skip</button>
  ${index ? '<button type="button" class="sc-btn" data-sc-act="tourback">Back</button>' : ''}
  <button type="button" class="sc-btn sc-on" data-sc-act="tournext">${last ? 'Done' : 'Next'}</button></div>`;
}

/** The panel for a pull request without proposals: how to start, and what to do when the server is down. */
function emptyPanel(loc, serverUp) {
  const n = loc.number;
  const down = serverUp === false
    ? `<p class="sc-warn">The Second Chair server is not running. Start it in Claude Code with <code>! second-chair start</code>.</p>
<textarea class="sc-paste" placeholder="Or paste the proposals JSON here (Ctrl+V)"></textarea>`
    : '';
  return `<div class="sc-empty-panel">
  <p><b>No proposals for this pull request yet.</b></p>
  <p>In Claude Code, run:</p>
  <p><code>/second-chair:respond ${n}</code> for your own pull request,<br><code>/second-chair:review ${n}</code> for someone else's.</p>
  <p>The cards then show up here and under the threads, and a short tour shows you around.</p>
  ${down}
</div>`;
}

const SC_CSS = `
.sc-toggle{position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;align-items:center;gap:6px;height:32px;padding:0 12px 0 10px;border-radius:16px;border:1px solid var(--borderColor-default,#d0d7de);background:var(--bgColor-default,#fff);color:var(--fgColor-default,#1f2328);font:600 12px/1 -apple-system,system-ui,sans-serif;cursor:pointer;box-shadow:var(--shadow-floating-small,0 2px 8px rgba(0,0,0,.15))}
.sc-toggle.sc-complete{color:var(--fgColor-success,#1a7f37);border-color:var(--fgColor-success,#1a7f37)}
.sc-toggle.sc-attn{color:var(--fgColor-attention,#9a6700);border-color:var(--borderColor-attention-emphasis,#d4a72c);background:var(--bgColor-attention-muted,#fff8c5)}
.sc-panel{position:fixed;top:0;right:0;bottom:0;width:min(440px,92vw);z-index:9998;display:flex;flex-direction:column;background:var(--bgColor-default,#fff);color:var(--fgColor-default,#1f2328);border-left:1px solid var(--borderColor-default,#d0d7de);box-shadow:var(--shadow-floating-large,-4px 0 16px rgba(0,0,0,.12));font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
.sc-panel.sc-wide{width:50vw}.sc-panel[hidden]{display:none}
html.sc-shift-narrow body{margin-right:min(440px,92vw)!important}html.sc-shift-wide body{margin-right:50vw!important}
html.sc-shift-narrow .sc-toggle{right:calc(min(440px,92vw) + 16px)}html.sc-shift-wide .sc-toggle{right:calc(50vw + 16px)}
.sc-panel-head{padding:12px 14px 10px;border-bottom:1px solid var(--borderColor-default,#d0d7de);position:relative}
.sc-hrow{display:flex;align-items:center;gap:8px}.sc-grow{flex:1}.sc-small{font-size:12px;margin-top:6px}.sc-fg{color:var(--fgColor-default,#1f2328)}
.sc-title{font-size:14px;white-space:nowrap}.sc-done-label{white-space:nowrap}
.sc-panel-head>.sc-hrow:first-child>.sc-muted{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sc-icon{width:28px;height:28px;border-radius:6px;border:1px solid transparent;background:none;color:var(--fgColor-muted,#59636e);cursor:pointer;font:16px/1 system-ui}
.sc-icon:hover{background:var(--bgColor-muted,#f6f8fa);border-color:var(--borderColor-default,#d0d7de)}
.sc-dot{width:8px;height:8px;border-radius:50%;background:var(--fgColor-muted,#8c959f)}.sc-dot.sc-up{background:var(--fgColor-success,#1a7f37)}.sc-dot.sc-down{background:var(--fgColor-danger,#d1242f)}
.sc-progress{display:flex;height:8px;margin-top:10px;border-radius:4px;overflow:hidden;background:var(--bgColor-muted,#f6f8fa);border:1px solid var(--borderColor-default,#d0d7de)}
.sc-progress i{display:block}.sc-p-mine{background:var(--fgColor-success,#1a7f37)}.sc-p-auto{background:var(--fgColor-muted,#8c959f)}
.sc-done-label{color:var(--fgColor-done,#8250df);border-color:var(--fgColor-done,#8250df);background:var(--bgColor-done-muted,#fbefff)}
.sc-menu{position:absolute;right:14px;top:48px;z-index:2;width:220px;padding:6px 0;background:var(--overlay-bgColor,var(--bgColor-default,#fff));border:1px solid var(--borderColor-default,#d0d7de);border-radius:8px;box-shadow:var(--shadow-floating-medium,0 8px 24px rgba(140,149,159,.3))}
.sc-menu .sc-link{display:block;width:100%;text-align:left;padding:6px 14px;color:inherit}.sc-menu .sc-link:hover{background:var(--bgColor-muted,#f6f8fa);text-decoration:none}.sc-menu hr{border:0;border-top:1px solid var(--borderColor-default,#d0d7de);margin:6px 0}.sc-menu .sc-danger{color:var(--fgColor-danger,#d1242f)!important}
.sc-tabbar{display:flex;align-items:center;gap:2px;padding:0 10px;box-shadow:inset 0 -1px 0 var(--borderColor-default,#d0d7de);overflow-x:auto;overflow-y:hidden}
.sc-ftab{padding:8px;border:0;border-bottom:2px solid transparent;background:none;color:inherit;font:inherit;cursor:pointer;white-space:nowrap}
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
.sc-posted{margin:6px 0;padding-left:20px}
.sc-empty-panel{margin:10px 14px;padding:12px 14px;border:1px solid var(--borderColor-default,#d0d7de);border-radius:6px;background:var(--bgColor-default,#fff);line-height:1.6}
.sc-empty-panel p{margin:8px 0}
.sc-warn{color:var(--fgColor-attention,#9a6700)}
.sc-empty-panel code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 4px;border-radius:4px;background:var(--bgColor-muted,#f6f8fa)}
.sc-tour{position:fixed;inset:0;z-index:10000}
.sc-tour-hole{position:fixed;border-radius:8px;box-shadow:0 0 0 3px var(--fgColor-accent,#0969da),0 0 0 9999px rgba(0,0,0,.55);pointer-events:none;transition:all .2s ease}
.sc-tour-tip{position:fixed;width:300px;box-sizing:border-box;padding:12px 14px;border-radius:8px;background:var(--overlay-bgColor,var(--bgColor-default,#fff));color:var(--fgColor-default,#1f2328);border:1px solid var(--borderColor-default,#d0d7de);box-shadow:var(--shadow-floating-large,0 8px 24px rgba(0,0,0,.3));font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;transition:top .2s ease,left .2s ease}
.sc-tour-tip::before{content:"";position:absolute;width:12px;height:12px;background:inherit;border:inherit;border-width:0;transform:rotate(45deg)}
.sc-tour-tip.sc-tip-below::before{top:-7px;left:var(--sc-arrow,24px);border-top-width:1px;border-left-width:1px}
.sc-tour-tip.sc-tip-above::before{bottom:-7px;left:var(--sc-arrow,24px);border-bottom-width:1px;border-right-width:1px}
.sc-tour-tip.sc-tip-left::before{right:-7px;top:var(--sc-arrow,20px);border-top-width:1px;border-right-width:1px}
.sc-tour-text{margin-bottom:10px}.sc-tour-title{font-weight:600;font-size:15px;margin-bottom:6px}
.sc-tour-tip.sc-tip-center{width:360px}.sc-tour-tip.sc-tip-center::before{display:none}.sc-tour-foot{display:flex;align-items:center;gap:8px;font-size:12px}
.sc-tour-foot .sc-btn{margin-left:0;border-radius:6px}
.sc-yourreview-body{padding:10px 14px;border-bottom:1px solid var(--borderColor-default,#d0d7de)}
.sc-submit{margin-top:4px}.sc-submit .sc-seg{flex-wrap:wrap}
.sc-lock{margin-top:6px;font-size:12px;color:var(--fgColor-attention,#9a6700)}
.sc-status{margin-top:8px;font-size:13px}.sc-status-warn{margin-top:4px;color:var(--fgColor-attention,#9a6700)}
.sc-wait{display:flex;align-items:center;justify-content:center;gap:8px;height:32px;font-weight:600}
.sc-status-attention{padding:6px 10px;border:1px solid var(--borderColor-attention-emphasis,#d4a72c);border-radius:6px;background:var(--bgColor-attention-muted,#fff8c5)}
.sc-wait-attn{color:var(--fgColor-attention,#9a6700)}
.sc-spin{width:12px;height:12px;border:2px solid var(--borderColor-default,#d0d7de);border-top-color:var(--fgColor-accent,#0969da);border-radius:50%;animation:sc-spin 1s linear infinite}
@keyframes sc-spin{to{transform:rotate(360deg)}}
.sc-msg{margin:10px 14px 0;font-size:12px}.sc-msg.sc-err{color:var(--fgColor-danger,#d1242f)}
.sc-paste{margin:10px 14px;width:calc(100% - 28px);min-height:90px;font:12px ui-monospace,monospace}
.sc-card,.sc-panel,.sc-toggle,.sc-tour,.sc-diff-layer{--sc-accent:var(--fgColor-accent,#0969da);--sc-border:var(--borderColor-default,#d0d7de);--sc-subtle:var(--bgColor-muted,#f6f8fa);--sc-canvas:var(--bgColor-default,#fff);--sc-muted:var(--fgColor-muted,#59636e);--sc-success:var(--fgColor-success,#1a7f37)}
.sc-card{
  border:1px solid var(--sc-border);border-left:3px solid var(--sc-accent);border-radius:6px;background:var(--sc-canvas);color:var(--fgColor-default,#1f2328);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;overflow:hidden}
.sc-card[data-sc-where=inline]{margin:8px 16px 16px}
.sc-card[data-sc-where=panel]{margin:0 0 8px}
.sc-card.sc-decided{border-left-color:var(--sc-success)}
.sc-card-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 12px;background:var(--sc-subtle);border-bottom:1px solid var(--sc-border);font-size:13px}
.sc-head-right{margin-left:auto;display:flex;gap:10px;font-size:12px}
.sc-head-right a{text-decoration:none}.sc-head-right .sc-link{font-size:12px}
.sc-logo{width:16px;height:16px;flex:none}
.sc-panel-head .sc-logo{width:18px;height:18px}
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
.sc-link{border:0;background:none;padding:0;margin:0;font:inherit;color:var(--fgColor-accent,#0969da);cursor:pointer}
.sc-link:hover{text-decoration:underline}
.sc-caption{display:flex;align-items:baseline;gap:8px}.sc-caption-tools{margin-left:auto;display:flex;gap:12px;font-weight:400}
.sc-preview{cursor:text}.sc-preview:hover{background:var(--bgColor-muted,#f6f8fa)}
.sc-reply-box.sc-editing{border-color:var(--fgColor-accent,#0969da);box-shadow:0 0 0 1px var(--fgColor-accent,#0969da)}
.sc-hint{padding:4px 12px;font-size:12px;color:var(--sc-muted);border-top:1px solid var(--sc-border);background:var(--sc-subtle)}
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
.sc-diff-backdrop{position:fixed;inset:0;z-index:2147483600;background:rgba(31,35,40,.55)}
.sc-diff{position:fixed;z-index:2147483601;box-sizing:border-box;left:50%;top:40px;bottom:40px;transform:translateX(-50%);width:80%;max-width:1800px;display:flex;flex-direction:column;background:var(--sc-canvas);color:var(--fgColor-default,#1f2328);border:1px solid var(--sc-border);border-radius:12px;box-shadow:0 12px 48px rgba(31,35,40,.35);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;overflow:hidden}
@media (max-width:900px){.sc-diff{width:100%;top:0;bottom:0;border-radius:0}}
.sc-dhead,.sc-dfootbar{display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid var(--sc-border)}
.sc-dfootbar{border-bottom:0;border-top:1px solid var(--sc-border);background:var(--sc-subtle);font-size:13px}
.sc-dmain{flex:1;min-height:0;display:flex}
.sc-dside{width:300px;flex:none;overflow:auto;border-right:1px solid var(--sc-border);padding:8px 0}
.sc-dsec{padding:12px 14px 4px;font-size:12px;font-weight:600;color:var(--sc-muted);text-transform:uppercase}
.sc-dpick{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;font:inherit;font-size:13px;color:inherit;background:none;border:0;border-left:3px solid transparent;padding:8px 14px;cursor:pointer}
.sc-dpick.sc-on{background:var(--bgColor-accent-muted,#ddf4ff);border-left-color:var(--sc-accent)}
.sc-dflink{display:flex;justify-content:space-between;gap:8px;padding:3px 14px;font-size:12px;color:inherit}
.sc-dlist{flex:1;min-width:0;overflow:auto;padding:16px 20px;display:flex;flex-direction:column;gap:16px}
.sc-dfile{border:1px solid var(--sc-border);border-radius:6px;overflow:hidden;flex:none}
.sc-dfhead{display:flex;align-items:center;gap:10px;width:100%;font:inherit;font-size:13px;color:inherit;background:var(--sc-subtle);border:0;border-bottom:1px solid var(--sc-border);padding:8px 14px;cursor:pointer;text-align:left}
.sc-dbody{overflow-x:auto}
.sc-dl{display:flex;font:12.5px/20px ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;white-space:pre}
.sc-dnums{display:flex;flex:none;border:0;margin:0;padding:0;background:none;font:inherit;color:var(--sc-muted);cursor:pointer}
span.sc-dnums{cursor:default}
.sc-dno{width:48px;text-align:right;padding-right:10px;user-select:none}
.sc-dsg{width:20px;flex:none;text-align:center;user-select:none}
.sc-dtx{flex:1;min-width:0;padding-right:16px}
.sc-dl-add{background:var(--diffBlob-additionLine-bgColor,var(--bgColor-success-muted,#e6ffec))}
.sc-dl-del{background:var(--diffBlob-deletionLine-bgColor,var(--bgColor-danger-muted,#ffebe9))}
.sc-dl-hunk{background:var(--diffBlob-hunkLine-bgColor,var(--bgColor-accent-muted,#ddf4ff));color:var(--sc-muted)}
.sc-dl-meta{color:var(--sc-muted)}
.sc-dl-mk{background:var(--bgColor-attention-muted,#fff8c5);box-shadow:inset 3px 0 0 var(--fgColor-attention,#9a6700)}
.sc-dfoot{border-top:1px solid var(--sc-border);background:var(--sc-subtle);padding:10px 14px;display:flex;flex-direction:column;gap:8px}
.sc-dsaved{background:var(--sc-canvas);border:1px solid var(--sc-border);border-radius:6px;padding:8px 12px}
.sc-drow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sc-dnote{font:inherit;font-size:13px;padding:8px 10px;border:1px solid var(--sc-border);border-radius:6px;background:var(--sc-canvas);color:inherit;resize:vertical}
.sc-dmsg{padding:12px 16px;color:var(--sc-muted)}
.sc-chip{font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:0 8px;border-radius:2em;border:1px solid var(--borderColor-attention-emphasis,#d4a72c);background:var(--bgColor-attention-muted,#fff8c5)}
.sc-badge{font-size:12px;padding:0 8px;border-radius:2em;background:var(--bgColor-accent-muted,#ddf4ff);color:var(--sc-accent)}
.sc-sha{font-size:12px;padding:1px 6px;border-radius:6px;background:var(--sc-subtle);color:var(--sc-accent)}
.sc-plus{color:var(--fgColor-success,#1a7f37);font-weight:600}.sc-minus{color:var(--fgColor-danger,#d1242f);font-weight:600}
.sc-notpushed{color:var(--fgColor-attention,#9a6700);border-color:var(--borderColor-attention-emphasis,#d4a72c)}
.sc-mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:12px}
.sc-xs{font-size:12px}
.sc-diff .sc-err{color:var(--fgColor-danger,#d1242f);font-weight:600}
.sc-crow{display:flex;align-items:center;gap:8px;border:1px solid var(--sc-border);border-radius:6px;padding:6px 10px;margin-bottom:8px;font-size:13px}
.sc-ellip{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.sc-changebox{border:1px solid var(--borderColor-done-emphasis,#8250df);border-radius:6px;background:var(--bgColor-done-muted,#fbefff);padding:8px 12px;margin-bottom:8px;display:flex;flex-direction:column;gap:6px}
.sc-change{color:var(--fgColor-done,#8250df);border-color:var(--fgColor-done,#8250df)}
.sc-change-text{color:var(--fgColor-done,#8250df);font-weight:600}
.sc-change-on{background:var(--fgColor-done,#8250df);border-color:var(--fgColor-done,#8250df);color:#fff}
.sc-lockline{flex-basis:100%}
.sc-push{margin:8px 12px 4px;border:1px solid var(--borderColor-attention-emphasis,#d4a72c);border-radius:8px;background:var(--bgColor-attention-muted,#fff8c5);padding:4px 8px;font-size:13px}
.sc-pushlist{display:flex;flex-direction:column;border-top:1px solid var(--borderColor-attention-emphasis,#d4a72c);margin-top:4px;padding-top:4px}
.sc-pushrow{display:flex;gap:8px;align-items:center;font:inherit;font-size:13px;color:inherit;background:none;border:0;padding:4px 6px;cursor:pointer;text-align:left}
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
  let pollTimer = null;
  // What polling learned about this round: when the agent picked the decisions up, what publish recorded, and
  // whether the agent stopped to wait for you in the terminal.
  let live = { pickedUpAt: null, revision: null, published: null, attention: null };
  const POLL_MS = 5000;
  // A hidden tab still polls, slower, so a request from the agent or a new round can reach you as a notification.
  const POLL_HIDDEN_MS = 30000;
  // Inline cards that are unfolded, and threads whose card is open in the panel: two separate things.
  const expanded = new Set();
  const panelOpen = new Set();
  const editing = new Set();
  const ui = (() => {
    try {
      return { filter: 'all', wide: false, open: false, ...JSON.parse(GM_getValue('sc:ui', '{}')) };
    } catch {
      return { filter: 'all', wide: false, open: false };
    }
  })();
  const saveUi = () => GM_setValue('sc:ui', JSON.stringify(ui));
  // Whether the panel shows on this pull request. It follows the saved preference only when there is something to
  // show: a pull request without proposals keeps it closed.
  let panelShown = false;
  // The live tour: its steps, the one shown, and the overlay. A tour starts once per screen it explains.
  let tour = null;
  const toursTried = new Set();
  // The diff popup: null when closed. `patchCache` holds the /api/changes body for the loaded publication.
  let diff = null;
  let patchCache = null;

  const load = () => {
    const raw = GM_getValue(storageKey(loc.repo, loc.number), null);
    try {
      // A state stored before 1.2 has no notes on the code.
      return raw ? { codeNotes: {}, ...JSON.parse(raw) } : null;
    } catch {
      return null;
    }
  };
  const save = () => GM_setValue(storageKey(loc.repo, loc.number), JSON.stringify(state));
  const phase = () => phaseOf(state);
  // Only the user's turn takes decisions and edits.
  const locked = () => phase() !== 'decide';
  let showDoneCards = false;
  const itemById = (id) => state.payload.items.find((x) => x.thread_id === id);

  const diffEl = () => document.body.querySelector(':scope > .sc-diff-layer');
  // The patches of the loaded publication, or null. renderDiff and diffFile must agree on this, or a file index
  // would point at another list.
  // A note being written has text that no other click may throw away.
  const unsavedNote = () => !!(diff?.editing && diff.draftText.trim());
  const warnUnsaved = () => {
    diff.warn = 'Save or cancel the note first.';
    renderDiff();
  };
  const currentPatches = () => (patchCache && state && patchCache.published_at === (state.payload.published_at ?? null) ? patchCache.changes : null);

  function renderDiff() {
    if (!diff || !state?.payload.changes) return;
    let layer = diffEl();
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'sc-diff-layer';
      document.body.appendChild(layer);
    }
    const patches = currentPatches();
    const scroll = layer.querySelector('.sc-dlist')?.scrollTop ?? 0;
    const hadFocus = layer.contains(document.activeElement);
    layer.innerHTML = buildDiff(state, patches, diff, locked());
    const list = layer.querySelector('.sc-dlist');
    if (list) list.scrollTop = scroll;
    // A rebuilt popup must not drop focus on the page behind it.
    const note = layer.querySelector('textarea.sc-dnote');
    if (note) note.focus({ preventScroll: true });
    else if (hadFocus) layer.querySelector('.sc-diff')?.focus({ preventScroll: true });
  }

  /** Describes the control that opened the popup, so it can be found again after a rebuild. */
  function openerRef(el) {
    if (!el?.dataset?.scAct) return { row: openId };
    const card = el.closest('.sc-card');
    return { act: el.dataset.scAct, val: el.dataset.scVal ?? '', card: card?.dataset.scCard ?? null, where: card?.dataset.scWhere ?? null, push: Boolean(el.closest('.sc-push')), cls: el.classList.contains('sc-btn') ? 'sc-btn' : el.classList.contains('sc-pushrow') ? 'sc-pushrow' : null, row: openId };
  }

  function findOpener(ref) {
    if (!ref) return null;
    const q = CSS.escape;
    if (ref.act) {
      const ctl = `[data-sc-act="${q(ref.act)}"][data-sc-val="${q(ref.val)}"]${ref.cls ? `.${ref.cls}` : ''}`;
      const sel = ref.card ? `.sc-card[data-sc-where="${q(ref.where)}"][data-sc-card="${q(ref.card)}"] ${ctl}` : ref.push ? `.sc-push ${ctl}` : ctl;
      const found = document.querySelector(sel);
      if (found) return found;
    }
    return ref.row ? document.querySelector(`.sc-row-main[data-sc-id="${q(ref.row)}"]`) : null;
  }

  async function openDiff(view, opener) {
    diff = { view, folded: {}, editing: null, draftText: '', draftLines: [], warn: null, opener, ref: openerRef(opener) };
    renderDiff();
    diffEl()?.querySelector('.sc-diff')?.focus({ preventScroll: true });
    const want = state.payload.published_at ?? null;
    if (patchCache?.published_at === want) return;
    try {
      const r = await api('GET', `/api/changes?repo=${encodeURIComponent(loc.repo)}&pr=${loc.number}&round=${state.payload.round}`, undefined, 30000);
      if (r.status === 200 && (r.body.published_at ?? null) === want) patchCache = { published_at: want, changes: r.body };
    } catch {
      // The popup shows the counts and the git command without the server.
    }
    renderDiff();
  }

  function closeDiff() {
    const opener = diff?.opener;
    const ref = diff?.ref;
    diff = null;
    diffEl()?.remove();
    const target = opener?.isConnected ? opener : findOpener(ref);
    target?.focus({ preventScroll: true });
  }

  /** The file the popup's control points at, in the current view. */
  const diffFile = (el) => diffFiles(currentPatches() ?? state.payload.changes, diff.view)[Number(el.dataset.scFile)];
  const viewOf = (it) => ({
    expanded: expanded.has(it.thread_id),
    panelOpen: panelOpen.has(it.thread_id),
    editing: editing.has(it.thread_id),
    hidden: Boolean(it.comment_id) && !anchorFor(it),
    position: `${displayOrder(state.payload.items).indexOf(it) + 1} of ${state.payload.items.length}`,
    sent: phase() === 'waiting',
    done: phase() === 'publishing' || phase() === 'done',
    readOnly: locked(),
  });

  /** Resolves { status, body } from the local server; rejects when it is not running. */
  function api(method, path, body, timeout = 4000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: `${SC_SERVER}${path}`,
        // The custom header is what the server checks to refuse requests a web page could forge.
        headers: { 'Content-Type': 'application/json', 'X-Second-Chair': '1' },
        data: body === undefined ? undefined : JSON.stringify(body),
        timeout,
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

  // The shell is always a direct child of body. Looking it up by class anywhere in the document could hit a copy
  // that came in with page content.
  const shellPanel = () => document.body.querySelector(':scope > .sc-panel');
  const shellToggle = () => document.body.querySelector(':scope > .sc-toggle');

  function ensureShell() {
    if (!document.getElementById('sc-style')) {
      const style = document.createElement('style');
      style.id = 'sc-style';
      style.textContent = SC_CSS;
      document.head.appendChild(style);
    }
    if (!shellToggle()) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'sc-toggle';
      toggle.setAttribute('aria-label', 'Second Chair');
      toggle.dataset.scAct = 'panel';
      document.body.appendChild(toggle);
      const panel = document.createElement('div');
      panel.className = 'sc-panel';
      panel.hidden = !panelShown;
      document.body.appendChild(panel);
    }
  }

  function removeShell() {
    document.body.querySelectorAll(':scope > .sc-toggle, :scope > .sc-panel').forEach((n) => n.remove());
    document.querySelectorAll('.sc-card[data-sc-where=inline]').forEach((n) => n.remove());
    document.documentElement.classList.remove('sc-shift-narrow', 'sc-shift-wide');
  }

  function applyLayout() {
    const panel = shellPanel();
    if (!panel) return;
    panel.hidden = !panelShown;
    panel.classList.toggle('sc-wide', ui.wide);
    // The page narrows next to the panel instead of hiding under it.
    document.documentElement.classList.toggle('sc-shift-narrow', panelShown && !ui.wide);
    document.documentElement.classList.toggle('sc-shift-wide', panelShown && ui.wide);
  }

  const sendLabel = (pr) => `${state.resendOf ? 'Send again' : 'Send decisions'}${pr.complete ? '' : ` · ${pr.total - pr.done} left`}`;

  /** The done banner: what reached GitHub, with links, and the switch for the cards. */
  function doneBanner(info) {
    const st = statusOf(state, 'done', live);
    // Only replies of this round, and only links to GitHub.
    const links = Object.entries(live.published?.items ?? {}).filter(([id, x]) => itemById(id) && /^https:\/\/github\.com\//.test(x.url ?? '')).map(([id, x]) => {
      const it = itemById(id);
      return `<li><a href="${esc(x.url)}">${richText(field(it ?? {}, 'summary') || id)}</a></li>`;
    }).join('');
    return `<div class="sc-banner sc-banner-done"><b>Done</b> · ${esc(SC_DONE_REASON[info.reason])} ${esc(formatTime(info.at))}. ${esc(st.text)}${links ? `<ul class="sc-posted">${links}</ul>` : ''}
  <div class="sc-small">Cards are hidden on the page. <button type="button" class="sc-link" data-sc-act="showdone">${showDoneCards ? 'Hide cards' : 'Show cards on the page'}</button></div></div>`;
  }

  function renderPanel() {
    const panel = shellPanel();
    const toggle = shellToggle();
    if (!panel || !toggle) return;
    const listEl = panel.querySelector('.sc-list');
    const scrollTop = listEl ? listEl.scrollTop : 0;
    const ph = phase();
    const info = doneInfo(state);
    const pr = state ? progress(state) : null;
    const asks = attentionOf(ph, live);
    toggle.innerHTML = `${SC_LOGO} ${asks ? 'needs you' : { empty: '–', decide: pr ? `${pr.done}/${pr.total}` : '', waiting: 'waiting', publishing: 'publishing', done: '✓ done' }[ph]}`;
    toggle.classList.toggle('sc-complete', Boolean(ph === 'decide' && pr.complete));
    toggle.classList.toggle('sc-attn', Boolean(asks));
    toggle.title = asks ? 'The agent waits for you in the terminal' : '';
    markTitle(Boolean(asks));
    const pct = (n) => (pr && pr.total ? (100 * n) / pr.total : 0);
    const st = state && ph !== 'done' ? statusOf(state, ph, live) : null;
    const status = st ? `<div class="sc-status sc-status-${st.who}">${richText(st.text).replace(/^(Your turn in the terminal\.|Your turn\.|Agent&#39;s turn\.)/, '<b>$1</b>')}</div>${st.warn ? `<div class="sc-status sc-status-warn">${esc(st.warn)}</div>` : ''}` : '';
    const head = `<div class="sc-panel-head">
  <div class="sc-hrow">${SC_LOGO}<b class="sc-title">Second Chair</b>${state ? `<span class="sc-muted">#${state.payload.pr} · ${SC_MODE_NAME[modeOf(state.payload)]} · round ${state.payload.round}</span>` : ''}<span class="sc-grow"></span>
    ${info ? '<span class="sc-label sc-done-label">✓ Done</span>' : ''}
    <span class="sc-dot ${serverUp ? 'sc-up' : serverUp === false ? 'sc-down' : ''}" title="server ${serverUp ? 'on' : 'off'} · ${SC_SERVER}"></span>
    ${state ? '<button type="button" class="sc-icon" data-sc-act="tour" aria-label="Show the tour" title="Show the tour">?</button>' : ''}<button type="button" class="sc-icon" data-sc-act="menu" aria-label="More">⋯</button><button type="button" class="sc-icon" data-sc-act="panel" aria-label="Close">✕</button></div>
  ${ph === 'decide' ? `<div class="sc-progress"><i style="width:${pct(pr.done - pr.auto)}%" class="sc-p-mine"></i><i style="width:${pct(pr.auto)}%" class="sc-p-auto"></i></div>
  <div class="sc-hrow sc-muted sc-small"><span><b class="sc-fg sc-n-done">${pr.done}</b> of ${pr.total} decided</span>${pr.auto ? `<span>· ${pr.auto} auto</span>` : ''}<span class="sc-grow"></span><span class="sc-left">${pr.total - pr.done ? `${pr.total - pr.done} left` : 'ready to send'}</span></div>` : ''}
  ${status}
</div>`;
    const menu = menuOpen ? `<div class="sc-menu">
  <button type="button" class="sc-link" data-sc-act="fetch">Load from server</button><button type="button" class="sc-link" data-sc-act="import">Load from clipboard</button><hr>
  <button type="button" class="sc-link" data-sc-act="wide">${ui.wide ? 'Narrow panel' : 'Half screen'}</button>
  ${state && !info ? '<hr><button type="button" class="sc-link" data-sc-act="markdone">Mark as done</button>' : ''}
  ${state ? '<button type="button" class="sc-link sc-danger" data-sc-act="clear">Clear from this browser</button>' : ''}</div>` : '';
    const banner = info ? doneBanner(info) : '';
    const body = state ? itemById('BODY') : null;
    const lock = ph === 'decide' ? submitLock(state) : null;
    const msg = message ? `<div class="sc-msg${message.error ? ' sc-err' : ''}">${richText(message.text)}</div>` : '';
    // Without proposals the panel explains how to start; it carries its own paste box when the server is down.
    const empty = state ? '' : emptyPanel(loc, serverUp);
    const paste = message?.showPaste && !(empty && serverUp === false) ? '<textarea class="sc-paste" placeholder="Or paste the proposals JSON here (Ctrl+V)"></textarea>' : '';
    const keys = state ? `<div class="sc-keys"><kbd>j</kbd> <kbd>k</kbd> move <kbd>Enter</kbd> expand <kbd>1</kbd>–<kbd>${choicesFor(state.payload).length}</kbd> decide <kbd>e</kbd> edit${state.payload.changes ? ' <kbd>d</kbd> changes' : ''}</div>` : '';
    let foot = '';
    if (ph === 'decide') {
      foot = `<div class="sc-panel-foot"><button type="button" class="sc-primary" data-sc-act="export" ${pr.complete && !lock ? '' : 'disabled'}>${sendLabel(pr)}</button><div class="sc-lock"${lock ? '' : ' hidden'}>${esc(lock ?? '')}</div>${keys}</div>`;
    } else if (ph === 'waiting') {
      const what = state.payload.round < SC_FINAL_ROUND ? `Waiting for round ${state.payload.round + 1}` : `Waiting for the new round ${state.payload.round}`;
      const wait = asks ? SC_ATTN_WAIT : `<div class="sc-wait"><span class="sc-spin" aria-hidden="true"></span>${what}</div>`;
      foot = `<div class="sc-panel-foot">${wait}<div class="sc-keys"><button type="button" class="sc-link" data-sc-act="resend">Edit and send again</button></div></div>`;
    } else if (ph === 'publishing') {
      foot = `<div class="sc-panel-foot">${asks ? SC_ATTN_WAIT : '<div class="sc-wait"><span class="sc-spin" aria-hidden="true"></span>The agent is publishing</div>'}</div>`;
    } else if (ph === 'done') {
      foot = '<div class="sc-panel-foot sc-muted sc-small">Read only. A new proposal from the agent reopens this pull request.</div>';
    }
    panel.innerHTML = `${head}${menu}${banner}${state ? buildPushRow(state, Boolean(ui.pushOpen)) : ''}${state ? buildFilterBar(state, ui.filter) : ''}${msg}${paste}<div class="sc-list">${empty}${state ? buildYourReview(state, body ? viewOf(body) : {}) + buildPanelList(state, openId, ui.filter, viewOf) : ''}</div>${foot}`;
    panel.querySelector('.sc-list').scrollTop = scrollTop;
    applyLayout();
  }

  /** Updates the counter, the send button and the note markers in place, so typing a note keeps its focus. */
  function updateProgress(id) {
    const pr = progress(state);
    const toggle = shellToggle();
    if (toggle && !locked()) toggle.innerHTML = `${SC_LOGO} ${pr.done}/${pr.total}`;
    toggle?.classList.toggle('sc-complete', pr.complete && !locked());
    const send = shellPanel()?.querySelector('[data-sc-act=export]');
    if (send) {
      const lock = submitLock(state);
      send.disabled = !(pr.complete && !locked() && !lock);
      send.textContent = sendLabel(pr);
      const why = shellPanel()?.querySelector('.sc-lock');
      if (why) {
        why.hidden = !lock;
        why.textContent = lock ?? '';
      }
    }
    const bar = (n) => `${pr.total ? (100 * n) / pr.total : 0}%`;
    const mine = shellPanel()?.querySelector('.sc-p-mine');
    if (mine) mine.style.width = bar(pr.done - pr.auto);
    const nDone = shellPanel()?.querySelector('.sc-n-done');
    if (nDone) nDone.textContent = pr.done;
    const left = shellPanel()?.querySelector('.sc-left');
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

  /** The thread's last comment on the page. GitHub renders the replies as siblings that follow the first comment. */
  function lastComment(anchor) {
    let last = anchor;
    while (/^(discussion_)?r\d+$/.test(last.nextElementSibling?.id ?? '')) last = last.nextElementSibling;
    return last;
  }

  const inlineCard = (id) => document.querySelector(`.sc-card[data-sc-where=inline][data-sc-card="${CSS.escape(id)}"]`);
  // The cards leave the page once the final round is sent, so they never sit next to the posted replies.
  const showInline = () => Boolean(state) && (phase() === 'decide' || phase() === 'waiting' || showDoneCards);

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
      lastComment(anchor).insertAdjacentElement('afterend', cardElement(it));
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
      schedulePoll();
      maybeTour();
      placeTour();
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
      const before = state ? { round: state.payload.round, published: state.payload.published_at ?? null, phase: phase() } : null;
      const split = splitPatches(res.payload);
      if (split.patches) patchCache = { published_at: res.payload.published_at ?? null, changes: split.patches };
      // Patches left over from an older paste must not match a payload that has none.
      else if ((res.payload.published_at ?? null) === null) patchCache = null;
      res.payload = split.payload;
      state = stateFor(res.payload, state);
      if (diff && before?.published !== (res.payload.published_at ?? null)) closeDiff();
      save();
      const ph = phase();
      if (ph === 'done' && before?.phase !== 'done') showDoneCards = false;
      const newRound = before && before.published !== (res.payload.published_at ?? null);
      if (ph === 'done') message = before?.phase === 'publishing' ? null : { text: 'This work is done.' };
      else if (newRound && source === 'server' && before.phase !== 'decide') {
        // The agent's next round arrived while the user waited: say so, and show it.
        message = { text: res.payload.round === before.round ? `A new round ${res.payload.round} is here.` : `Round ${res.payload.round} is here.` };
        panelShown = true;
      } else message = { text: `Loaded ${res.payload.items.length} ${modeOf(res.payload) === 'review' ? 'review comments' : 'threads'}, round ${res.payload.round}, from the ${source}.` };
      live = { pickedUpAt: null, revision: null, published: newRound ? null : live.published, attention: null };
      if (newRound && source === 'server' && before.phase !== 'decide') notify(`round:${res.payload.published_at}`, `Round ${res.payload.round} is ready for you to decide.`);
      // The first proposals on this page: the panel follows the saved preference now that it has something to show.
      if (!before) panelShown = panelShown || ui.open;
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
    schedulePoll();
    loadPublished();
    loadAttention();
  }

  /** Whether the agent waits for you in the terminal. Asked on every sync while the work is with the agent. */
  async function loadAttention() {
    const ph = phase();
    if (!state || (ph !== 'waiting' && ph !== 'publishing')) {
      if (live.attention) {
        live.attention = null;
        renderPanel();
      }
      return;
    }
    const here = loc;
    try {
      const a = await api('GET', `/api/attention?repo=${encodeURIComponent(here.repo)}&pr=${here.number}`);
      if (here !== loc || a.status !== 200) return;
      const next = a.body?.attention ?? null;
      if ((next?.at ?? null) === (live.attention?.at ?? null)) return;
      live.attention = next;
      if (next) notify(`attention:${next.at}`, `The agent needs you in the terminal.${next.message ? ` ${next.message}` : ''}`);
      renderPanel();
    } catch {
      // The server is down; the dot says so.
    }
  }

  /** The (!) in the tab title. GitHub sets the title on every navigation, so each render puts it back. */
  function markTitle(on) {
    const want = titleWith(document.title, on);
    // Compared trimmed, as the browser reads the title back, so a render never sets the same title twice.
    if (want.trim() !== document.title.trim()) document.title = want;
  }

  /**
   * A desktop notification, once per event across every tab of this pull request, and only when you look elsewhere.
   * Tabs share the GM storage, so the first tab that sees the event notifies and the others stay quiet.
   */
  function notify(key, text) {
    if (typeof GM_notification === 'undefined' || document.hasFocus()) return;
    const seenKey = `sc:notified:${loc.repo}#${loc.number}`;
    if (GM_getValue(seenKey, null) === key) return;
    GM_setValue(seenKey, key);
    try {
      GM_notification({ title: `Second Chair · ${loc.repo}#${loc.number}`, text, onclick: () => window.focus() });
    } catch {
      // A script manager without notifications: the title and the panel still say it.
    }
  }

  /** Once per page: what publish recorded, for a round the agent publishes or already closed. Polling does it later on. */
  async function loadPublished() {
    const ph = phase();
    if (!state || live.published || (ph !== 'publishing' && ph !== 'done')) return;
    const here = loc;
    try {
      const p = await api('GET', `/api/published?${roundQuery()}`);
      if (here === loc && p.status === 200) {
        live.published = p.body;
        renderPanel();
      }
    } catch {
      // The server is down; the banner says what it can without the record.
    }
  }

  const roundQuery = () => `repo=${encodeURIComponent(loc.repo)}&pr=${loc.number}&round=${state.payload.round}`;

  /** While the agent works, asks the server every few seconds: a new round, the pick-up, what publish posted. */
  // Idempotent: the page renders on every change GitHub makes, and each render must not restart the wait.
  function schedulePoll() {
    const ph = phase();
    if (pollTimer || !loc || (ph !== 'waiting' && ph !== 'publishing')) return;
    pollTimer = setTimeout(() => { pollTimer = null; poll(); }, document.visibilityState === 'visible' ? POLL_MS : POLL_HIDDEN_MS);
  }

  function stopPoll() {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  async function poll() {
    stopPoll();
    const here = loc;
    if (!here || !state) return;
    try {
      await sync(false);
      if (here !== loc || !state) return;
      const ph = phase();
      if (ph === 'waiting' && state.sentVia === 'server') {
        const d = await api('GET', `/api/decisions?${roundQuery()}&peek=1`);
        live.pickedUpAt = d.status === 200 ? d.body?.picked_up_at ?? null : null;
        live.revision = d.status === 200 ? d.body?.revision ?? 1 : null;
      }
      if (ph === 'publishing' || ph === 'done') {
        const p = await api('GET', `/api/published?${roundQuery()}`);
        if (p.status === 200) live.published = p.body;
      }
      if (here === loc) renderPanel();
    } catch {
      serverUp = false;
      renderPanel();
    } finally {
      schedulePoll();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poll();
    else {
      stopPoll();
      schedulePoll();
    }
  });

  async function sendDecisions() {
    const out = buildExport(state, new Date().toISOString());
    if (!out) return;
    try {
      // Another tab, or this page before a reload, may have sent this round already. Ask before replacing it.
      const prior = await api('GET', `/api/decisions?${roundQuery()}&peek=1`);
      if (prior.status === 200 && !state.resendOf && (prior.body?.exported_at ?? null) !== state.lastExport
        && (prior.body?.received_at ?? '') >= (state.payload.published_at ?? '')
        && !confirm(`Decisions for this round were already sent ${formatTime(prior.body.received_at)}, maybe from another tab. Replace them?`)) return;
      const r = await api('POST', '/api/decisions', out);
      serverUp = true;
      if (r.status === 200) {
        Object.assign(state, { sentAt: out.exported_at, sentVia: 'server', lastExport: out.exported_at, resendOf: null });
        live = { ...live, pickedUpAt: null, revision: r.body?.revision ?? null };
        save();
        message = null;
        renderAll(true);
        return;
      }
      if (r.status === 409 && /already sent round|sent a new version/.test(r.body?.error ?? '')) {
        // The agent moved on while the user edited. The old round is gone, so load the new one.
        state.resendOf = null;
        save();
        await sync(true);
        message = { error: true, text: `${r.body.error[0].toUpperCase()}${r.body.error.slice(1)}. Your changes were not sent.` };
        renderPanel();
        return;
      }
      GM_setClipboard(JSON.stringify(out, null, 2), 'text');
      message = { error: true, text: `The server refused the decisions (${r.status}: ${r.body?.error ?? 'no reason'}). They are on the clipboard instead.` };
    } catch {
      serverUp = false;
      // An offline final send also ends the triage.
      Object.assign(state, { sentAt: out.exported_at, sentVia: 'clipboard', lastExport: out.exported_at, resendOf: null });
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
      // Files changed folds pending review comments. The panel is the place to decide them, so open the card there.
      if (modeOf(state.payload) === 'review') panelOpen.add(id);
      else message = { error: true, text: 'GitHub did not load this thread on the page. Use "in files", or open the conversation tab.' };
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

  /** The element of a Second Chair control, or null for anything the page or a payload's markdown put there. */
  function ownControl(target, selector) {
    const el = target?.closest?.(selector);
    if (!el || !el.closest('.sc-card, .sc-panel, .sc-toggle, .sc-tour, .sc-diff-layer') || el.closest('.sc-md')) return null;
    return el;
  }

  /** The card a tour explains: the first full card on the page, else one opened in the panel. */
  function tourCard() {
    const inline = document.querySelector('.sc-card[data-sc-where=inline]:not(.sc-compact)');
    if (inline) return inline;
    const inPanel = shellPanel()?.querySelector('.sc-row .sc-card');
    if (inPanel) return inPanel;
    // On Files changed GitHub may fold every comment: open the first one's card in the panel.
    const first = displayOrder(state.payload.items).find((it) => it.comment_id);
    if (!first) return null;
    openId = first.thread_id;
    panelOpen.add(first.thread_id);
    renderPanel();
    return shellPanel()?.querySelector('.sc-row .sc-card');
  }

  /** The element a step lights, or null when this page has none. */
  function tourTarget(step) {
    const base = step.at === 'card' ? tourCard() : shellPanel();
    const el = base && step.sel ? base.querySelector(step.sel) : base;
    return el && el.getClientRects().length ? el : null;
  }

  /** The part of `el` that is on screen: cut by the window and by every box around it that scrolls or clips. */
  function shownRect(el) {
    const r = el.getBoundingClientRect();
    let { left, top, right, bottom } = r;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).overflowY === 'visible') continue;
      const c = p.getBoundingClientRect();
      left = Math.max(left, c.left); top = Math.max(top, c.top); right = Math.min(right, c.right); bottom = Math.min(bottom, c.bottom);
    }
    left = Math.max(left, 0); top = Math.max(top, 0); right = Math.min(right, innerWidth); bottom = Math.min(bottom, innerHeight);
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  /** Lights the target and puts the bubble next to it: left of the panel, else below, else above. */
  function placeTour() {
    if (!tour) return;
    const layer = document.body.querySelector(':scope > .sc-tour');
    if (!layer) return;
    const tip = layer.querySelector('.sc-tour-tip');
    // The question before the tour has its own width, so the class goes on before the bubble is measured.
    tip.classList.toggle('sc-tip-center', tour.index < 0);
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    if (tour.index < 0) {
      // The whole page dims and the bubble sits in the middle.
      Object.assign(layer.querySelector('.sc-tour-hole').style, { left: `${innerWidth / 2}px`, top: `${innerHeight / 2}px`, width: '0px', height: '0px' });
      Object.assign(tip.style, { left: `${(innerWidth - w) / 2}px`, top: `${clamp((innerHeight - h) / 2, 8, innerHeight - h - 8)}px` });
      return;
    }
    const el = tourTarget(tour.steps[tour.index]);
    if (!el) return;
    const r = shownRect(el);
    const pad = 6;
    Object.assign(layer.querySelector('.sc-tour-hole').style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
    let side;
    let left;
    let top;
    if (r.left > w + 30 && el.closest('.sc-panel')) {
      side = 'left';
      left = r.left - pad - 14 - w;
      top = clamp(r.top + Math.min(r.height, 120) / 2 - 24, 8, innerHeight - h - 8);
      tip.style.setProperty('--sc-arrow', `${clamp(r.top + Math.min(r.height, 120) / 2 - top - 6, 12, h - 24)}px`);
    } else {
      side = innerHeight - r.bottom > h + 24 || r.top < h + 24 ? 'below' : 'above';
      left = clamp(r.left, 8, innerWidth - w - 8);
      top = side === 'below' ? r.bottom + pad + 12 : r.top - pad - 12 - h;
      tip.style.setProperty('--sc-arrow', `${clamp(r.left + 24 - left, 12, w - 24)}px`);
    }
    tip.className = `sc-tour-tip sc-tip-${side}`;
    Object.assign(tip.style, { left: `${left}px`, top: `${clamp(top, 8, innerHeight - h - 8)}px` });
  }

  /** Shows step `index`; -1 is the question before the tour. */
  function showTourStep(index) {
    if (!tour) return;
    if (index >= tour.steps.length) {
      endTour();
      return;
    }
    if (index < 0 && !tour.intro) index = 0;
    tour.index = index;
    const step = tour.steps[index];
    if (step && step.at === 'panel' && !panelShown) {
      panelShown = true;
      renderPanel();
    }
    const el = step && tourTarget(step);
    if (el) {
      // A target taller than its scroll box shows its top; centring it would push the top out of sight.
      const box = el.parentElement?.closest('.sc-list') ?? null;
      const room = box ? box.clientHeight : innerHeight;
      el.scrollIntoView({ block: el.getBoundingClientRect().height > room * 0.8 ? 'start' : 'center', inline: 'nearest' });
    }
    let layer = document.body.querySelector(':scope > .sc-tour');
    const fresh = !layer;
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'sc-tour';
      layer.setAttribute('role', 'dialog');
      layer.setAttribute('aria-label', 'Second Chair tour');
      layer.innerHTML = '<div class="sc-tour-hole"></div><div class="sc-tour-tip" aria-live="polite"></div>';
      document.body.appendChild(layer);
    }
    layer.querySelector('.sc-tour-tip').innerHTML = index < 0 ? buildTourIntro(tour.intro, tour.steps.length) : buildTourTip(step, index, tour.steps.length);
    // A new bubble appears in place; only later steps glide.
    const tip = layer.querySelector('.sc-tour-tip');
    if (fresh) tip.style.transition = 'none';
    placeTour();
    if (fresh) requestAnimationFrame(() => requestAnimationFrame(() => { tip.style.transition = ''; }));
    layer.querySelector('[data-sc-act=tournext]')?.focus({ preventScroll: true });
  }

  /**
   * Starts the tour of the screen in front of the user: the mode and round on the page. Steps whose part of
   * Second Chair is not on this page are left out.
   */
  function startTour(ask = false) {
    if (!state) return;
    const p = state.payload;
    const defs = tourSteps(modeOf(p), p.round);
    if (defs.some((d) => d.at === 'panel') && !panelShown) {
      panelShown = true;
      renderPanel();
    }
    const steps = defs.filter((d) => tourTarget(d));
    if (!steps.length) return;
    // Started by itself, the tour first asks. A user who has seen no tour yet also gets a welcome.
    const firstEver = Object.keys(SC_TOURS).every((k) => !GM_getValue(`sc:tour:${k}`, null));
    const intro = ask ? tourIntro(modeOf(p), p.round, firstEver) : null;
    tour = { key: tourKey(modeOf(p), p.round), steps, intro, index: 0 };
    showTourStep(intro ? -1 : 0);
  }

  /** Ends the tour; `seen` remembers it, so it does not start by itself again. */
  function endTour(seen = true) {
    if (tour && seen) GM_setValue(tour.key, 1);
    tour = null;
    document.body.querySelectorAll(':scope > .sc-tour').forEach((n) => n.remove());
  }

  /** The first time a screen shows its cards, its tour starts by itself, once. */
  function maybeTour() {
    if (tour || !state || phase() !== 'decide') return;
    const key = tourKey(modeOf(state.payload), state.payload.round);
    if (GM_getValue(key, null) || toursTried.has(key)) return;
    toursTried.add(key);
    // Let GitHub and the cards settle first.
    setTimeout(() => { if (!tour && state && tourKey(modeOf(state.payload), state.payload.round) === key) startTour(true); }, 600);
  }

  addEventListener('resize', () => placeTour());
  addEventListener('scroll', () => placeTour(), true);

  // The popup owns the keyboard while it shows. Esc ends the note being written, or closes the popup.
  document.addEventListener('keydown', (e) => {
    if (!diff || tour) return;
    if (e.key === 'Escape') {
      if (diff.editing) Object.assign(diff, { editing: null, draftText: '', draftLines: [], warn: null }), renderDiff();
      else closeDiff();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // Typing in the note goes on as usual; any other key stays away from the cards behind the popup. Enter and
    // Space on a control behind it must not fire its native click either.
    if (e.target?.matches?.('textarea.sc-dnote')) return;
    if (!e.target?.closest?.('.sc-diff-layer')) e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // Keys belong to the tour while it shows: arrows and Enter move, Esc ends it.
  document.addEventListener('keydown', (e) => {
    if (!tour) return;
    if (e.key === 'Escape') endTour();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') showTourStep(tour.index + 1);
    else if (e.key === 'ArrowLeft') showTourStep(Math.max(0, tour.index - 1));
    else return;
    e.preventDefault();
    // The other key listeners sit on document too, so only this stops them.
    e.stopImmediatePropagation();
  }, true);

  /** Puts the cursor in the reply editor of a thread, in the card the user works in. */
  function focusEditor(id, where) {
    const area = document.querySelector(`.sc-card[data-sc-where="${where}"][data-sc-card="${CSS.escape(id)}"] textarea.sc-reply`)
      ?? document.querySelector(`.sc-card[data-sc-card="${CSS.escape(id)}"] textarea.sc-reply`);
    if (area) {
      autosize(area);
      area.focus();
    }
  }

  // The listeners run in the capture phase, before any page code: on Files changed, GitHub's own handlers take clicks
  // on links and buttons inside a thread, and a bubbling listener on document never saw them.
  document.addEventListener('click', async (e) => {
    const el = ownControl(e.target, '[data-sc-act]');
    if (!el) return;
    // While the popup shows, only its own controls act.
    if (diff && !el.closest('.sc-diff-layer, .sc-tour')) return;
    const act = el.dataset.scAct;
    const id = el.dataset.scId;
    // A link inside the shown text still opens; only a click on the text itself starts editing.
    if (act === 'edit' && el.classList.contains('sc-preview') && e.target.closest('a[href]')) return;
    e.stopPropagation();
    if (act !== 'toggle') e.preventDefault();
    if (act !== 'menu' && menuOpen) {
      // Any other action closes the menu.
      menuOpen = false;
      renderPanel();
    }
    if (act === 'panel') {
      panelShown = !panelShown;
      menuOpen = false;
      // An empty panel opened to look around does not change the preference for pull requests with proposals.
      if (state) {
        ui.open = panelShown;
        saveUi();
      }
      renderPanel();
      if (panelShown) sync(false);
    } else if (act === 'tour') {
      startTour();
    } else if (act === 'tournext') {
      showTourStep(tour ? tour.index + 1 : 0);
    } else if (act === 'tourback') {
      showTourStep(tour ? Math.max(0, tour.index - 1) : 0);
    } else if (act === 'tourskip') {
      endTour();
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
    } else if (act === 'submit') {
      if (!state || locked()) return;
      state.submit = el.dataset.scVal || null;
      save();
      renderPanel();
    } else if (act === 'resend') {
      const when = formatTime(state.sentAt);
      const warning = live.pickedUpAt
        ? `The agent picked up your decisions at ${formatTime(live.pickedUpAt)} and may already be working on them. A new send replaces them. The agent sees the change before it can show you the next round, and redoes what changed.`
        : `A new send replaces the decisions you sent at ${when}.`;
      if (!confirm(warning)) return;
      Object.assign(state, { resendOf: state.sentAt, sentAt: null, sentVia: null });
      save();
      stopPoll();
      renderAll(true);
    } else if (act === 'diff') {
      if (!state?.payload.changes) return;
      const v = el.dataset.scVal;
      openDiff(v === 'range' ? { kind: 'range' } : { kind: 'commit', sha: v }, el);
    } else if (act === 'pushfold') {
      ui.pushOpen = !ui.pushOpen;
      saveUi();
      renderPanel();
    } else if (act === 'dclose') {
      if (!diff) return;
      // Closing, by the backdrop, the close button or Done, must not lose a note being written.
      if (unsavedNote()) {
        return warnUnsaved();
      }
      closeDiff();
    } else if (act === 'dview') {
      if (unsavedNote()) return warnUnsaved();
      const v = el.dataset.scVal;
      Object.assign(diff, { view: v === 'range' ? { kind: 'range' } : { kind: 'commit', sha: v }, editing: null, draftText: '', draftLines: [], warn: null });
      renderDiff();
    } else if (act === 'dfold') {
      const f = diffFile(el);
      const now = diff.folded[f.path] ?? isLargeFile(f);
      diff.folded[f.path] = !now;
      renderDiff();
    } else if (act === 'djump') {
      diffEl()?.querySelector(`#sc-dfile-${Number(el.dataset.scFile)}`)?.scrollIntoView({ block: 'start' });
    } else if (act === 'dnote' || act === 'dmark') {
      if (locked()) return;
      const f = diffFile(el);
      const sha = noteTarget(state.payload.changes, diff.view, f.path);
      const key = noteKey({ sha, path: f.path, view: diff.view.kind });
      if (diff.editing !== key) {
        if (unsavedNote()) return warnUnsaved();
        const old = state.codeNotes[key];
        Object.assign(diff, { editing: key, draftText: old?.text ?? '', draftLines: [...(old?.lines ?? [])], warn: null });
      }
      if (act === 'dmark') {
        const side = el.dataset.scSide;
        const n = Number(el.dataset.scN);
        const at = diff.draftLines.findIndex((l) => l.side === side && l.n === n);
        if (at >= 0) diff.draftLines.splice(at, 1);
        else diff.draftLines.push({ side, n });
      }
      renderDiff();
    } else if (act === 'dclearmarks') {
      diff.draftLines = [];
      renderDiff();
    } else if (act === 'dcancel') {
      Object.assign(diff, { editing: null, draftText: '', draftLines: [], warn: null });
      renderDiff();
    } else if (act === 'dsave') {
      if (locked() || !diff.editing) return;
      const f = diffFile(el);
      const sha = noteTarget(state.payload.changes, diff.view, f.path);
      const key = diff.editing;
      if (diff.draftText.trim()) state.codeNotes[key] = { sha, path: f.path, view: diff.view.kind, lines: diff.draftLines, text: diff.draftText.trim() };
      else delete state.codeNotes[key];
      Object.assign(diff, { editing: null, draftText: '', draftLines: [], warn: null });
      save();
      // A note locks or unlocks cards that already exist. renderAll(false) only adds missing cards, so rebuild.
      renderAll(true);
      renderDiff();
    } else if (act === 'ddelete') {
      if (locked()) return;
      const f = diffFile(el);
      delete state.codeNotes[noteKey({ sha: noteTarget(state.payload.changes, diff.view, f.path), path: f.path, view: diff.view.kind })];
      save();
      renderAll(true);
      renderDiff();
    } else if (act === 'dcopy') {
      const cmd = el.dataset.scVal;
      if (/^git (show [0-9a-f]{40}|log -p [0-9a-f]{40}\.\.[0-9a-f]{40})$/.test(cmd)) GM_setClipboard(cmd);
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
      if (!state || locked()) return;
      editing.add(id);
      expanded.add(id);
      refreshThread(id);
      focusEditor(id, el.closest('.sc-card')?.dataset.scWhere);
    } else if (act === 'preview') {
      editing.delete(id);
      refreshThread(id);
    } else if (act === 'undo') {
      const d = state?.decisions[id];
      if (!d || locked()) return;
      d.reply = itemById(id).reply_en ?? '';
      d.replyEdited = false;
      save();
      refreshThread(id);
    } else if (act === 'decide') {
      const d = state?.decisions[id];
      const key = el.dataset.scVal;
      if (!d || locked() || notesFor(state, itemById(id)).length || !choicesFor(state.payload).some((b) => b.key === key)) return;
      d.decision = d.decision === key ? null : key;
      save();
      refreshThread(id);
    }
  }, true);

  document.addEventListener('change', (e) => {
    const el = ownControl(e.target, '[data-sc-act=filterselect]');
    if (!el) return;
    e.stopPropagation();
    ui.filter = el.value || 'all';
    saveUi();
    renderPanel();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !ownControl(e.target, '.sc-reply, .sc-note')) return;
    e.stopPropagation();
    if (e.target.matches('.sc-reply')) {
      // Esc ends editing and shows the text as GitHub will.
      editing.delete(e.target.dataset.scId);
      refreshThread(e.target.dataset.scId);
    } else e.target.blur();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (tour || !state || !panelShown || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    // Arrows scroll the page as usual until a thread is selected in the panel; j/k always move.
    const arrows = Boolean(openId);
    if ((arrows && e.key === 'ArrowDown') || e.key === 'j') move(1);
    else if ((arrows && e.key === 'ArrowUp') || e.key === 'k') move(-1);
    else if (e.key === 'Enter' && openId) {
      toggleSet(panelOpen, openId);
      refreshThread(openId);
    } else if (openId && /^[1-9]$/.test(e.key)) {
      const b = choicesFor(state.payload)[Number(e.key) - 1];
      if (!b || locked() || notesFor(state, itemById(openId)).length) return;
      const d = state.decisions[openId];
      d.decision = d.decision === b.key ? null : b.key;
      save();
      refreshThread(openId);
    } else if (openId && e.key === 'e' && !locked()) {
      editing.add(openId);
      expanded.add(openId);
      if (!inlineCard(openId)) panelOpen.add(openId);
      refreshThread(openId);
      focusEditor(openId, inlineCard(openId) ? 'inline' : 'panel');
    } else if (e.key === 'd' && state.payload.changes) {
      const it = openId ? itemById(openId) : null;
      const sha = it?.commits?.find((s) => state.payload.changes.commits.some((k) => k.sha === s));
      openDiff(sha ? { kind: 'commit', sha } : { kind: 'range' }, document.activeElement);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  document.addEventListener('input', (e) => {
    const el = ownControl(e.target, '.sc-paste, [data-sc-field]');
    if (!el) return;
    e.stopPropagation();
    if (el.classList.contains('sc-paste')) {
      if (el.value.trim().startsWith('{') && el.value.trim().endsWith('}')) adopt(parsePayload(el.value), 'clipboard');
      return;
    }
    const name = el.dataset.scField;
    if (name === 'dnote') {
      if (diff) diff.draftText = el.value;
      return;
    }
    if (!name || !state || locked()) return;
    const id = el.dataset.scId;
    const d = state.decisions[id];
    if (!d) return;
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
  }, true);

  function needsRender() {
    const now = parseLocation(location.pathname);
    if (!now) return Boolean(shellToggle());
    if (!loc || now.repo !== loc.repo || now.number !== loc.number) return true;
    if (!shellToggle()) return true;
    return showInline() && state.payload.items.some((it) => anchorFor(it) && !inlineCard(it.thread_id));
  }

  function render() {
    const now = parseLocation(location.pathname);
    if (!now) {
      loc = null;
      state = null;
      closeDiff();
      patchCache = null;
      removeShell();
      markTitle(false);
      return;
    }
    if (!loc || now.repo !== loc.repo || now.number !== loc.number) {
      loc = now;
      closeDiff();
      patchCache = null;
      state = load();
      openId = null;
      message = null;
      live = { pickedUpAt: null, revision: null, published: null, attention: null };
      markTitle(false);
      stopPoll();
      showDoneCards = false;
      expanded.clear();
      panelOpen.clear();
      editing.clear();
      endTour(false);
      panelShown = ui.open && Boolean(state);
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
