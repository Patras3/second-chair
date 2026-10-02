// DOM smoke test: a fake PR page, GM_* stubbed, a real second-chair server, driven by Playwright.
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node test/dom-smoke.cjs
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { nodeRequest, installGm } = require('./gm-harness.cjs');

const script = fs.readFileSync(path.join(__dirname, '..', 'userscript', 'second-chair.user.js'), 'utf8');
// Tampermonkey loads these through @require; the test loads the same versions from test/vendor.
const vendor = ['marked.min.js', 'purify.min.js'].map((f) => fs.readFileSync(path.join(__dirname, 'vendor', f), 'utf8'));
const payload = {
  tool: 'second-chair', kind: 'proposals', repo: 'acme/w', pr: 7, round: 1, head: 'abc',
  items: [
    { thread_id: 'G', comment_id: null, verdict: 'manual', summary: 'general item' },
    { thread_id: 'T1', comment_id: 11, author: 'bob', path: 'x/Y.java', line: 3, verdict: 'fix', reply_en: 'Will change it:\n\n- first\n- second', summary: 'S1', context: 'C1 with **bold**' },
    { thread_id: 'T2', comment_id: 22, author: 'ann', path: 'z.md', line: 9, verdict: 'pushback', reply_en: 'No, because.', summary_pl: 'S2 legacy field' },
    { thread_id: 'T3', comment_id: 33, author: 'ann', path: 'q.md', line: 1, verdict: 'fix', auto: true, reply_en: 'Done in abc123' },
    { thread_id: 'T4', comment_id: 44, author: 'bob', path: 'h.md', line: 2, verdict: 'reply', auto: true, reply_en: 'Folded thread.' },
    { thread_id: 'T5', comment_id: 55, author: 'bob', path: 'l.md', line: 2, verdict: 'reply', auto: true, reply_en: 'Loaded later.' },
  ],
};
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
// T4 sits in a folded <details> the way GitHub folds a resolved thread; T5 appears only after "Load more".
const PAGE = `<html><head></head><body>
<div id="discussion_r11">comment 11</div><div style="height:1500px"></div>
<div id="discussion_r22">comment 22</div><div style="height:1500px"></div>
<div id="discussion_r33">comment 33</div><div style="height:1500px"></div>
<details><summary>resolved</summary><div id="discussion_r44">comment 44</div></details><div style="height:1500px"></div>
<button id="more" onclick="const d=document.createElement('div');d.id='discussion_r55';d.textContent='comment 55';this.after(d);this.remove()">Load more…</button>
<div style="height:3000px"></div></body></html>`;

async function openPage(browser, port, store, pr = 7) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.route(`https://github.com/acme/w/pull/${pr}`, (r) => r.fulfill({ contentType: 'text/html', body: PAGE }));
  await installGm(page, port, store);
  await page.goto(`https://github.com/acme/w/pull/${pr}`);
  for (const v of vendor) await page.addScriptTag({ content: v });
  await page.addScriptTag({ content: script });
  await page.waitForSelector('.sc-toggle');
  return page;
}

const inView = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }, sel);
const card = (id, where = 'inline') => `.sc-card[data-sc-where=${where}][data-sc-card=${id}]`;

