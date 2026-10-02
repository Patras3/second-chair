// Renders the README screenshots: the userscript on a mock GitHub pull request page, with a real
// second-chair server behind it. Run: PLAYWRIGHT=/path/to/node_modules/playwright npm run screenshots
// Writes docs/images/{card-light,card-dark,panel,review-mode,done,social-preview}.png.
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { nodeRequest, installGm } = require('./gm-harness.cjs');

const OUT = path.join(__dirname, '..', 'docs', 'images');
const script = fs.readFileSync(path.join(__dirname, '..', 'userscript', 'second-chair.user.js'), 'utf8');
// Tampermonkey loads these through @require; the screenshots load the same versions from test/vendor.
const vendor = ['marked.min.js', 'purify.min.js'].map((f) => fs.readFileSync(path.join(__dirname, 'vendor', f), 'utf8'));
const REPO = 'octo-org/example';
const HEAD1 = '8c1f2a7e5b9d04c3a6e1f7b2d8c9e0a1b2c3d4e5';
const HEAD2 = 'd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3';

// ---- The payloads -------------------------------------------------------------------------------

const respondItems = [
  {
    thread_id: 'GLOBAL-1', comment_id: null, author: 'ana-ng', verdict: 'pushback',
    summary: 'Split the PR into two?',
    context: 'The size guard and its test are 40 lines. Splitting them leaves `main` with the eviction bug in between.',
    reply_en: "I'd keep it as one PR. The guard and its test are 40 lines, and a split would leave `main` with the eviction bug in between.",
  },
  {
    thread_id: 'PRRT_kwDOAbc018', comment_id: 1018, author: 'jkim', path: 'src/cache/LruCache.java', line: 18, verdict: 'fix',
    summary: 'Capacity should be validated in the constructor',
    context: 'A capacity of 0 makes every `put` evict the entry it just added.',
    fix: 'throw `IllegalArgumentException` for a capacity below 1.',
    reply_en: 'Agreed. The constructor now throws `IllegalArgumentException` for a capacity below 1.',
  },
  {
    thread_id: 'PRRT_kwDOAbc042', comment_id: 1042, author: 'ana-ng', path: 'src/cache/LruCache.java', line: 42, verdict: 'fix',
    summary: 'Evicts on every put, even under capacity',
    context: 'Not intended. Measured with a loop of 10 000 puts under capacity:\n\n- before: 10 000 evictions\n- after the guard: 0',
    fix: 'call `evict()` only when the map is full, and add a test for the path under capacity.',
    reply_en: "Good catch, it wasn't intended. Eviction now runs only when the map is full:\n\n```java\nif (map.size() >= capacity) {\n    evict();\n}\n```\n\nI also added `LruCacheTest#putUnderCapacityKeepsEntries`.",
  },
  {
    thread_id: 'PRRT_kwDOAbc077', comment_id: 1077, author: 'jkim', path: 'src/cache/LruCache.java', line: 77, verdict: 'fix', auto: true,
    summary: 'Typo: recieve', reply_en: 'Fixed, thanks.',
  },
  {
    thread_id: 'PRRT_kwDOAbc112', comment_id: 1112, author: 'ana-ng', path: 'src/cache/CacheConfig.java', line: 12, verdict: 'reply',
    summary: 'Make the default capacity configurable?',
    context: '`CacheConfig.fromEnv()` already reads `CACHE_CAPACITY`.',
    reply_en: 'It is already: `CacheConfig.fromEnv()` reads `CACHE_CAPACITY`. The default only applies when the variable is not set.',
  },
  {
    thread_id: 'PRRT_kwDOAbc208', comment_id: 1208, author: 'jkim', path: 'src/cache/CacheStats.java', line: 8, verdict: 'fix', auto: true,
    summary: 'Unused import', reply_en: 'Removed.',
  },
  {
    thread_id: 'PRRT_kwDOAbc231', comment_id: 1231, author: 'jkim', path: 'src/cache/CacheStats.java', line: 31, verdict: 'fix',
    summary: '`hits` is not thread-safe',
    context: 'Two threads call `recordHit()` without a lock. A test with 8 threads lost 3% of the hits.',
    fix: 'switch `hits` and `misses` to `LongAdder`.',
    reply_en: 'Right, it lost hits under contention. `hits` and `misses` are now `LongAdder`s.',
  },
  {
    thread_id: 'PRRT_kwDOAbc309', comment_id: 1309, author: 'ana-ng', path: 'docs/cache.md', line: 9, verdict: 'pushback',
    summary: 'Mention the eviction policy in the README',
    context: 'The README links to `docs/cache.md`, which already describes the policy.',
    reply_en: 'The README links to `docs/cache.md`, and the policy is described there. I would rather keep it in one place.',
  },
];

