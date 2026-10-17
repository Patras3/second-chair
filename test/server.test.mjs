import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { createHandler, createStore, startServer } from '../lib/server.mjs';

let server;
let base;
let outer;
let root;
let port;

before(async () => {
  // The data directory sits one level down, so a test can see a write that escapes it.
  outer = await mkdtemp(join(tmpdir(), 'sc-'));
  root = join(outer, 'data');
  // Bind first to learn the port, then build the handler that checks Host against it.
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  let n = 0;
  // Padded, so the times sort as strings the way they do in ISO form.
  server.on('request', createHandler({ store: createStore(root), port, now: () => `t${String(++n).padStart(6, '0')}` }));
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  server.close();
  await rm(outer, { recursive: true, force: true });
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

test('published records append per thread and survive a re-read', async () => {
  await call('PUT', '/api/proposals', proposals({ pr: 30, round: 2, items: [{ thread_id: 'T1', reply_en: 'x' }] }));
  assert.deepEqual((await call('GET', '/api/published?repo=acme/w&pr=30&round=2')).body, { items: {} });
  assert.equal((await call('POST', '/api/published', { repo: 'acme/w', pr: 30, round: 2, thread_id: 'T1', action: 'replied', url: 'u1' })).status, 200);
  const got = (await call('GET', '/api/published?repo=acme/w&pr=30&round=2')).body;
  assert.equal(got.items.T1.action, 'replied');
  assert.equal(got.items.T1.url, 'u1');
  assert.equal((await call('POST', '/api/published', { repo: 'acme/w', pr: 30, round: 2, thread_id: 'T9', action: 'replied' })).status, 409);
  assert.equal((await call('POST', '/api/published', { repo: 'acme/w', pr: 30, round: '2', thread_id: 'T1', action: 'replied' })).status, 409);
  assert.equal((await call('POST', '/api/published', { repo: 'acme/w', pr: 30, round: 2, thread_id: 'T1' })).status, 409);
});

test('a repo or round that could leave the data directory is refused', async () => {
  for (const repo of ['../..', '../x', 'x/..', './x', 'x/.', '/x', 'x/']) {
    const r = await call('PUT', '/api/proposals', proposals({ repo }));
    assert.equal(r.status, 400, repo);
  }
  assert.equal((await call('PUT', '/api/proposals', proposals({ round: '1' }))).status, 400, 'a round that is a string');
  assert.equal((await call('GET', '/api/proposals?repo=../..&pr=7')).status, 400);
  assert.equal((await call('POST', '/api/close', { repo: '../x', pr: 7 })).status, 400);
  assert.equal((await call('POST', '/api/published', { repo: 'x/..', pr: 7, round: 1, thread_id: 'T1', action: 'replied' })).status, 409);
  await call('PUT', '/api/proposals', proposals({ pr: 40 }));
  for (const round of ['../../../../x', '1', 1.5, 0, null]) {
    const r = await call('POST', '/api/decisions', decisions({ pr: 40, round }));
    assert.equal(r.status, 409, String(round));
  }
  assert.equal((await call('GET', '/api/decisions?repo=acme/w&pr=40&round=1.5')).status, 400);
  assert.equal((await call('GET', '/api/published?repo=acme/w&pr=40&round=1.5')).status, 400);
  assert.deepEqual(await readdir(outer), ['data']);
  assert.deepEqual(await readdir(root), ['acme']);
  // Dots inside a name are fine.
  assert.equal((await call('PUT', '/api/proposals', proposals({ repo: 'octo.org/ex.ample', pr: 41 }))).status, 200);
});

test('a body over 5 MB gets a 413 answer, with or without a Content-Length', async () => {
  const big = Buffer.alloc(6 * 1024 * 1024, 'a');
  for (const chunked of [false, true]) {
    const status = await new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json', 'X-Second-Chair': '1', ...(chunked ? {} : { 'Content-Length': big.length }) };
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/decisions', headers }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      if (chunked) for (let i = 0; i < big.length; i += 1024 * 1024) req.write(big.subarray(i, i + 1024 * 1024));
      else req.write(big);
      req.end();
    });
    assert.equal(status, 413, chunked ? 'chunked' : 'with Content-Length');
  }
  assert.equal((await call('GET', '/api/status')).status, 200, 'the server still answers');
});

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const withChanges = (patch = '@@ -1 +1 @@\n-x\n+y\n') => ({
  tool: 'second-chair', kind: 'proposals', repo: 'acme/ch', pr: 9, round: 2, head: SHA_B,
  items: [{ thread_id: 'T1', verdict: 'publish', reply_en: 'Fixed.', commits: [SHA_B] }],
  changes: {
    base: SHA_A, head: SHA_B, add: 1, del: 1,
    commits: [{ sha: SHA_B, subject: 's', author: 'a', add: 1, del: 1, files: [{ path: 'f.txt', old_path: null, status: 'M', add: 1, del: 1, binary: false, patch }] }],
    range: { files: [{ path: 'f.txt', old_path: null, status: 'M', add: 1, del: 1, binary: false, patch, commits: [SHA_B] }] },
  },
});