(async () => {
  const { createHandler, createStore } = await import('../lib/server.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-smoke-'));
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.on('request', createHandler({ store: createStore(root), port }));
  const api = (method, p, body) => nodeRequest(port, { method, url: `http://127.0.0.1:${port}${p}`, headers: { 'Content-Type': 'application/json', 'X-Second-Chair': '1' }, data: body && JSON.stringify(body) });
  await api('PUT', '/api/proposals', payload);

  const browser = await chromium.launch();
  const page = await openPage(browser, port);
  await page.waitForSelector(card('T1'));
  check((await page.locator('.sc-card[data-sc-where=inline]').count()) === 4, 'cards for the four loaded threads; none for the general item or the unloaded one');
  check((await page.textContent('.sc-toggle')).includes('3/6'), 'the three auto items count as decided');
  check(await page.locator(`${card('T1')} .sc-md li`).count() === 2, 'the reply renders as markdown');
  check(await page.locator(`${card('T1')} .sc-foryou strong`).count() === 1, 'the context renders as markdown');
  check(await page.locator(`${card('T3')}.sc-compact`).count() === 1, 'an auto card is compact');
  check((await page.textContent(card('T2'))).includes('S2 legacy field'), 'the older summary_pl field still shows');

  const keys = await openPage(browser, port);
  await keys.waitForSelector(card('T2'));
  await keys.click('.sc-toggle');
  for (let i = 0; i < 3; i++) await keys.keyboard.press('j');
  await keys.keyboard.press('2');
  check((await keys.textContent('.sc-row[data-sc-item=T2] .sc-label')).trim() === 'Fix', 'j, j, j then 2 decides Fix on the third thread');
  await keys.keyboard.press('e');
  check(await keys.locator(`${card('T2')} textarea.sc-reply`).count() === 1, 'e opens Write');
  await keys.close();

  await page.click(`${card('T1')} [data-sc-act=tab][data-sc-val=write]`);
  const noScroll = await page.evaluate((s) => { const t = document.querySelector(`${s} textarea`); return t && t.scrollHeight <= t.clientHeight + 4; }, card('T1'));
  check(noScroll, 'the reply editor is tall enough to need no scrolling');
  await page.fill(`${card('T1')} textarea`, 'Edited reply.');
  await page.click(`${card('T1')} [data-sc-val=fix]`);
  check((await page.textContent('.sc-toggle')).includes('4/6'), 'a decision from the inline card counts');

  await page.click('.sc-toggle');
  check(await page.locator('.sc-dot.sc-up').count() === 1, 'the panel shows the server as on');
  check(await page.evaluate(() => getComputedStyle(document.body).marginRight !== '0px'), 'the page narrows next to the panel');
  await page.click('[data-sc-act=menu]');
  await page.click('[data-sc-act=wide]');
  check(await page.locator('.sc-menu').count() === 0, 'an action closes the menu');
  check(await page.evaluate(() => Math.abs(document.querySelector('.sc-panel').getBoundingClientRect().width - innerWidth / 2) < 2), 'half screen makes the panel half the window wide');
  check(await page.evaluate(() => Math.abs(parseFloat(getComputedStyle(document.body).marginRight) - innerWidth / 2) < 2), 'and the page gives up the same half');

  await page.click('[data-sc-act=filter][data-sc-val=auto]');
  check((await page.locator('.sc-row').count()) === 3, 'the Auto filter shows the three auto items');
  await page.click('[data-sc-act=filter][data-sc-val=todo]');
  check((await page.locator('.sc-row').count()) === 2, 'To decide shows the two undecided ones');
  await page.click('[data-sc-act=filter][data-sc-val=all]');

  await page.click('.sc-row-main[data-sc-id=T1]');
  await page.waitForTimeout(700);
  check(await inView(page, card('T1')), 'selecting an item scrolls the page to its thread');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(900);
  check(await page.locator('.sc-row.sc-selected[data-sc-item=T2]').count() === 1 && await inView(page, card('T2')), 'ArrowDown selects the next item and scrolls to it');
  await page.keyboard.press('j');
  await page.waitForTimeout(900);
  check(await inView(page, card('T3')), 'j moves on as well');
  await page.keyboard.press('j');
  await page.waitForTimeout(1200);
  check(await page.evaluate(() => document.querySelector('details').open) && await inView(page, card('T4')), 'moving to a folded thread unfolds it');
  await page.keyboard.press('j');
  await page.waitForSelector(card('T5'), { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(900);
  check(await inView(page, card('T5')), 'moving to an unloaded thread clicks Load more and scrolls to it');
  await page.keyboard.press('k');
  await page.waitForTimeout(600);
  check(await page.locator('.sc-row.sc-selected[data-sc-item=T4]').count() === 1, 'k moves back');

  await page.click('.sc-row-main[data-sc-id=T2]');
  await page.keyboard.press('1');
  check((await page.locator('.sc-row[data-sc-item=T2]').getAttribute('class')).includes('sc-decided'), 'the key 1 decides Reply on the selected row');
  await page.click('.sc-row-main[data-sc-id=G]');
  await page.click(`${card('G', 'panel')} [data-sc-val=manual]`);
  await page.fill(`${card('G', 'panel')} .sc-note`, 'I will write this one');
  await page.click('.sc-row-main[data-sc-id=T4]');
  await page.keyboard.press('Enter');
  await page.click(`${card('T4', 'panel')} [data-sc-val=manual]`);
  check(!(await page.isDisabled('[data-sc-act=export]')), 'send unlocks at 6/6');

  await page.click('[data-sc-act=export]');
  await page.waitForSelector('.sc-banner');
  check(/Decisions sent .*picks them up from the server/.test(await page.textContent('.sc-banner')), 'the sent banner names the server when it took the decisions');
  const got = await api('GET', '/api/decisions?repo=acme/w&pr=7&round=1');
  const out = got.status === 200 ? JSON.parse(got.responseText) : { decisions: [] };
  const by = Object.fromEntries(out.decisions.map((d) => [d.thread_id, d]));
  check(out.decisions.length === 6, 'the server holds six decisions');
  check(by.T1?.reply_en === 'Edited reply.' && by.T1.reply_edited === true, 'the edited reply reached the server');
  check(by.T3?.decision === 'fix' && by.T3.auto === true, 'an untouched auto item goes out as auto');
  check(by.T4?.decision === 'manual' && by.T4.auto === false, 'an overridden auto item goes out as yours');
  check(by.G?.note === 'I will write this one', 'the note reached the server');
  check(await page.locator(`${card('T2')}.sc-compact`).count() === 1, 'after sending, the cards are compact');
  await page.screenshot({ path: path.join(__dirname, 'smoke.png') });

  const storedR1 = await page.evaluate(() => JSON.stringify(window.__store));

  // Round 2 in reply mode: sending the final round ends the triage and takes the cards off the page.
  await api('PUT', '/api/proposals', { ...payload, round: 2, items: payload.items.map((i) => ({ ...i, verdict: 'publish', auto: false })) });
  await page.click('[data-sc-act=menu]');
  await page.click('[data-sc-act=fetch]');
  await page.waitForFunction(() => document.querySelector('.sc-panel-head').textContent.includes('round 2'));
  check((await page.textContent('.sc-toggle')).includes('0/6'), 'round 2 starts with nothing decided');
  for (const id of ['G', 'T1', 'T2', 'T3', 'T4', 'T5']) {
    await page.click(`.sc-row-main[data-sc-id=${id}]`);
    await page.keyboard.press('1');
  }
  await page.click('[data-sc-act=export]');
  await page.waitForSelector('.sc-banner-done');
  check((await page.textContent('.sc-toggle')).includes('✓ done'), 'the pill reads done after the final send');
  check(await page.locator('.sc-card[data-sc-where=inline]').count() === 0, 'after the final send no card stays on the page');
  check(await page.locator('[data-sc-act=export], [data-sc-act=markdone]').count() === 0, 'a finished triage has no Send and no Mark as done');
  const finalStored = await page.evaluate(() => JSON.stringify(window.__store));
  const reopened = await openPage(browser, 0, finalStored);
  await reopened.waitForTimeout(500);
  check(await reopened.locator('.sc-card[data-sc-where=inline]').count() === 0, 'a reload with the server down keeps them hidden');
  // The panel stays open across reloads, so no click on the pill.
  await reopened.click('[data-sc-act=showdone]');
  check(await reopened.locator('.sc-card[data-sc-where=inline]').count() >= 4, 'Show cards brings them back');
  await reopened.click(`${card('T1')} [data-sc-act=expand]`);
  check(await reopened.locator(`${card('T1')} [data-sc-act=decide]`).count() === 0 && await reopened.locator(`${card('T1')} [data-sc-field=note]`).count() === 0, 'an expanded card of a finished triage is read only');

  await api('POST', '/api/close', { repo: 'acme/w', pr: 7 });
  const page2 = await openPage(browser, port, storedR1);
  await page2.waitForFunction(() => document.querySelector('.sc-toggle').textContent.includes('done'));
  check(await page2.locator('.sc-card[data-sc-where=inline]').count() === 0, 'a closed triage shows no cards on the page');
  check(/closed/.test(await page2.textContent('.sc-banner-done')) && !/by the agent/.test(await page2.textContent('.sc-banner-done')), 'a closed banner does not say who closed it');
  await page2.click('[data-sc-act=showdone]');
  await page2.waitForSelector('.sc-card[data-sc-where=inline]');
  check(await page2.locator('.sc-card[data-sc-where=inline].sc-compact').count() >= 4, 'Show cards brings them back, compact');

  const r1state = JSON.stringify({ 'sc:acme/w#7': JSON.stringify({ payload, decisions: Object.fromEntries(payload.items.map((i) => [i.thread_id, { decision: 'manual', note: '', reply: '', replyEdited: false }])) }) });
  const offline = await openPage(browser, 0, r1state);
  await offline.click('.sc-toggle');
  await offline.waitForSelector('.sc-dot.sc-down');
  check(true, 'the panel shows the server as off');
  await offline.click('[data-sc-act=export]');
  await offline.waitForFunction(() => window.__clip);
  check(JSON.parse(await offline.evaluate(() => window.__clip)).decisions.length === 6, 'an offline send puts the decisions on the clipboard');
  await offline.waitForSelector('.sc-banner');
  const offBanner = await offline.textContent('.sc-banner');
  check(/clipboard/.test(offBanner) && !/server/.test(offBanner), 'the offline sent banner talks about the clipboard, not the server');

  // Review mode: the comments of a pending review on someone else's PR, decided Post, Revise or Drop.
  await api('PUT', '/api/proposals', {
    tool: 'second-chair', kind: 'proposals', mode: 'review', repo: 'acme/w', pr: 8, round: 1, head: 'def',
    items: [
      { thread_id: 'BODY', comment_id: null, author: 'review body', verdict: 'post', reply_en: 'Looks good.' },
      { thread_id: 'C1', comment_id: 11, author: 'comment', path: 'docs/a.md', line: 5, verdict: 'post', reply_en: 'A finding.', summary: 'the finding' },
    ],
  });
  const rv = await openPage(browser, port, null, 8);
  await rv.waitForSelector(card('C1'));
  check((await rv.textContent(card('C1'))).includes('Comment to post'), 'a review comment card says Comment to post');
  await rv.click(`${card('C1')} [data-sc-val=revise]`);
  await rv.click('.sc-toggle');
  await rv.click('.sc-row-main[data-sc-id=BODY]');
  await rv.click(`${card('BODY', 'panel')} [data-sc-val=post]`);
  check(await rv.isDisabled('[data-sc-act=export]'), 'send stays locked while Revise has no note');
  check(await rv.locator(`${card('C1')} .sc-note.sc-note-needed`).count() === 1, 'the empty note is marked');
  await rv.click(`${card('C1')} .sc-note`);
  await rv.keyboard.type('say it shorter');
  check(!(await rv.isDisabled('[data-sc-act=export]')), 'typing the note unlocks send');
  check(!/left/.test(await rv.textContent('[data-sc-act=export]')) && !/left/.test(await rv.textContent('.sc-left')), 'and the send label and counters stop saying left');
  check(!/needs a note/.test(await rv.textContent('.sc-row[data-sc-item=C1]')) && await rv.locator(`${card('C1')}.sc-decided`).count() === 1, 'the row and the inline card update while typing');
  check(await rv.evaluate(() => document.activeElement?.classList.contains('sc-note')), 'and the note keeps the focus');
  check(await rv.locator(`${card('C1')} .sc-note.sc-note-needed`).count() === 0, 'the mark goes away');
  await rv.click('[data-sc-act=export]');
  await rv.waitForSelector('.sc-banner');
  const rgot = await api('GET', '/api/decisions?repo=acme/w&pr=8&round=1');
  const rout = rgot.status === 200 ? JSON.parse(rgot.responseText) : { decisions: [] };
  check(rout.mode === 'review' && rout.decisions.find((d) => d.thread_id === 'C1')?.note === 'say it shorter', 'the review decisions reach the server with the note');

  rv.on('dialog', (d) => d.accept());
  await rv.click('[data-sc-act=menu]');
  await rv.click('[data-sc-act=markdone]');
  await rv.waitForSelector('.sc-banner-done');
  const closedNow = await api('GET', '/api/proposals?repo=acme/w&pr=8');
  check(JSON.parse(closedNow.responseText).closed_at, 'Mark as done closes the triage on the server');

  await browser.close();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : 'all ok');
  process.exit(failures ? 1 : 0);
})();
