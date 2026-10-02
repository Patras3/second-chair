import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish } from '../lib/publish.mjs';
import { fakeGh, has } from './fake-gh.mjs';

// An in-memory stand-in for the server calls publish makes.
function fakeServer({ proposals, decisions }) {
  const published = {};
  const api = async (method, path, body) => {
    if (path.startsWith('/api/proposals')) return { status: 200, body: proposals };
    if (path.startsWith('/api/decisions')) return decisions ? { status: 200, body: decisions } : { status: 404, body: null };
    if (method === 'GET' && path.startsWith('/api/published')) return { status: 200, body: { items: structuredClone(published) } };
    if (method === 'POST' && path === '/api/published') { published[body.thread_id] = { action: body.action, url: body.url }; return { status: 200, body: { ok: true } }; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, published };
}

const tricky = 'Fixed in `abc`.\n\n- "quotes" and $HOME\n@ana-ng thanks';
const replyRound2 = {
  tool: 'second-chair', kind: 'proposals', repo: 'octo-org/example', pr: 3, round: 2, head: 'h',
  items: [
    { thread_id: 'G', comment_id: null, reply_en: 'Summary.' },
    { thread_id: 'T1', comment_id: 11, reply_en: 'draft' },
    { thread_id: 'T2', comment_id: 21, reply_en: 'later' },
    { thread_id: 'T3', comment_id: 31, reply_en: 'third' },
  ],
};
const replyDecisions = {
  tool: 'second-chair', kind: 'decisions', mode: 'reply', repo: 'octo-org/example', pr: 3, round: 2, head: 'h',
  decisions: [
    { thread_id: 'G', comment_id: null, decision: 'publish', reply_en: 'Summary.' },
    { thread_id: 'T1', comment_id: 11, decision: 'publish', reply_en: tricky },
    { thread_id: 'T2', comment_id: 21, decision: 'hold', reply_en: 'later' },
    { thread_id: 'T3', comment_id: 31, decision: 'publish', reply_en: 'third' },
  ],
};

test('respond mode posts exactly the approved texts, and nothing for hold', async () => {
  const srv = fakeServer({ proposals: replyRound2, decisions: replyDecisions });
  const { gh, calls } = fakeGh([
    { match: has('issues/3/comments'), reply: { html_url: 'g' } },
    { match: has('pulls/3/comments/11/replies'), reply: { html_url: 'r11' } },
    { match: has('pulls/3/comments/31/replies'), reply: { html_url: 'r31' } },
  ]);
  const r = await publish({ gh, api: srv.api, repo: 'octo-org/example', pr: 3, log: () => {} });
  assert.deepEqual(r.done, ['G', 'T1', 'T3']);
  assert.equal(calls.find((c) => c.args.some((a) => a.includes('/11/'))).input.body, tricky);
  assert.ok(!calls.some((c) => c.args.some((a) => a.includes('/21/'))));
});

test('respond mode posts nothing for hold or manual, and never from the proposals', async () => {
  const decisions = {
    ...replyDecisions,
    decisions: [
      { thread_id: 'T1', comment_id: 11, decision: 'manual', reply_en: 'x' },
      { thread_id: 'T2', comment_id: 21, decision: 'hold', reply_en: 'y' },
      { thread_id: 'T3', comment_id: 31, decision: 'publish', reply_en: 'approved text' },
    ],
  };
  const srv = fakeServer({ proposals: replyRound2, decisions });
  const { gh, calls } = fakeGh([{ match: has('comments/31/replies'), reply: { html_url: 'r31' } }]);
  const r = await publish({ gh, api: srv.api, repo: 'octo-org/example', pr: 3, log: () => {} });
  assert.deepEqual(r.done, ['T3']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.body, 'approved text');
});

test('a second run after a failure posts nothing twice', async () => {
  const srv = fakeServer({ proposals: replyRound2, decisions: replyDecisions });
  let fail = true;
  const script = [
    { match: has('issues/3/comments'), reply: { html_url: 'g' } },
    { match: has('comments/11/replies'), reply: { html_url: 'r11' } },
    { match: has('comments/31/replies'), reply: () => { if (fail) throw new Error('network'); return { html_url: 'r31' }; } },
  ];
  const first = fakeGh(script);
  await assert.rejects(publish({ gh: first.gh, api: srv.api, repo: 'octo-org/example', pr: 3, log: () => {} }), /network/);
  fail = false;
  const second = fakeGh(script);
  const r = await publish({ gh: second.gh, api: srv.api, repo: 'octo-org/example', pr: 3, log: () => {} });
  assert.deepEqual(r.skipped, ['G', 'T1']);
  assert.deepEqual(r.done, ['T3']);
  assert.equal(second.calls.length, 1);
});

test('publish refuses to run before the final round has decisions', async () => {
  const srv = fakeServer({ proposals: { ...replyRound2, round: 1 }, decisions: null });
  await assert.rejects(publish({ gh: fakeGh([]).gh, api: srv.api, repo: 'octo-org/example', pr: 3, log: () => {} }), /round 2/);
  const srv2 = fakeServer({ proposals: replyRound2, decisions: null });
  await assert.rejects(publish({ gh: fakeGh([]).gh, api: srv2.api, repo: 'octo-org/example', pr: 3, log: () => {} }), /no decisions/);
});

const reviewRound2 = {
  tool: 'second-chair', kind: 'proposals', mode: 'review', repo: 'octo-org/example', pr: 3, round: 2, head: 'h',
  items: [
    { thread_id: 'BODY', comment_id: null, reply_en: 'Overall fine.' },
    { thread_id: 'C1', comment_id: 5001, reply_en: 'Rename this?' },
    { thread_id: 'C2', comment_id: 5002, reply_en: 'Extract a helper.' },
  ],
};
const reviewDecisions = (body = 'Two notes.') => ({
  tool: 'second-chair', kind: 'decisions', mode: 'review', repo: 'octo-org/example', pr: 3, round: 2, head: 'h',
  decisions: [
    { thread_id: 'BODY', comment_id: null, decision: 'post', reply_en: body },
    { thread_id: 'C1', comment_id: 5001, decision: 'post', reply_en: 'Rename this to `size`?' },
    { thread_id: 'C2', comment_id: 5002, decision: 'drop', reply_en: 'Extract a helper.' },
  ],
});
const pendingFixture = { review_id: 901, node_id: 'PRR_me', body: 'Overall fine.', comments: [{ id: 5001, body: 'Rename this?' }, { id: 5002, body: 'Extract a helper.' }] };
const reviewGh = (extra = []) => fakeGh([
  { match: has('api', 'user'), reply: { login: 'me' } },
  { match: has('reviews/901/comments'), reply: [pendingFixture.comments] },
  { match: (a) => a.includes('--paginate') && a.some((x) => x.endsWith('pulls/3/reviews')), reply: [[{ id: 901, node_id: 'PRR_me', state: 'PENDING', user: { login: 'me' }, body: 'Overall fine.' }]] },
  { match: (a) => a.includes('PATCH') && a.some((x) => x.endsWith('pulls/comments/5001')), reply: {} },
  { match: (a) => a.includes('DELETE') && a.some((x) => x.endsWith('pulls/comments/5002')), reply: {} },
  { match: (a) => a.includes('PUT') && a.some((x) => x.endsWith('reviews/901')), reply: {} },
  ...extra,
]);

test('review mode edits and drops pending comments and does not submit by default', async () => {
  const srv = fakeServer({ proposals: reviewRound2, decisions: reviewDecisions() });
  const { gh, calls } = reviewGh();
  await publish({ gh, api: srv.api, repo: 'octo-org/example', pr: 3, log: () => {} });
  assert.equal(calls.find((c) => c.args.includes('PATCH')).input.body, 'Rename this to `size`?');
  assert.ok(calls.some((c) => c.args.includes('DELETE')));
  assert.equal(calls.find((c) => c.args.includes('PUT')).input.body, 'Two notes.');
  assert.ok(!calls.some((c) => c.args.some((a) => a.endsWith('/events'))), 'no submit');
});

test('review mode submits only with --submit, with the named event', async () => {
  const srv = fakeServer({ proposals: reviewRound2, decisions: reviewDecisions() });
  const { gh, calls } = reviewGh([{ match: has('reviews/901/events'), reply: {} }]);
  await publish({ gh, api: srv.api, repo: 'octo-org/example', pr: 3, submit: 'APPROVE', log: () => {} });
  assert.equal(calls.find((c) => c.args.some((a) => a.endsWith('/events'))).input.event, 'APPROVE');
  await assert.rejects(publish({ gh, api: srv.api, repo: 'octo-org/example', pr: 3, submit: 'MERGE', log: () => {} }), /COMMENT, APPROVE or REQUEST_CHANGES/);
});

test('review mode fails clearly when the pending review is gone', async () => {
  const srv = fakeServer({ proposals: reviewRound2, decisions: reviewDecisions() });
  const { gh } = fakeGh([
    { match: has('api', 'user'), reply: { login: 'me' } },
    { match: (a) => a.includes('--paginate'), reply: [[]] },
  ]);
  await assert.rejects(publish({ gh, api: srv.api, repo: 'octo-org/example', pr: 3, log: () => {} }), /no pending review/);
});