const round2 = {
  'GLOBAL-1': { verdict: 'publish', reply_en: respondItems[0].reply_en },
  PRRT_kwDOAbc018: { verdict: 'publish', commits: ['3f9c2e1'], reply_en: 'Agreed. The constructor now throws `IllegalArgumentException` for a capacity below 1. Done in 3f9c2e1.' },
  PRRT_kwDOAbc042: { verdict: 'publish', commits: ['a1b2c3d'], reply_en: "Good catch, it wasn't intended. Eviction now runs only when the map is full. Done in a1b2c3d, with `LruCacheTest#putUnderCapacityKeepsEntries`." },
  PRRT_kwDOAbc077: { verdict: 'publish', commits: ['a1b2c3d'], reply_en: 'Fixed in a1b2c3d, thanks.' },
  PRRT_kwDOAbc112: { verdict: 'publish', reply_en: respondItems[4].reply_en },
  PRRT_kwDOAbc208: { verdict: 'publish', commits: ['d4e5f6a'], reply_en: 'Removed in d4e5f6a.' },
  PRRT_kwDOAbc231: { verdict: 'publish', commits: ['d4e5f6a'], reply_en: 'Right, it lost hits under contention. `hits` and `misses` are now `LongAdder`s. Done in d4e5f6a.' },
  PRRT_kwDOAbc309: { verdict: 'publish', reply_en: respondItems[7].reply_en },
};

const reviewItems = [
  {
    thread_id: 'BODY', comment_id: null, author: 'review body', verdict: 'post',
    summary: 'Review body',
    reply_en: 'Thanks, the retry logic reads well. Two comments on memory use and one question on the limits.',
  },
  {
    thread_id: 'C2017', comment_id: 2017, author: 'comment', path: 'api/handlers/upload.go', line: 17, verdict: 'post',
    summary: 'The size limit is not enforced',
    context: '`MaxBytesReader` is set up, but its error is dropped on line 22.',
    reply_en: 'The error from `MaxBytesReader` is dropped, so an upload over the limit is cut off without a 413. Could we return it?',
  },
  {
    thread_id: 'C2058', comment_id: 2058, author: 'comment', path: 'api/handlers/upload.go', line: 58, verdict: 'post',
    summary: 'The whole upload is read into memory',
    context: 'Reproduced: a 2 GB upload makes RSS grow by 2 GB, because `io.ReadAll` buffers the whole body.',
    reply_en: 'This reads the whole body into memory. With a 2 GB upload the process grows by 2 GB. Could we stream it with `io.Copy` into the temp file instead?',
  },
];

const proposals = (pr, round, head, items, mode) => ({ tool: 'second-chair', kind: 'proposals', ...(mode ? { mode } : {}), repo: REPO, pr, round, head, items });

// ---- The mock page --------------------------------------------------------------------------------

