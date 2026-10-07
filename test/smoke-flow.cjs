// Flow smoke test: the phases of a round in a real browser against a real server. Whose turn it is, the waiting
// footer, the next round loading by itself, Edit and send again, publishing and done, and polling.
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node test/smoke-flow.cjs
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { nodeRequest, installGm } = require('./gm-harness.cjs');

const script = fs.readFileSync(path.join(__dirname, '..', 'userscript', 'second-chair.user.js'), 'utf8');
const vendor = ['marked.min.js', 'purify.min.js'].map((f) => fs.readFileSync(path.join(__dirname, 'vendor', f), 'utf8'));
const PAGE = '<html><head></head><body><div id="discussion_r11">comment 11</div><div style="height:800px"></div><div id="discussion_r22">comment 22</div><div style="height:1500px"></div></body></html>';
// Like Files changed: page code around a thread takes clicks on links and buttons and stops them.
const EATER = '<html><head></head><body><div id="eater"><div id="discussion_r11">comment 11</div></div><div style="height:800px"></div><div id="discussion_r22">comment 22</div><div style="height:1500px"></div>'
  + '<script>document.getElementById("eater").addEventListener("click", (e) => { if (e.target.closest("a, button")) { e.preventDefault(); e.stopPropagation(); window.__eaten = (window.__eaten || 0) + 1; } });</script></body></html>';
const proposals = (pr, round, over = {}) => ({
  tool: 'second-chair', kind: 'proposals', repo: 'acme/w', pr, round, head: `h${round}`,
  items: [
    { thread_id: 'T1', comment_id: 11, author: 'bob', path: 'a.js', line: 1, verdict: round === 1 ? 'fix' : 'publish', reply_en: 'One.', summary: 'first' },
    { thread_id: 'T2', comment_id: 22, author: 'ann', path: 'b.js', line: 2, verdict: round === 1 ? 'reply' : 'publish', reply_en: 'Two.', summary: 'second' },
  ],
  ...over,
});

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const card = (id, where = 'inline') => `.sc-card[data-sc-where=${where}][data-sc-card=${id}]`;
// The guide shows once per browser; these pages start as a browser that has seen it.
const SEEN = { 'sc:guide': '1', 'sc:ui': JSON.stringify({ filter: 'all', wide: false, open: true }) };

async function openPage(browser, port, pr, store = SEEN, html = PAGE) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.route(`https://github.com/acme/w/pull/${pr}`, (r) => r.fulfill({ contentType: 'text/html', body: html }));
  await installGm(page, port, JSON.stringify(store));
  await page.goto(`https://github.com/acme/w/pull/${pr}`);
  for (const v of vendor) await page.addScriptTag({ content: v });
  await page.addScriptTag({ content: script });
  await page.waitForSelector('.sc-toggle');
  return page;
}
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? '', sel);
const within = (page, fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);

async function decideAndSend(page, key) {
  for (const id of ['T1', 'T2']) await page.click(`${card(id)} [data-sc-act=decide][data-sc-val=${key}]`);
  await page.click('[data-sc-act=export]');
}

