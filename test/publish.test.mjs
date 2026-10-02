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

// fetchPending asks for these; in reply mode publish asks only when it has a reply to post.
const noThreads = { match: (a) => a.includes('graphql') && a.some((x) => x.startsWith('query=')), reply: { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } } };
const noPending = [
  noThreads,
  { match: has('api', 'user'), reply: { login: 'me' } },
  { match: (a) => a.includes('--paginate') && a.some((x) => x.endsWith('pulls/3/reviews')), reply: [[]] },
];
const writes = (calls) => calls.filter((c) => c.input !== undefined || c.args.includes('DELETE'));

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
    ...noPending,
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
  const { gh, calls } = fakeGh([...noPending, { match: has('comments/31/replies'), reply: { html_url: 'r31' } }]);
  const r = await publish({ gh, api: srv.api, repo: 'octo-org/example', pr: 3, log: () => {} });
  assert.deepEqual(r.done, ['T3']);
  assert.equal(writes(calls).length, 1);
  assert.equal(writes(calls)[0].input.body, 'approved text');
});

test('a second run after a failure posts nothing twice', async () => {
  const srv = fakeServer({ proposals: replyRound2, decisions: replyDecisions });
  let fail = true;
  const script = [
    ...noPending,
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
  assert.equal(writes(second.calls).length, 1);
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
const pendingFixture = { review_id: 901, node_id: 'PRR_me', body: 'Overall fine.', comments: [{ id: 5001, node_id: 'PRRC_5001', body: 'Rename this?' }, { id: 5002, node_id: 'PRRC_5002', body: 'Extract a helper.' }] };
// Live check, 2026-10-02: REST PATCH on a pending comment answers 404; the GraphQL mutation edits it.
const editMutation = (a, input) => a.includes('graphql') && /updatePullRequestReviewComment/.test(input?.query ?? '');
const reviewGh = (extra = [], reviewBody = 'Overall fine.') => fakeGh([
  noThreads,
  { match: has('api', 'user'), reply: { login: 'me' } },
  { match: has('reviews/901/comments'), reply: [pendingFixture.comments] },
  { match: (a) => a.includes('--paginate') && a.some((x) => x.endsWith('pulls/3/reviews')), reply: [[{ id: 901, node_id: 'PRR_me', state: 'PENDING', user: { login: 'me' }, body: reviewBody }]] },
  { match: editMutation, reply: { data: { updatePullRequestReviewComment: { pullRequestReviewComment: { id: 'PRRC_x' } } } } },
  { match: (a) => a.includes('DELETE') && a.some((x) => x.endsWith('pulls/comments/5002')), reply: {} },
  { match: (a) => a.includes('PUT') && a.some((x) => x.endsWith('reviews/901')), reply: {} },
  ...extra,
]);

test('review mode edits and drops pending comments and does not submit by default', async () => {
  const srv = fakeServer({ proposals: reviewRound2, decisions: reviewDecisions() });
  const { gh, calls } = reviewGh();
  await publish({ gh, api: srv.api, repo: 'octo-org/example', pr: 3, log: () => {} });
  const edit = calls.find((c) => editMutation(c.args, c.input));
  assert.deepEqual(edit.input.variables, { id: 'PRRC_5001', body: 'Rename this to `size`?' });
  assert.ok(!calls.some((c) => c.args.includes('PATCH')), 'no REST PATCH');
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
    noThreads,
    { match: has('api', 'user'), reply: { login: 'me' } },
    { match: (a) => a.includes('--paginate'), reply: [[]] },
  ]);
  await assert.rejects(publish({ gh, api: srv.api, repo: 'octo-org/example', pr: 3, log: () => {} }), /no pending review/);
});

test('--submit in reply mode is refused before any gh call', async () => {
  const srv = fakeServer({ proposals: replyRound2, decisions: replyDecisions });
  const { gh, calls } = fakeGh([]);
  await assert.rejects(publish({ gh, api: srv.api, repo: 'octo-org/example', pr: 3, submit: 'COMMENT', log: () => {} }), /only applies to review mode/);
  assert.equal(calls.length, 0);
  assert.deepEqual(srv.published, {});
});

test('review mode refuses an empty approved text for a comment and for the body', async () => {
  for (const [thread, other] of [['C1', 'BODY'], ['BODY', 'C1']]) {
    const decisions = reviewDecisions();
    const bad = decisions.decisions.find((x) => x.thread_id === thread);
    delete bad.reply_en;
    const srv = fakeServer({ proposals: reviewRound2, decisions });
    const { gh, calls } = reviewGh();
    await assert.rejects(publish({ gh, api: srv.api, repo: 'octo-org/example', pr: 3, log: () => {} }), /approved text is empty/, other);
    assert.ok(!calls.some((c) => c.input && Object.keys(c.input).length === 0), 'no empty payload sent');
    assert.ok(!(thread in srv.published));
  }
});

test('an explicit drop of the review body still clears it', async () => {
  const decisions = reviewDecisions();
  Object.assign(decisions.decisions[0], { decision: 'drop', reply_en: undefined });
  const srv = fakeServer({ proposals: reviewRound2, decisions });
  const { gh, calls } = reviewGh();
  await publish({ gh, api: srv.api, repo: 'octo-org/example', pr: 3, log: () => {} });
  assert.equal(calls.find((c) => c.args.includes('PUT')).input.body, '');
});

// Release run, 2026-10-02: a drop of an empty body sent nothing to GitHub, but the summary said "published 3".
test('a body that already has the approved text counts as kept and sends nothing', async () => {
  for (const [decision, text, reviewBody] of [['drop', undefined, ''], ['post', 'Overall fine.', 'Overall fine.']]) {
    const decisions = reviewDecisions();
    Object.assign(decisions.decisions[0], { decision, reply_en: text });
    const srv = fakeServer({ proposals: reviewRound2, decisions });
    const { gh, calls } = reviewGh([], reviewBody);
    const r = await publish({ gh, api: srv.api, repo: 'octo-org/example', pr: 3, log: () => {} });
    assert.ok(!calls.some((c) => c.args.includes('PUT')), `${decision}: no PUT`);
    assert.deepEqual(r.done, ['C1', 'C2'], decision);
    assert.deepEqual(r.kept, ['BODY'], decision);
    assert.equal(srv.published.BODY.action, 'kept', decision);
  }
});

test('the target comment comes from the proposals, not from the decision', async () => {
  const wrong = { ...replyDecisions, decisions: [{ thread_id: 'T1', comment_id: 999, decision: 'publish', reply_en: 'ok' }] };
  const srv = fakeServer({ proposals: replyRound2, decisions: wrong });
  const { gh, calls } = fakeGh([...noPending, { match: has('comments/11/replies'), reply: { html_url: 'r11' } }]);
  await publish({ gh, api: srv.api, repo: 'octo-org/example', pr: 3, log: () => {} });
  assert.equal(writes(calls).length, 1);
  assert.ok(writes(calls)[0].args.some((a) => a.includes('/comments/11/replies')));

  const rev = reviewDecisions();
  rev.decisions[1].comment_id = 5002;
  rev.decisions[2].comment_id = 5001;
  const srv2 = fakeServer({ proposals: reviewRound2, decisions: rev });
  const g2 = reviewGh();
  await publish({ gh: g2.gh, api: srv2.api, repo: 'octo-org/example', pr: 3, log: () => {} });
  assert.equal(g2.calls.find((c) => editMutation(c.args, c.input)).input.variables.id, 'PRRC_5001');
  assert.ok(g2.calls.find((c) => c.args.includes('DELETE')).args.some((a) => a.endsWith('comments/5002')));
});

// Live check, 2026-10-02: GitHub answers 422 "user_id can only have one pending review per pull request".
test('respond mode posts nothing while I have a pending review on the pull request', async () => {
  const srv = fakeServer({ proposals: replyRound2, decisions: replyDecisions });
  const { gh, calls } = fakeGh([
    noThreads,
    { match: has('api', 'user'), reply: { login: 'me' } },
    { match: has('reviews/901/comments'), reply: [[]] },
    { match: (a) => a.includes('--paginate') && a.some((x) => x.endsWith('pulls/3/reviews')), reply: [[{ id: 901, node_id: 'PRR_me', state: 'PENDING', user: { login: 'me' }, body: '' }]] },
  ]);
  await assert.rejects(publish({ gh, api: srv.api, repo: 'octo-org/example', pr: 3, log: () => {} }), /pending review on octo-org\/example#3.*Nothing was posted/);
  assert.equal(writes(calls).length, 0);
  assert.deepEqual(srv.published, {});
});

// Live check, 2026-10-02: GitHub answers 422 "Could not edit a review with a missing body" for a pending review with no body.
test('a body for a pending review that has none goes with the submit, and is refused without one', async () => {
  const srv = fakeServer({ proposals: reviewRound2, decisions: reviewDecisions() });
  const g1 = reviewGh([], '');
  await assert.rejects(publish({ gh: g1.gh, api: srv.api, repo: 'octo-org/example', pr: 3, log: () => {} }), /Ask the user whether to submit the review now.*Nothing was posted/);
  assert.equal(writes(g1.calls).length, 0);

  const g2 = reviewGh([{ match: has('reviews/901/events'), reply: {} }], '');
  const r = await publish({ gh: g2.gh, api: srv.api, repo: 'octo-org/example', pr: 3, submit: 'COMMENT', log: () => {} });
  assert.ok(!g2.calls.some((c) => c.args.includes('PUT')), 'no PUT');
  assert.deepEqual(g2.calls.find((c) => c.args.some((a) => a.endsWith('/events'))).input, { event: 'COMMENT', body: 'Two notes.' });
  assert.deepEqual(r.done, ['C1', 'C2', 'BODY']);
  assert.equal(srv.published.BODY.action, 'body set');
});

test('an unchanged comment counts as kept, and a comment gone from the review is a warning that is never recorded', async () => {
  const proposals = { ...reviewRound2, items: [...reviewRound2.items, { thread_id: 'C3', comment_id: 5003, reply_en: 'Gone.' }] };
  const decisions = reviewDecisions();
  decisions.decisions[1].reply_en = 'Rename this?';
  decisions.decisions.push({ thread_id: 'C3', comment_id: 5003, decision: 'post', reply_en: 'Gone.' });
  const srv = fakeServer({ proposals, decisions });
  const warnings = [];
  const run = () => publish({ gh: reviewGh().gh, api: srv.api, repo: 'octo-org/example', pr: 3, log: () => {}, warn: (m) => warnings.push(m) });
  const r = await run();
  assert.deepEqual(r.done, ['BODY', 'C2']);
  assert.deepEqual(r.kept, ['C1']);
  assert.deepEqual(r.missing, ['C3']);
  assert.deepEqual(warnings, ['WARNING: C3: approved comment 5003 is not in your pending review; nothing was changed for it']);
  assert.equal(srv.published.C1.action, 'kept');
  assert.ok(!('C3' in srv.published), 'a missing comment is not recorded');
  const again = await run();
  assert.deepEqual(again.skipped, ['BODY', 'C1', 'C2']);
  assert.deepEqual(again.missing, ['C3'], 'a second run looks for it again');
  assert.equal(warnings.length, 2);
});