// GitHub's Primer color variables, the ones the page and the userscript read.
const PRIMER = `
:root{color-scheme:light;
--bgColor-default:#ffffff;--bgColor-muted:#f6f8fa;--bgColor-inset:#f6f8fa;--bgColor-neutral-muted:#818b981f;--bgColor-accent-muted:#ddf4ff;
--bgColor-attention-muted:#fff8c5;--bgColor-success-muted:#dafbe1;--bgColor-done-muted:#fbefff;--bgColor-success-emphasis:#1f883d;
--borderColor-default:#d1d9e0;--borderColor-muted:#d1d9e0b3;--borderColor-attention-muted:#d4a72c66;--borderColor-success-muted:#4ac26b66;--borderColor-done-muted:#c297ff66;
--fgColor-default:#1f2328;--fgColor-muted:#59636e;--fgColor-accent:#0969da;--fgColor-success:#1a7f37;--fgColor-danger:#d1242f;--fgColor-severe:#bc4c00;
--fgColor-attention:#9a6700;--fgColor-done:#8250df;--fgColor-onEmphasis:#ffffff;
--button-primary-bgColor-rest:#1f883d;--button-primary-fgColor-rest:#ffffff;--button-primary-borderColor-rest:#1f232826;
--underlineNav-borderColor-active:#fd8c73;--overlay-bgColor:#ffffff;
--diffBlob-additionLine-bgColor:#dafbe1;--diffBlob-additionNum-bgColor:#aceebb;--diffBlob-hunkLine-bgColor:#ddf4ff;
--codeKeyword:#cf222e;--codeType:#953800;--codeComment:#59636e;
--shadow-floating-small:0 1px 3px #1f23281f,0 6px 12px #42474e1f;--shadow-floating-large:0 0 0 1px #d1d9e0,0 40px 80px #25292e3d}
[data-color-mode=dark]{color-scheme:dark;
--bgColor-default:#0d1117;--bgColor-muted:#151b23;--bgColor-inset:#010409;--bgColor-neutral-muted:#656c7633;--bgColor-accent-muted:#388bfd1a;
--bgColor-attention-muted:#bb800926;--bgColor-success-muted:#2ea04326;--bgColor-done-muted:#ab7df826;--bgColor-success-emphasis:#238636;
--borderColor-default:#3d444d;--borderColor-muted:#3d444db3;--borderColor-attention-muted:#bb800966;--borderColor-success-muted:#2ea04366;--borderColor-done-muted:#ab7df866;
--fgColor-default:#f0f6fc;--fgColor-muted:#9198a1;--fgColor-accent:#4493f8;--fgColor-success:#3fb950;--fgColor-danger:#f85149;--fgColor-severe:#db6d28;
--fgColor-attention:#d29922;--fgColor-done:#ab7df8;--fgColor-onEmphasis:#ffffff;
--button-primary-bgColor-rest:#238636;--button-primary-fgColor-rest:#ffffff;--button-primary-borderColor-rest:#f0f6fc1a;
--underlineNav-borderColor-active:#f78166;--overlay-bgColor:#151b23;
--diffBlob-additionLine-bgColor:#2ea04326;--diffBlob-additionNum-bgColor:#3fb9504d;--diffBlob-hunkLine-bgColor:#388bfd1a;
--codeKeyword:#ff7b72;--codeType:#ffa657;--codeComment:#9198a1;
--shadow-floating-small:0 0 0 1px #3d444d,0 6px 12px #01040966;--shadow-floating-large:0 0 0 1px #3d444d,0 24px 48px #010409}`;

