import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { createHandler, createStore } from '../lib/server.mjs';

let server;
let base;
let root;
let port;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'sc-'));
  // Bind first to learn the port, then build the handler that checks Host against it.
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  let n = 0;
  server.on('request', createHandler({ store: createStore(root), port, now: () => `t${++n}` }));
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});

const H = { 'Content-Type': 'application/json', 'X-Second-Chair': '1' };
const call = async (method, path, body, headers = H) => {
  const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const proposals = (over = {}) => ({
  tool: 'second-chair', kind: 'proposals', repo: 'acme/w', pr: 7, round: 1, head: 'abc',
  items: [{ thread_id: 'T1', verdict: 'fix', reply_en: 'x' }, { thread_id: 'T2', verdict: 'reply', reply_en: 'y' }],
  ...over,
});
const decisions = (over = {}) => ({
  tool: 'second-chair', kind: 'decisions', repo: 'acme/w', pr: 7, round: 1, head: 'abc',
  decisions: [{ thread_id: 'T1', decision: 'fix' }, { thread_id: 'T2', decision: 'manual' }],
  ...over,
});

test('api calls without the custom header are refused', async () => {
  const r = await call('GET', '/api/proposals?repo=acme/w&pr=7', undefined, {});
  assert.equal(r.status, 403);
});

test('a foreign Host header is refused', async () => {
  // fetch cannot set Host, so this goes through http.request.
  const status = await new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/health', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
  });
  assert.equal(status, 403);
});

test('the userscript is served for install and update', async () => {
  const r = await fetch(`${base}/second-chair.user.js`);
  assert.equal(r.status, 200);
  assert.ok((await r.text()).startsWith('// ==UserScript=='));
});

test('proposals round-trip, the latest round wins, and a re-push drops that round\'s decisions', async () => {
  assert.equal((await call('GET', '/api/proposals?repo=acme/w&pr=7')).status, 404);
  assert.equal((await call('PUT', '/api/proposals', { tool: 'x' })).status, 400);
  assert.equal((await call('PUT', '/api/proposals', proposals())).status, 200);
  const got = await call('GET', '/api/proposals?repo=acme/w&pr=7');
  assert.equal(got.body.round, 1);
  assert.ok(got.body.published_at);

  assert.equal((await call('GET', '/api/decisions?repo=acme/w&pr=7&round=1')).status, 404);
  assert.equal((await call('POST', '/api/decisions', decisions())).status, 200);
  assert.equal((await call('GET', '/api/decisions?repo=acme/w&pr=7&round=1')).body.decisions.length, 2);

  await call('PUT', '/api/proposals', proposals());
  assert.equal((await call('GET', '/api/decisions?repo=acme/w&pr=7&round=1')).status, 404);

  await call('PUT', '/api/proposals', proposals({ round: 2, items: [{ thread_id: 'T1', reply_en: 'Done in abc' }] }));
  assert.equal((await call('GET', '/api/proposals?repo=acme/w&pr=7')).body.round, 2);
  assert.equal((await call('GET', '/api/proposals?repo=acme/w&pr=7&round=1')).body.round, 1);
  const status = (await call('GET', '/api/status')).body;
  assert.deepEqual(status.map((s) => [s.repo, s.pr, s.round]), [['acme/w', 7, 1], ['acme/w', 7, 2]]);
});

test('decisions must answer every thread of the current proposals', async () => {
  await call('PUT', '/api/proposals', proposals({ pr: 8 }));
  const bad = [
    [decisions({ pr: 8, decisions: [{ thread_id: 'T1', decision: 'fix' }] }), /1 threads have no decision/],
    [decisions({ pr: 8, head: 'old' }), /older head/],
    [decisions({ pr: 8, decisions: [{ thread_id: 'T1', decision: 'publish' }, { thread_id: 'T2', decision: 'fix' }] }), /no valid decision/],
    [decisions({ pr: 8, decisions: [{ thread_id: 'T9', decision: 'fix' }] }), /unknown thread_id/],
    [decisions({ pr: 9 }), /no proposals/],
  ];
  for (const [body, re] of bad) {
    const r = await call('POST', '/api/decisions', body);
    assert.equal(r.status, 409);
    assert.match(r.body.error, re);
  }
});

test('close marks the latest proposals closed, and a later publish reopens them', async () => {
  assert.equal((await call('POST', '/api/close', { repo: 'acme/w', pr: 77 })).status, 404);
  await call('PUT', '/api/proposals', proposals({ pr: 77 }));
  const c = await call('POST', '/api/close', { repo: 'acme/w', pr: 77 });
  assert.equal(c.status, 200);
  assert.equal((await call('GET', '/api/proposals?repo=acme/w&pr=77')).body.closed_at, c.body.closed_at);
  await call('PUT', '/api/proposals', proposals({ pr: 77, round: 2 }));
  assert.equal((await call('GET', '/api/proposals?repo=acme/w&pr=77')).body.closed_at, undefined);
});

test('review mode takes its own decisions, and Revise needs a note', async () => {
  const items = [{ thread_id: 'C1', verdict: 'post', reply_en: 'x' }, { thread_id: 'BODY', verdict: 'post', reply_en: 'y' }];
  assert.equal((await call('PUT', '/api/proposals', proposals({ pr: 20, mode: 'review', items }))).status, 200);
  assert.match((await call('PUT', '/api/proposals', proposals({ pr: 21, mode: 'nope' }))).body.error, /unknown mode/);
  const bad = [
    [[{ thread_id: 'C1', decision: 'fix' }, { thread_id: 'BODY', decision: 'post' }], /no valid decision/],
    [[{ thread_id: 'C1', decision: 'revise', note: ' ' }, { thread_id: 'BODY', decision: 'post' }], /revise needs a note/],
  ];
  for (const [ds, re] of bad) {
    const r = await call('POST', '/api/decisions', decisions({ pr: 20, decisions: ds }));
    assert.equal(r.status, 409);
    assert.match(r.body.error, re);
  }
  const ok = await call('POST', '/api/decisions', decisions({ pr: 20, decisions: [{ thread_id: 'C1', decision: 'revise', note: 'shorter' }, { thread_id: 'BODY', decision: 'drop' }] }));
  assert.equal(ok.status, 200);
});

test('the served userscript points at the port the server runs on', async () => {
  const text = await (await fetch(`${base}/second-chair.user.js`)).text();
  assert.ok(text.includes(`// @updateURL    http://127.0.0.1:${port}/second-chair.user.js`));
  assert.ok(text.includes(`'http://127.0.0.1:${port}'`));
});