test('the patches are stored apart and served on /api/changes', async () => {
  assert.equal((await call('PUT', '/api/proposals', withChanges())).status, 200);
  const p = await call('GET', '/api/proposals?repo=acme/ch&pr=9');
  assert.equal(p.body.changes.commits[0].files[0].patch, undefined);
  assert.equal(p.body.changes.range.files[0].add, 1);
  const c = await call('GET', '/api/changes?repo=acme/ch&pr=9&round=2');
  assert.equal(c.status, 200);
  assert.equal(c.body.published_at, p.body.published_at);
  assert.equal(c.body.commits[0].files[0].patch, '@@ -1 +1 @@\n-x\n+y\n');
  assert.equal((await call('GET', '/api/changes?repo=acme/ch&pr=9&round=x')).status, 400);
  assert.equal((await call('GET', '/api/changes?repo=acme/ch&pr=9&round=1')).status, 404);
});

test('a published_at sent inside changes does not override the server time', async () => {
  const forged = withChanges();
  forged.changes.published_at = '1999-01-01';
  assert.equal((await call('PUT', '/api/proposals', forged)).status, 200);
  const p = await call('GET', '/api/proposals?repo=acme/ch&pr=9');
  const c = await call('GET', '/api/changes?repo=acme/ch&pr=9&round=2');
  assert.equal(c.status, 200);
  assert.notEqual(p.body.published_at, '1999-01-01');
  assert.equal(c.body.published_at, p.body.published_at);
});

test('new proposals without changes remove the old patches, and a round 1 removes all of them', async () => {
  await call('PUT', '/api/proposals', withChanges());
  const lean = withChanges();
  delete lean.changes;
  await call('PUT', '/api/proposals', lean);
  assert.equal((await call('GET', '/api/changes?repo=acme/ch&pr=9&round=2')).status, 404);
  await call('PUT', '/api/proposals', withChanges());
  await call('PUT', '/api/proposals', { ...lean, round: 1, items: [{ thread_id: 'T1', verdict: 'fix', reply_en: 'x' }] });
  const names = await readdir(join(root, 'acme', 'ch', '9'));
  assert.equal(names.some((n) => n.endsWith('-changes.json')), false);
});

test('a bad changes shape is refused, and a payload up to 64 MB is taken', async () => {
  const bad = withChanges();
  bad.changes.head = 'nope';
  assert.equal((await call('PUT', '/api/proposals', bad)).status, 400);
  const big = withChanges(`@@ -1 +1 @@\n+${'x'.repeat(6 * 1024 * 1024)}\n`);
  assert.equal((await call('PUT', '/api/proposals', big)).status, 200);
  const small = { tool: 'second-chair', kind: 'decisions', repo: 'acme/ch', pr: 9, round: 2, head: SHA_B, decisions: [], pad: 'x'.repeat(6 * 1024 * 1024) };
  assert.equal((await call('POST', '/api/decisions', small)).status, 413);
});

test('with a pid file, the server writes its pid once it listens, and removes the file when it closes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sc-pid-'));
  const pidFile = join(dir, 'server.pid');
  const first = await startServer({ port: 0, root: dir, pidFile, log: () => {} });
  try {
    assert.equal(await readFile(pidFile, 'utf8'), String(process.pid));
    // A second server on the same port fails to listen. It must not touch the winner's pid file.
    await writeFile(pidFile, 'winner');
    await assert.rejects(startServer({ port: first.address().port, root: dir, pidFile, log: () => {} }), { code: 'EADDRINUSE' });
    assert.equal(await readFile(pidFile, 'utf8'), 'winner');
    await writeFile(pidFile, String(process.pid));
  } finally {
    await new Promise((r) => first.close(r));
  }
  assert.equal(await readFile(pidFile, 'utf8').catch(() => 'gone'), 'gone');
  await rm(dir, { recursive: true, force: true });
});