const PAGE_CSS = `
*{box-sizing:border-box}
body{margin:0;background:var(--bgColor-default);color:var(--fgColor-default);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
.gh-top{display:flex;align-items:center;gap:10px;height:56px;padding:0 20px;background:var(--bgColor-muted);border-bottom:1px solid var(--borderColor-default);font-size:14px}
.gh-top .logo{width:28px;height:28px;border-radius:50%;background:var(--fgColor-default)}
.gh-top b{font-weight:600}.gh-top .sl{color:var(--fgColor-muted)}
.gh-pr{padding:20px 24px 0}
.gh-pr h1{margin:0 0 8px;font-size:24px;font-weight:400;line-height:1.25}.gh-pr h1 span{color:var(--fgColor-muted);font-weight:300}
.gh-state{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 12px;border-radius:2em;background:var(--bgColor-success-emphasis);color:#fff;font-size:14px;font-weight:500;margin-right:8px}
.gh-sub{color:var(--fgColor-muted);font-size:14px}.gh-sub b{color:var(--fgColor-default);font-weight:600}
.gh-sub code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bgColor-accent-muted);color:var(--fgColor-accent);padding:2px 6px;border-radius:6px}
.gh-tabs{display:flex;gap:4px;margin-top:16px;border-bottom:1px solid var(--borderColor-default);font-size:14px}
.gh-tabs span{padding:8px 12px;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.gh-tabs span.on{border-bottom-color:var(--underlineNav-borderColor-active);font-weight:600}
.gh-tabs i{font-style:normal;font-size:12px;font-weight:500;padding:0 6px;margin-left:6px;border-radius:2em;background:var(--bgColor-neutral-muted)}
.gh-files{padding:16px 24px 400px}
.file{border:1px solid var(--borderColor-default);border-radius:6px;margin-bottom:16px;background:var(--bgColor-default);overflow:hidden}
.file-head{display:flex;align-items:center;gap:8px;padding:8px 16px;background:var(--bgColor-muted);border-bottom:1px solid var(--borderColor-default);font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
.file-head .n{color:var(--fgColor-success);font-weight:600}.file-head .grow{flex:1}.file-head .v{font:12px -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;color:var(--fgColor-muted)}
.diff{width:100%;border-collapse:collapse;font:12px/20px ui-monospace,SFMono-Regular,Menlo,monospace}
.diff td{padding:0 10px;white-space:pre;vertical-align:top}
.diff .num{width:1%;min-width:44px;text-align:right;color:var(--fgColor-muted)}
.diff .hunk td{background:var(--diffBlob-hunkLine-bgColor);color:var(--fgColor-muted)}
.diff .add td{background:var(--diffBlob-additionLine-bgColor)}.diff .add .num{background:var(--diffBlob-additionNum-bgColor)}
.diff .k{color:var(--codeKeyword)}.diff .t{color:var(--codeType)}
.thread{border-top:1px solid var(--borderColor-default);border-bottom:1px solid var(--borderColor-default);background:var(--bgColor-default)}
.diff+.thread{margin:0}
.thread-in{margin:12px 16px;border:1px solid var(--borderColor-default);border-radius:6px;overflow:hidden;background:var(--bgColor-default)}
.cmt{display:flex;gap:10px;padding:12px 16px}
.av{width:28px;height:28px;border-radius:50%;flex:none;display:grid;place-items:center;color:#fff;font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
.meta{font-size:14px;color:var(--fgColor-muted)}.meta b{color:var(--fgColor-default);font-weight:600}
.pill{display:inline-block;font-size:12px;font-weight:500;line-height:18px;padding:0 7px;border-radius:2em;border:1px solid var(--fgColor-attention);color:var(--fgColor-attention);margin-left:6px}
.cmt p{margin:4px 0 0}.cmt code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;padding:2px 5px;border-radius:6px;background:var(--bgColor-neutral-muted)}
.reply{display:flex;align-items:center;gap:10px;padding:8px 16px;border-top:1px solid var(--borderColor-default);background:var(--bgColor-muted)}
.reply .box{flex:1;height:32px;display:flex;align-items:center;padding:0 12px;border:1px solid var(--borderColor-default);border-radius:6px;background:var(--bgColor-default);color:var(--fgColor-muted);font-size:14px}
.reply .btn{height:32px;display:flex;align-items:center;padding:0 12px;border:1px solid var(--borderColor-default);border-radius:6px;background:var(--bgColor-muted);font-size:14px;font-weight:500;white-space:nowrap}
.markdown-body{font-size:14px;line-height:1.5}
.markdown-body pre{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.markdown-body code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
`;

const AVATAR = { 'ana-ng': '#bf3989', jkim: '#0969da', 'sam-dev': '#1a7f37' };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const code = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
// A tiny highlighter for the diff lines: keywords and types.
const hl = (s) => esc(s)
  .replace(/\b(if|return|throw|new|func|err|nil|private|final|public|void|defer)\b/g, '<span class="k">$1</span>')
  .replace(/\b(IllegalArgumentException|LongAdder|String|Map|HashMap|K|V|io\.ReadAll|io\.Copy)\b/g, '<span class="t">$1</span>');