(async () => {
  const { createHandler, createStore } = await import('../lib/server.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-flow-'));
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.on('request', createHandler({ store: createStore(root), port }));
  const api = async (method, p, body) => {
    const r = await nodeRequest(port, { method, url: `http://127.0.0.1:${port}${p}`, headers: { 'Content-Type': 'application/json', 'X-Second-Chair': '1' }, data: body && JSON.stringify(body) });
    return { status: r.status, body: r.responseText ? JSON.parse(r.responseText) : null };
  };
  const browser = await chromium.launch();

  // 0. First use: the guide opens by itself, once; a pull request without proposals keeps the panel closed.
  const first = await openPage(browser, port, 5, { 'sc:ui': JSON.stringify({ filter: 'all', wide: false, open: true }) });
  await first.waitForSelector('body > .sc-panel .sc-guide');
  check(await first.evaluate(() => !document.querySelector('body > .sc-panel').hidden), 'on first use the panel opens with the guide');
  check(/The agent proposes/.test(await text(first, '.sc-guide')) && /\/second-chair:respond 5/.test(await text(first, '.sc-guide')), 'the guide says who does what and how to start');
  await first.click('.sc-guide [data-sc-act=guidetab][data-sc-val=review]');
  check(/\/second-chair:review 5/.test(await text(first, '.sc-guide')), 'the Review tab explains review mode');
  await first.click('[data-sc-act=guidedone]');
  check(await first.evaluate(() => document.querySelector('body > .sc-panel').hidden), 'Got it closes the guide, and the empty panel with it');
  const seen = await first.evaluate(() => JSON.stringify(window.__store));
  check(JSON.parse(seen)['sc:guide'] !== undefined, 'the browser remembers that the guide was seen');
  await first.close();
  const again = await openPage(browser, port, 5, JSON.parse(seen));
  await again.waitForTimeout(800);
  check(await again.evaluate(() => document.querySelector('body > .sc-panel').hidden), 'a pull request without proposals keeps the panel closed, though it was left open');
  check((await text(again, '.sc-toggle')).includes('–'), 'the pill shows a dash');
  await again.click('.sc-toggle');
  await again.waitForSelector('.sc-empty-panel');
  check(/\/second-chair:review 5/.test(await text(again, '.sc-empty-panel')) && await again.locator('.sc-paste').count() === 0, 'the empty panel says how to start, without a paste box');
  await again.click('[data-sc-act=guide]');
  check(await again.locator('.sc-guide').count() === 1, 'the ? and How it works open the guide again');
  await again.click('[data-sc-act=guidedone]');
  check(await again.evaluate(() => JSON.parse(window.__store['sc:ui']).open === true), 'closing an empty panel does not change the saved preference');
  await again.close();
  const closer = await openPage(browser, port, 5, { 'sc:ui': JSON.stringify({ filter: 'all', wide: false, open: false }) });
  await closer.waitForSelector('.sc-guide');
  await closer.click('[data-sc-act=panel][aria-label=Close]');
  const closedStore = await closer.evaluate(() => window.__store);
  await closer.close();
  const after = await openPage(browser, port, 5, closedStore);
  await after.waitForTimeout(800);
  check(await after.locator('.sc-guide').count() === 0, 'closing the guide with ✕ also counts as seen');
  await after.close();

  // 1. After the send of round 1: the agent's turn, a waiting footer, no Send button.
  await api('PUT', '/api/proposals', proposals(7, 1));
  const page = await openPage(browser, port, 7);
  await page.waitForSelector(card('T1'));
  check((await text(page, '.sc-status')).startsWith('Your turn.'), 'before the send it is your turn');
  await decideAndSend(page, 'reply');
  await page.waitForSelector('.sc-wait');
  check(await page.locator('[data-sc-act=export]').count() === 0, 'after the send there is no Send button');
  check(/Waiting for round 2/.test(await text(page, '.sc-wait')), 'the footer says it waits for round 2');
  check((await text(page, '.sc-status')).startsWith('Agent\'s turn.'), 'the status line says it is the agent\'s turn');
  check((await text(page, '.sc-toggle')).includes('waiting'), 'the pill says waiting');
  check(await page.locator(`${card('T1')} [data-sc-act=decide]`).count() === 0, 'the cards are read only while the agent works');

  // 2. The agent reads the decisions; the page learns it by polling.
  await api('GET', '/api/decisions?repo=acme/w&pr=7&round=1');
  check(await within(page, () => /picked up your decisions/.test(document.querySelector('.sc-status')?.textContent ?? '')), 'the page shows that the agent picked the decisions up');

  // 5. Edit and send again after the pick-up: a warning, then a revision the agent must read.
  let warned = '';
  page.once('dialog', (d) => { warned = d.message(); d.accept(); });
  await page.click('[data-sc-act=resend]');
  check(/picked up your decisions .* may already be working on them/.test(warned), 'Edit and send again warns that the agent may be working already');
  await page.waitForSelector(`${card('T2')} [data-sc-act=decide][data-sc-val=manual]`);
  await page.click(`${card('T2')} [data-sc-act=decide][data-sc-val=manual]`);
  check(/Send again/.test(await text(page, '[data-sc-act=export]')), 'the button says Send again');
  await page.click('[data-sc-act=export]');
  await page.waitForSelector('.sc-wait');
  const rev = await api('GET', '/api/decisions?repo=acme/w&pr=7&round=1&peek=1');
  check(rev.body.revision === 2 && rev.body.decisions.find((d) => d.thread_id === 'T2').decision === 'manual', 'the second send is revision 2 with the change');
  check((await api('PUT', '/api/proposals', proposals(7, 2))).status === 409, 'the agent cannot push round 2 before it read the change');

  // 3. The agent reads the change and pushes round 2; it loads without a reload.
  await api('GET', '/api/decisions?repo=acme/w&pr=7&round=1');
  check((await api('PUT', '/api/proposals', proposals(7, 2))).status === 200, 'after the read, the push goes through');
  check(await within(page, () => /round 2/.test(document.querySelector('.sc-panel-head')?.textContent ?? '')), 'round 2 loads by itself');
  check((await text(page, '.sc-status')).startsWith('Your turn.'), 'and it is your turn again');

  // 4. The final send: publishing until the agent closes, then done with what was posted.
  await decideAndSend(page, 'publish');
  await page.waitForSelector('.sc-wait');
  check(/pushes the commits and posts/.test(await text(page, '.sc-status')), 'after the final send the agent publishes');
  check((await text(page, '.sc-toggle')).includes('publishing'), 'the pill says publishing');
  check(await page.locator('.sc-card[data-sc-where=inline]').count() === 0, 'no card stays next to the replies being posted');
  await api('POST', '/api/published', { repo: 'acme/w', pr: 7, round: 2, thread_id: 'T1', action: 'replied', url: 'https://github.com/acme/w/pull/7#discussion_r99' });
  await api('POST', '/api/close', { repo: 'acme/w', pr: 7 });
  check(await within(page, () => document.querySelector('.sc-banner-done') !== null), 'the close turns the page to done');
  check(await within(page, () => /Posted 1 reply\. 1 not posted\./.test(document.querySelector('.sc-banner-done')?.textContent ?? '')), 'done says what was posted');
  check(await page.locator('.sc-banner-done a[href="https://github.com/acme/w/pull/7#discussion_r99"]').count() === 1, 'with a link to the posted reply');
  check((await text(page, '.sc-toggle')).includes('✓ done'), 'the pill says done');
  const back = await openPage(browser, port, 7, await page.evaluate(() => window.__store));
  check(await within(back, () => /Posted 1 reply\./.test(document.querySelector('.sc-banner-done')?.textContent ?? '')), 'opened again later, done still says what was posted');
  await back.close();

  // 6. A resend after the agent already pushed the next round is refused, and the page moves on.
  await api('PUT', '/api/proposals', proposals(8, 1));
  const race = await openPage(browser, port, 8);
  await race.waitForSelector(card('T1'));
  await decideAndSend(race, 'reply');
  await race.waitForSelector('.sc-wait');
  await api('GET', '/api/decisions?repo=acme/w&pr=8&round=1');
  race.once('dialog', (d) => d.accept());
  await race.click('[data-sc-act=resend]');
  await api('PUT', '/api/proposals', proposals(8, 2));
  await race.waitForSelector(`${card('T1')} [data-sc-act=decide]`).catch(() => {});
  const clip = await race.evaluate(() => window.__clip ?? null);
  await race.click('[data-sc-act=export]').catch(() => {});
  check(await within(race, () => /already sent round 2/.test(document.querySelector('.sc-panel')?.textContent ?? '')), 'a resend after round 2 arrived says the agent already sent it');
  check(await within(race, () => /round 2/.test(document.querySelector('.sc-panel-head')?.textContent ?? '')), 'and round 2 loads');
  check((await race.evaluate(() => window.__clip ?? null)) === clip, 'nothing goes to the clipboard for a refused resend');

  // 7. Two tabs: the second one asks before it replaces what the first one sent.
  await api('PUT', '/api/proposals', proposals(9, 1));
  const tabA = await openPage(browser, port, 9);
  const tabB = await openPage(browser, port, 9);
  await tabA.waitForSelector(card('T1'));
  await tabB.waitForSelector(card('T1'));
  await decideAndSend(tabA, 'reply');
  await tabA.waitForSelector('.sc-wait');
  let asked = '';
  tabB.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
  await decideAndSend(tabB, 'manual');
  await tabB.waitForTimeout(500);
  check(/already sent/.test(asked), 'the second tab asks before it replaces sent decisions');
  check((await api('GET', '/api/decisions?repo=acme/w&pr=9&round=1&peek=1')).body.revision === 1, 'and a No sends nothing');

  // 10. Review round 2: the review body and the submit choice in one block; GitHub's limits lock the send.
  await api('PUT', '/api/proposals', { tool: 'second-chair', kind: 'proposals', mode: 'review', repo: 'acme/w', pr: 11, round: 2, head: 'h2', items: [
    { thread_id: 'BODY', comment_id: null, verdict: 'post', reply_en: 'Two blocking points.', needs_submit: true, suggested_submit: 'REQUEST_CHANGES', context: 'The cache never evicts.' },
    { thread_id: 'C1', comment_id: 11, path: 'a.js', line: 1, verdict: 'post', reply_en: 'Evict here.' },
  ] });
  const rv = await openPage(browser, port, 11);
  await rv.waitForSelector('.sc-yourreview');
  check(await rv.locator('.sc-yourreview .sc-card[data-sc-card=BODY]').count() === 1, 'the review body sits in the Your review block');
  check(await rv.evaluate(() => { const bar = document.querySelector('.sc-tabbar'); return bar.scrollHeight <= bar.clientHeight; }), 'the filter bar has nothing to scroll up and down');
  check(await rv.locator('.sc-row[data-sc-item=BODY]').count() === 0, 'and not in the file list');
  check(await rv.locator('.sc-yourreview [data-sc-act=submit][data-sc-val=""].sc-on').count() === 1, 'Leave as draft is the default');
  check(await rv.locator('.sc-yourreview [data-sc-act=submit][data-sc-val=REQUEST_CHANGES].sc-suggested').count() === 1, 'the agent suggestion is outlined, not chosen');
  await rv.click('.sc-yourreview [data-sc-card=BODY] [data-sc-act=decide][data-sc-val=post]');
  await rv.click(`${card('C1')} [data-sc-act=decide][data-sc-val=post]`);
  check(await rv.isDisabled('[data-sc-act=export]'), 'a kept body that needs the submit locks Leave as draft');
  check(/GitHub adds this body only with the submit/.test(await text(rv, '.sc-lock')), 'and the footer says why');
  await rv.click('.sc-yourreview [data-sc-act=submit][data-sc-val=COMMENT]');
  check(!(await rv.isDisabled('[data-sc-act=export]')) && await rv.locator('.sc-lock[hidden]').count() === 1, 'choosing Comment unlocks the send');
  await rv.click('[data-sc-act=export]');
  await rv.waitForSelector('.sc-wait');
  check((await api('GET', '/api/decisions?repo=acme/w&pr=11&round=2&peek=1')).body.submit === 'COMMENT', 'the decisions carry the submit');
  check(/Then it submits it as Comment/.test(await text(rv, '.sc-status')), 'the status says the agent will submit it');
  const fresh = await openPage(browser, port, 11, {});
  check(await within(fresh, () => document.querySelector('.sc-guide [data-sc-val=review][aria-selected=true]') !== null), 'on first use in a review, the guide opens on the Review tab');
  await fresh.close();

  // 11. Every control works inside page code that eats clicks, and editing is plain to see.
  await api('PUT', '/api/proposals', proposals(12, 1));
  const ed = await openPage(browser, port, 12, SEEN, EATER);
  await ed.waitForSelector(card('T1'));
  check(await ed.evaluate(() => document.querySelector('#eater .sc-card[data-sc-card=T1]') !== null), 'the card sits inside the click-eating container');
  await ed.click('.sc-row-main[data-sc-id=T1]');
  await ed.click(`${card('T1')} [data-sc-act=edit]`);
  check(await ed.locator(`${card('T1')} textarea.sc-reply`).count() === 1, 'Edit opens the editor there');
  check(await ed.locator(card('T1', 'panel')).count() === 0, 'editing inline opens no second copy in the panel');
  check(await ed.evaluate(() => document.activeElement?.classList.contains('sc-reply')), 'and puts the cursor in it');
  await ed.fill(`${card('T1')} textarea.sc-reply`, 'Mine.');
  await ed.click(`${card('T1')} [data-sc-act=preview]`);
  check((await text(ed, `${card('T1')} .sc-reply-box`)).includes('Mine.') && /edited by you/.test(await text(ed, `${card('T1')} .sc-caption`)), 'Preview shows the edited text, marked as yours');
  await ed.click(`${card('T1')} [data-sc-act=undo]`);
  check((await text(ed, `${card('T1')} .sc-reply-box`)).includes('One.') && !/edited/.test(await text(ed, `${card('T1')} .sc-caption`)), 'Undo my edits brings the agent text back');
  await ed.click(`${card('T1')} .sc-preview`);
  check(await ed.locator(`${card('T1')} textarea.sc-reply`).count() === 1, 'a click on the text starts editing');
  await ed.keyboard.press('Escape');
  check(await ed.locator(`${card('T1')} textarea.sc-reply`).count() === 0 && await ed.locator(`${card('T1')} .sc-preview`).count() === 1, 'Esc ends editing');
  await ed.click(`${card('T1')} [data-sc-act=decide][data-sc-val=reply]`);
  check(await ed.locator(`${card('T1')}.sc-decided`).count() === 1, 'a decision button works there');
  await ed.click(`${card('T1')} [data-sc-act=next]`);
  check(await ed.locator('.sc-row.sc-selected[data-sc-item=T2]').count() === 1, 'the next arrow works there');
  check(await ed.evaluate(() => !window.__eaten), 'the page code never saw a click on our controls');
  await ed.close();

  // 9. Polling pauses while the tab is hidden and resumes at once when it is visible.
  await tabA.evaluate(() => { const orig = window.__gmx; window.__calls = 0; window.__gmx = (r) => { window.__calls++; return orig(r); }; });
  await tabA.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); window.__calls = 0; });
  await tabA.waitForTimeout(6500);
  check(await tabA.evaluate(() => window.__calls) === 0, 'a hidden tab does not poll');
  await tabA.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  check(await within(tabA, () => window.__calls > 0, undefined, 1500), 'a visible tab polls at once');

  // 8. The server stops while a page waits: a red dot, no error box, and polling goes on.
  server.close();
  server.closeAllConnections?.();
  check(await within(tabA, () => document.querySelector('.sc-dot.sc-down') !== null), 'the dot turns red when the server stops');
  check(await tabA.locator('.sc-msg.sc-err').count() === 0, 'and no error message shows');

  await browser.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : 'all ok');
  process.exit(failures ? 1 : 0);
})();