const decisionsFor = (p, over = {}) => ({ tool: 'second-chair', kind: 'decisions', repo: p.repo, pr: p.pr, round: p.round, head: p.head,
  decisions: p.items.map((it) => ({ thread_id: it.thread_id, decision: p.round === 1 ? 'reply' : 'publish', note: '' })), ...over });
const round2 = (pr) => proposals({ pr, round: 2, items: [{ thread_id: 'T1', verdict: 'publish', reply_en: 'x' }, { thread_id: 'T2', verdict: 'hold', reply_en: 'y' }] });

test('a resend becomes revision 2, and a read without peek picks it up', async () => {
  const p = proposals({ pr: 101 });
  await call('PUT', '/api/proposals', p);
  assert.deepEqual((await call('POST', '/api/decisions', decisionsFor(p))).body, { ok: true, revision: 1 });
  const peeked = await call('GET', '/api/decisions?repo=acme/w&pr=101&round=1&peek=1');
  assert.equal(peeked.body.picked_up_at, null);
  const read = await call('GET', '/api/decisions?repo=acme/w&pr=101&round=1');
  assert.ok(read.body.picked_up_at);
  assert.equal((await call('POST', '/api/decisions', decisionsFor(p))).body.revision, 2);
  assert.equal((await call('GET', '/api/decisions?repo=acme/w&pr=101&round=1&peek=1')).body.picked_up_at, null);
});

test('push of round 2 waits until the agent read a changed round 1', async () => {
  const p = proposals({ pr: 102 });
  await call('PUT', '/api/proposals', p);
  await call('POST', '/api/decisions', decisionsFor(p));
  await call('GET', '/api/decisions?repo=acme/w&pr=102&round=1');
  await call('POST', '/api/decisions', decisionsFor(p));
  const refused = await call('PUT', '/api/proposals', round2(102));
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /changed the round 1 decisions after you read them \(revision 2\).*second-chair get --repo acme\/w --pr 102 --round 1/);
  await call('GET', '/api/decisions?repo=acme/w&pr=102&round=1');
  assert.equal((await call('PUT', '/api/proposals', round2(102))).status, 200);
});

test('re-pushing round 2 after a Revise also waits for the read', async () => {
  const r2 = round2(103);
  await call('PUT', '/api/proposals', r2);
  const d = decisionsFor(r2, { decisions: [{ thread_id: 'T1', decision: 'revise', note: 'shorter' }, { thread_id: 'T2', decision: 'hold' }] });
  await call('POST', '/api/decisions', d);
  await call('GET', '/api/decisions?repo=acme/w&pr=103&round=2');
  await call('POST', '/api/decisions', d);
  assert.equal((await call('PUT', '/api/proposals', r2)).status, 409);
});

test('a resend is refused once the next round exists', async () => {
  const p = proposals({ pr: 104 });
  await call('PUT', '/api/proposals', p);
  await call('POST', '/api/decisions', decisionsFor(p));
  await call('GET', '/api/decisions?repo=acme/w&pr=104&round=1');
  await call('PUT', '/api/proposals', round2(104));
  const r = await call('POST', '/api/decisions', decisionsFor(p));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already sent round 2/);
});

test('a decisions file from 1.0 counts as revision 1, picked up', async () => {
  const p = proposals({ pr: 105 });
  await call('PUT', '/api/proposals', p);
  await writeFile(join(root, 'acme', 'w', '105', 'r1-decisions.json'), JSON.stringify({ ...decisionsFor(p), received_at: 't000000' }));
  assert.equal((await call('PUT', '/api/proposals', round2(105))).status, 200);
});

test('drafted ids are stored per pull request and replaced as a whole', async () => {
  assert.deepEqual((await call('GET', '/api/drafted?repo=acme/w&pr=106')).body, { ids: [] });
  assert.equal((await call('POST', '/api/drafted', { repo: 'acme/w', pr: 106, ids: [5, 6] })).status, 200);
  assert.equal((await call('POST', '/api/drafted', { repo: 'acme/w', pr: 106, ids: [7] })).status, 200);
  assert.deepEqual((await call('GET', '/api/drafted?repo=acme/w&pr=106')).body, { ids: [7] });
  assert.equal((await call('POST', '/api/drafted', { repo: 'acme/w', pr: 106, ids: ['x'] })).status, 400);
  assert.equal((await call('POST', '/api/drafted', { repo: '../x', pr: 106, ids: [1] })).status, 400);
});