function fileBlock({ id, file, hunk, lines, comment, pending }) {
  const rows = lines.map(([n, text]) => `<tr class="add"><td class="num"></td><td class="num">${n}</td><td>+ ${hl(text)}</td></tr>`).join('');
  const who = comment.author;
  return `<div class="file" id="f-${id}">
  <div class="file-head"><span class="n">+${lines.length}</span><span>${esc(file)}</span><span class="grow"></span><span class="v">Viewed</span></div>
  <table class="diff"><tr class="hunk"><td class="num">…</td><td class="num">…</td><td>${esc(hunk)}</td></tr>${rows}</table>
  <div class="thread"><div class="thread-in">
    <div class="cmt" id="${comment.anchor}"><span class="av" style="background:${AVATAR[who]}">${who.slice(0, 1).toUpperCase()}</span>
      <div><div class="meta"><b>${esc(who)}</b> ${pending ? '<span class="pill">Pending</span>' : `commented ${esc(comment.when)}`}</div><p>${code(comment.body)}</p></div></div>
    <div class="reply"><span class="av" style="background:${AVATAR['sam-dev']}">S</span><span class="box">Reply…</span><span class="btn">${pending ? 'Add review comment' : 'Resolve conversation'}</span></div>
  </div></div>
</div>`;
}

const respondBlocks = [
  { id: 'r1018', file: 'src/cache/LruCache.java', hunk: '@@ -14,6 +14,9 @@ public final class LruCache<K, V> {', lines: [[17, '    public LruCache(int capacity) {'], [18, '        this.capacity = capacity;']],
    comment: { anchor: 'discussion_r1018', author: 'jkim', when: 'yesterday', body: 'Capacity should be validated in the constructor. What happens with 0?' } },
  { id: 'r1042', file: 'src/cache/LruCache.java', hunk: '@@ -38,7 +41,9 @@ public V get(K key) {', lines: [[42, '        evict();'], [43, '        map.put(key, value);']],
    comment: { anchor: 'discussion_r1042', author: 'ana-ng', when: '2 days ago', body: 'This evicts on every put, even when the map is under capacity. Was that intended?' } },
  { id: 'r1077', file: 'src/cache/LruCache.java', hunk: '@@ -72,4 +77,6 @@ private void evict() {', lines: [[77, '    // Callers recieve the evicted value, or null.'], [78, '    private V evict() {']],
    comment: { anchor: 'discussion_r1077', author: 'jkim', when: 'yesterday', body: 'Typo: recieve' } },
  { id: 'r1112', file: 'src/cache/CacheConfig.java', hunk: '@@ -9,3 +9,5 @@ public record CacheConfig(int capacity) {', lines: [[11, '    // Large enough for one tenant.'], [12, '    public static final int DEFAULT_CAPACITY = 10_000;']],
    comment: { anchor: 'discussion_r1112', author: 'ana-ng', when: '2 days ago', body: 'Make the default capacity configurable?' } },
  { id: 'r1208', file: 'src/cache/CacheStats.java', hunk: '@@ -5,4 +5,5 @@', lines: [[7, 'import java.util.Map;'], [8, 'import java.util.HashMap;']],
    comment: { anchor: 'discussion_r1208', author: 'jkim', when: 'yesterday', body: 'Unused import.' } },
  { id: 'r1231', file: 'src/cache/CacheStats.java', hunk: '@@ -28,4 +29,6 @@ final class CacheStats {', lines: [[30, '    private long hits;'], [31, '    void recordHit() { hits++; }']],
    comment: { anchor: 'discussion_r1231', author: 'jkim', when: 'yesterday', body: '`hits` is not thread-safe. Two request threads can call `recordHit()` at once.' } },
];

const reviewBlocks = [
  { id: 'r2017', file: 'api/handlers/upload.go', hunk: '@@ -12,6 +12,9 @@ func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {', lines: [[16, '    r.Body = http.MaxBytesReader(w, r.Body, h.maxUpload)'], [17, '    defer r.Body.Close()']],
    pending: true, comment: { anchor: 'discussion_r2017', author: 'sam-dev', body: 'The error from `MaxBytesReader` is dropped, so an upload over the limit is cut off without a 413. Could we return it?' } },
  { id: 'r2058', file: 'api/handlers/upload.go', hunk: '@@ -55,5 +58,8 @@ func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {', lines: [[58, '    data, err := io.ReadAll(r.Body)'], [59, '    if err != nil {']],
    pending: true, comment: { anchor: 'discussion_r2058', author: 'sam-dev', body: 'This reads the whole body into memory. With a 2 GB upload the process grows by 2 GB. Could we stream it with `io.Copy` into the temp file instead?' } },
];