test('the review submit is recorded under REVIEW', async () => {
  await call('PUT', '/api/proposals', proposals({ pr: 107, mode: 'review', round: 2, items: [{ thread_id: 'BODY', comment_id: null, verdict: 'post', reply_en: 'b' }] }));
  assert.equal((await call('POST', '/api/published', { repo: 'acme/w', pr: 107, round: 2, thread_id: 'REVIEW', action: 'submitted', event: 'COMMENT' })).status, 200);
  assert.equal((await call('GET', '/api/published?repo=acme/w&pr=107&round=2')).body.items.REVIEW.event, 'COMMENT');
  assert.equal((await call('POST', '/api/published', { repo: 'acme/w', pr: 107, round: 2, thread_id: 'REVIEW', action: 'submitted', event: 'MERGE' })).status, 409);
  await call('PUT', '/api/proposals', round2(108));
  assert.equal((await call('POST', '/api/published', { repo: 'acme/w', pr: 108, round: 2, thread_id: 'REVIEW', action: 'submitted', event: 'COMMENT' })).status, 409, 'not in reply mode');
});

test('status shows the revision and the pick-up', async () => {
  const p = proposals({ pr: 109 });
  await call('PUT', '/api/proposals', p);
  await call('POST', '/api/decisions', decisionsFor(p));
  const row = (await call('GET', '/api/status')).body.find((s) => s.pr === 109);
  assert.equal(row.revision, 1);
  assert.equal(row.picked_up_at, null);
});

test('a new review cycle starts with no record of what the last cycle published', async () => {
  const r2 = proposals({ pr: 110, mode: 'review', round: 2, items: [{ thread_id: 'BODY', comment_id: null, verdict: 'post', reply_en: 'b' }] });
  await call('PUT', '/api/proposals', r2);
  await call('POST', '/api/published', { repo: 'acme/w', pr: 110, round: 2, thread_id: 'REVIEW', action: 'submitted', event: 'COMMENT' });
  await call('PUT', '/api/proposals', round2(110));
  assert.ok((await call('GET', '/api/published?repo=acme/w&pr=110&round=2')).body.items.REVIEW, 'a re-push of round 2 keeps the record');
  await call('PUT', '/api/proposals', proposals({ pr: 110, mode: 'review', items: [{ thread_id: 'BODY', comment_id: null, verdict: 'post', reply_en: 'b' }] }));
  assert.deepEqual((await call('GET', '/api/published?repo=acme/w&pr=110&round=2')).body, { items: {} });
});

test('decisions that answer an older publication of the round are refused', async () => {
  const p = proposals({ pr: 111 });
  await call('PUT', '/api/proposals', p);
  const first = (await call('GET', '/api/proposals?repo=acme/w&pr=111')).body.published_at;
  await call('PUT', '/api/proposals', p);
  const r = await call('POST', '/api/decisions', decisionsFor(p, { published_at: first }));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /the agent sent a new version of round 1; decide there/);
  const now = (await call('GET', '/api/proposals?repo=acme/w&pr=111')).body.published_at;
  assert.equal((await call('POST', '/api/decisions', decisionsFor(p, { published_at: now }))).status, 200);
  assert.equal((await call('POST', '/api/decisions', decisionsFor(p))).status, 200, 'a 1.0 page sends no published_at, and is not checked');
});

test('attention is set, read and cleared, and needs proposals first', async () => {
  assert.equal((await call('POST', '/api/attention', { repo: 'acme/w', pr: 201, message: 'x' })).status, 404, 'no panel to show it in');
  await call('PUT', '/api/proposals', proposals({ pr: 201 }));
  assert.deepEqual((await call('GET', '/api/attention?repo=acme/w&pr=201')).body, { attention: null });
  const set = await call('POST', '/api/attention', { repo: 'acme/w', pr: 201, message: `  ${'m'.repeat(400)}  ` });
  assert.equal(set.status, 200);
  const got = (await call('GET', '/api/attention?repo=acme/w&pr=201')).body.attention;
  assert.equal(got.at, set.body.at);
  assert.equal(got.source, 'agent');
  assert.equal(got.message.length, 300, 'the message is trimmed and capped');
  assert.equal((await call('DELETE', '/api/attention?repo=acme/w&pr=201')).status, 200);
  assert.equal((await call('GET', '/api/attention?repo=acme/w&pr=201')).body.attention, null);
  assert.equal((await call('POST', '/api/attention', { repo: 'acme/w', pr: 201, source: 'me' })).status, 400);
  assert.equal((await call('POST', '/api/attention', { repo: 'acme/w', pr: 201, message: 7 })).status, 400);
  assert.equal((await call('GET', '/api/attention?repo=acme/w')).status, 400);
});