function page({ theme, pr, title, branch, blocks, files }) {
  return `<!doctype html><html data-color-mode="${theme}"><head><meta charset="utf-8"><style>${PRIMER}${PAGE_CSS}</style></head><body>
<div class="gh-top"><span class="logo"></span><b>octo-org</b><span class="sl">/</span><b>example</b></div>
<div class="gh-pr"><h1>${esc(title)} <span>#${pr}</span></h1>
  <div class="gh-sub"><span class="gh-state">Open</span><b>${pr === 42 ? 'sam-dev' : 'lee-ot'}</b> wants to merge 3 commits into <code>main</code> from <code>${esc(branch)}</code></div>
  <div class="gh-tabs"><span>Conversation<i>${pr === 42 ? 9 : 2}</i></span><span>Commits<i>3</i></span><span>Checks<i>4</i></span><span class="on">Files changed<i>${files}</i></span></div></div>
<div class="gh-files">${blocks.map(fileBlock).join('')}</div>
</body></html>`;
}

// ---- The browser page ------------------------------------------------------------------------------

async function openPage(browser, port, { url, html, store, viewport, scale = 1.5 }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale, locale: 'en-US', timezoneId: 'UTC' });
  await context.clock.setFixedTime(new Date('2026-09-30T18:20:00Z'));
  const page = await context.newPage();
  await page.route(url, (r) => r.fulfill({ contentType: 'text/html', body: html }));
  await installGm(page, port, store ? JSON.stringify(store) : null);
  await page.goto(url);
  for (const v of vendor) await page.addScriptTag({ content: v });
  await page.addScriptTag({ content: script });
  await page.waitForSelector('.sc-toggle');
  await page.waitForSelector('.sc-dot.sc-up', { state: 'attached' });
  return page;
}

/** The browser state the userscript keeps per pull request, as if the user had already made these choices. */
function browserState(payload, picks = {}, extra = {}) {
  const decisions = {};
  for (const it of payload.items) {
    const p = picks[it.thread_id] ?? {};
    decisions[it.thread_id] = { decision: p.decision ?? null, note: p.note ?? '', reply: it.reply_en ?? '', replyEdited: false };
  }
  return { [`sc:${payload.repo}#${payload.pr}`]: JSON.stringify({ payload, decisions, sentAt: null, sentVia: null, doneAt: null, ...extra }) };
}

const hidePill = (page) => page.addStyleTag({ content: '.sc-toggle{visibility:hidden}' });

(async () => {
  const { createHandler, createStore } = await import('../lib/server.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-shots-'));
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // A fixed clock, one minute per write, so the published times and the PNGs stay the same between runs.
  let tick = Date.parse('2026-09-30T17:40:00Z');
  const now = () => { tick += 60000; return new Date(tick).toISOString(); };
  server.on('request', createHandler({ store: createStore(root), port, now }));
  const api = (method, p, body) => nodeRequest(port, { method, url: `http://127.0.0.1:${port}${p}`, headers: { 'Content-Type': 'application/json', 'X-Second-Chair': '1' }, data: body && JSON.stringify(body) });
  const stored = async (pr, round) => JSON.parse((await api('GET', `/api/proposals?repo=${REPO}&pr=${pr}&round=${round}`)).responseText);

  await api('PUT', '/api/proposals', proposals(57, 1, HEAD1, reviewItems, 'review'));
  await api('PUT', '/api/proposals', proposals(42, 1, HEAD1, respondItems));
  const r1 = await stored(42, 1);
  const rv = await stored(57, 1);
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const url42 = `https://github.com/${REPO}/pull/42/files`;
  const url57 = `https://github.com/${REPO}/pull/57/files`;
  const html42 = (theme) => page({ theme, pr: 42, title: 'Fix LRU eviction under capacity', branch: 'fix/lru-eviction', blocks: respondBlocks, files: 4 });
  const html57 = page({ theme: 'light', pr: 57, title: 'Retry failed uploads', branch: 'upload-retry', blocks: reviewBlocks, files: 2 });
  const shots = [];
  const shoot = async (locator, name) => {
    const file = path.join(OUT, name);
    await locator.screenshot({ path: file, animations: 'disabled' });
    shots.push(file);
  };

  // 1, 2. One card under its thread, light and dark, nothing decided yet.
  for (const theme of ['light', 'dark']) {
    const p = await openPage(browser, port, { url: url42, html: html42(theme), store: browserState(r1), viewport: { width: 900, height: 1000 } });
    await p.waitForSelector('.sc-card[data-sc-card=PRRT_kwDOAbc042]');
    await hidePill(p);
    await shoot(p.locator('#f-r1042'), `card-${theme}.png`);
    await p.context().close();
  }

  // 3. The panel next to the page in round 1: three decided by the user, two auto, three left.
  {
    const store = { ...browserState(r1, { 'GLOBAL-1': { decision: 'pushback' }, PRRT_kwDOAbc018: { decision: 'fix' }, PRRT_kwDOAbc112: { decision: 'reply' } }), 'sc:ui': JSON.stringify({ filter: 'all', wide: false, open: true }) };
    const p = await openPage(browser, port, { url: url42, html: html42('light'), store, viewport: { width: 1000, height: 860 }, scale: 1.4 });
    await p.waitForSelector('.sc-row-main[data-sc-id=PRRT_kwDOAbc042]');
    await p.click('.sc-row-main[data-sc-id=PRRT_kwDOAbc042]');
    // Selecting a row scrolls the page to its thread and flashes the card for 1.6 s.
    await p.waitForTimeout(2200);
    // Show the whole thread from its file header, not the middle of the card.
    await p.evaluate(() => window.scrollTo(0, document.getElementById('f-r1042').getBoundingClientRect().top + window.scrollY - 16));
    await shoot(p, 'panel.png');
    await p.context().close();
  }

  // 4. Review mode: Revise picked, the note still empty.
  {
    const store = browserState(rv, { C2017: { decision: 'post' }, C2058: { decision: 'revise' } });
    const p = await openPage(browser, port, { url: url57, html: html57, store, viewport: { width: 900, height: 1000 } });
    await p.waitForSelector('.sc-card[data-sc-card=C2058] .sc-note-needed');
    await hidePill(p);
    await shoot(p.locator('#f-r2058'), 'review-mode.png');
    await p.context().close();
  }

  // 5. Round 2 sent: the triage is done, the panel is read only.
  {
    await api('PUT', '/api/proposals', proposals(42, 2, HEAD2, respondItems.map((it) => ({ ...it, auto: false, ...round2[it.thread_id] }))));
    const r2 = await stored(42, 2);
    const picks = Object.fromEntries(r2.items.map((it) => [it.thread_id, { decision: 'publish' }]));
    picks.PRRT_kwDOAbc112 = { decision: 'hold' };
    picks.PRRT_kwDOAbc309 = { decision: 'manual' };
    const store = { ...browserState(r2, picks, { sentAt: '2026-09-30T18:03:00.000Z', sentVia: 'server' }), 'sc:ui': JSON.stringify({ filter: 'all', wide: false, open: true }) };
    const p = await openPage(browser, port, { url: url42, html: html42('light'), store, viewport: { width: 1000, height: 830 }, scale: 1.4 });
    await p.waitForSelector('.sc-banner-done');
    await shoot(p.locator('.sc-panel'), 'done.png');
    await p.context().close();
  }

  // 6. The social preview: the mark, the name and the tagline on a 1280 x 640 page.
  {
    const mark = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="200" height="200" fill="none" stroke="#1f2328" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.75 1.75 5.25 9.25M3.75 9.25h8.5M5.25 9.25l-1 5M11 9.25l1 5"/></svg>';
    const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:1280px;height:640px;background:#f6f8fa;color:#1f2328;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px}
h1{margin:0;font-size:92px;font-weight:600;line-height:1}
p{margin:0;font-size:40px;color:#59636e}
</style>${mark}<h1>Second Chair</h1><p>AI prepares. You decide.</p>`;
    const context = await browser.newContext({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
    const p = await context.newPage();
    await p.setContent(html);
    const file = path.join(OUT, 'social-preview.png');
    await p.screenshot({ path: file });
    shots.push(file);
    await context.close();
  }

  await browser.close();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  for (const f of shots) console.log(`wrote ${path.relative(process.cwd(), f)} (${Math.round(fs.statSync(f).size / 1024)} KB)`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