test('a push, a publish record and a close each clear the attention', async () => {
  const p = proposals({ pr: 202 });
  const ask = () => call('POST', '/api/attention', { repo: 'acme/w', pr: 202 });
  const asked = async () => (await call('GET', '/api/attention?repo=acme/w&pr=202')).body.attention !== null;
  await call('PUT', '/api/proposals', p);
  await ask();
  await call('PUT', '/api/proposals', p);
  assert.equal(await asked(), false, 'push');
  await ask();
  await call('POST', '/api/published', { repo: 'acme/w', pr: 202, round: 1, thread_id: 'T1', action: 'replied' });
  assert.equal(await asked(), false, 'publish');
  await ask();
  assert.ok((await call('GET', '/api/status')).body.find((s) => s.pr === 202).attention_at, 'status shows it');
  await call('POST', '/api/close', { repo: 'acme/w', pr: 202 });
  assert.equal(await asked(), false, 'close');
});

test('a session hook marks only the pull requests whose decisions that session holds, and clears them when the user is back', async () => {
  const sid = 'sess-1';
  const held = proposals({ pr: 203 });
  await call('PUT', `/api/proposals?session=${sid}`, held);
  await call('POST', '/api/decisions', decisionsFor(held));
  // Sent but this session never pushed or read it: another agent's work.
  const other = proposals({ pr: 204 });
  await call('PUT', '/api/proposals?session=sess-2', other);
  await call('POST', '/api/decisions', decisionsFor(other));
  // Pushed by this session, but the user has not sent yet: the user's turn, not the agent's.
  await call('PUT', `/api/proposals?session=${sid}`, proposals({ pr: 205 }));
  const r = await call('POST', '/api/session', { session: sid, event: 'waiting', message: 'Claude needs your permission to use Bash' });
  assert.deepEqual(r.body, { ok: true, prs: [{ repo: 'acme/w', pr: 203 }] });
  const a = (await call('GET', '/api/attention?repo=acme/w&pr=203')).body.attention;
  assert.equal(a.source, 'hook');
  assert.equal(a.message, 'Claude needs your permission to use Bash');
  for (const pr of [204, 205]) assert.equal((await call('GET', `/api/attention?repo=acme/w&pr=${pr}`)).body.attention, null);
  await call('POST', '/api/session', { session: sid, event: 'back' });
  assert.equal((await call('GET', '/api/attention?repo=acme/w&pr=203')).body.attention, null);
  assert.equal((await call('POST', '/api/session', { session: 'bad id!', event: 'waiting' })).status, 400);
  assert.equal((await call('POST', '/api/session', { session: sid, event: 'nap' })).status, 400);
});

test('reading the decisions moves the work to the reading session, and a hook keeps the agent message', async () => {
  const p = proposals({ pr: 206 });
  await call('PUT', '/api/proposals?session=old', p);
  await call('POST', '/api/decisions', decisionsFor(p));
  await call('GET', '/api/decisions?repo=acme/w&pr=206&round=1&peek=1&session=peeker');
  assert.deepEqual((await call('POST', '/api/session', { session: 'peeker', event: 'waiting' })).body.prs, [], 'the page peeks, it holds nothing');
  await call('GET', '/api/decisions?repo=acme/w&pr=206&round=1&session=new');
  assert.deepEqual((await call('POST', '/api/session', { session: 'old', event: 'waiting' })).body.prs, []);
  await call('POST', '/api/attention', { repo: 'acme/w', pr: 206, message: 'Which name do you want?' });
  assert.deepEqual((await call('POST', '/api/session', { session: 'new', event: 'waiting', message: 'Claude is waiting for your input' })).body.prs, [{ repo: 'acme/w', pr: 206 }]);
  assert.equal((await call('GET', '/api/attention?repo=acme/w&pr=206')).body.attention.message, 'Which name do you want?');
});
