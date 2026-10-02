import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draft, shapeThreads, fetchThreads, fetchPending, resolvePr, parseGhVersion, versionAtLeast, GH_FLOOR, ghError } from '../lib/github.mjs';
import { fakeGh, has } from './fake-gh.mjs';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));

test('shapeThreads keeps unresolved threads with their whole conversation', () => {
  const t = shapeThreads([fx('threads-page1.json'), fx('threads-page2.json')]);
  assert.deepEqual(t.map((x) => x.thread_id), ['PRRT_b', 'PRRT_c']);
  assert.deepEqual(t[0], {
    thread_id: 'PRRT_b', comment_id: 21, path: 'src/b.js', line: 40, outdated: true,
    url: 'https://github.com/octo-org/example/pull/3#discussion_r21',
    comments: [
      { id: 21, author: 'ana-ng', created_at: '2026-09-01T10:00:00Z', body: 'Why `null`?' },
      { id: 22, author: 'ghost', created_at: '2026-09-01T11:00:00Z', body: 'ghost reply' },
    ],
  });
});

test('fetchThreads follows pages and fails on a thread it cannot read whole', async () => {
  const { gh, calls } = fakeGh([
    { match: (a) => !a.includes('after=C1'), reply: fx('threads-page1.json') },
    { match: has('after=C1'), reply: fx('threads-page2.json') },
  ]);
  assert.equal((await fetchThreads(gh, { repo: 'octo-org/example', pr: 3 })).length, 2);
  assert.equal(calls.length, 2);
  for (const k of ['owner', 'name']) assert.ok(calls[0].args[calls[0].args.indexOf(`${k}=${k === 'owner' ? 'octo-org' : 'example'}`) - 1] === '-f', `${k} uses -f`);
  const long = fx('threads-page2.json');
  long.data.repository.pullRequest.reviewThreads.nodes[0].comments.pageInfo.hasNextPage = true;
  const f2 = fakeGh([{ match: () => true, reply: long }]);
  await assert.rejects(fetchThreads(f2.gh, { repo: 'octo-org/example', pr: 3 }), /more than 100 comments/);
});

// The review threads query that fetchPending uses for anchors. The mutation in draft is sent through --input.
const threadsQuery = (reply) => ({ match: (a) => a.includes('graphql') && a.some((x) => x.startsWith('query=')), reply });
const noThreads = threadsQuery({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } });

test('fetchPending finds only my pending review, with comment anchors', async () => {
  const { gh } = fakeGh([
    noThreads,
    { match: has('user'), reply: { login: 'me' } },
    { match: has('pulls/3/reviews/901/comments'), reply: fx('review-comments.json') },
    { match: has('pulls/3/reviews'), reply: fx('reviews.json') },
  ]);
  const p = await fetchPending(gh, { repo: 'octo-org/example', pr: 3 });
  assert.equal(p.review_id, 901);
  assert.equal(p.node_id, 'PRR_me');
  assert.equal(p.commit_id, 'abc');
  assert.equal(p.body, 'Overall fine.');
  assert.deepEqual(p.comments[0], { id: 5001, node_id: 'PRRC_1', path: 'src/a.js', line: 12, start_line: null, side: 'RIGHT', start_side: null, position: 4, in_reply_to: null, body: 'Rename this?' });
  const none = fakeGh([{ match: has('user'), reply: { login: 'nobody' } }, { match: has('pulls/3/reviews'), reply: fx('reviews.json') }]);
  assert.equal(await fetchPending(none.gh, { repo: 'octo-org/example', pr: 3 }), null);
});

test('resolvePr reads repo, number and head from gh pr view', async () => {
  const { gh } = fakeGh([{ match: has('pr', 'view'), reply: { number: 3, url: 'https://github.com/octo-org/example/pull/3', headRefOid: 'abc' } }]);
  assert.deepEqual(await resolvePr(gh, '3'), { repo: 'octo-org/example', pr: 3, head: 'abc' });
});

test('gh version floor', () => {
  assert.equal(parseGhVersion('gh version 2.95.0 (2026-06-17)\nhttps://github.com/cli/cli/releases/tag/v2.95.0'), '2.95.0');
  assert.equal(parseGhVersion('nonsense'), null);
  assert.equal(versionAtLeast('2.95.0', GH_FLOOR), true);
  assert.equal(versionAtLeast('2.48.0', GH_FLOOR), true);
  assert.equal(versionAtLeast('2.47.9', GH_FLOOR), false);
  assert.equal(versionAtLeast('1.99.0', GH_FLOOR), false);
  assert.equal(versionAtLeast('3.0.0', GH_FLOOR), true);
});

const pendingScript = (extra, threads = noThreads) => [
  threads,
  { match: has('api', 'user'), reply: { login: 'me' } },
  { match: has('pulls/3/reviews/901/comments'), reply: fx('review-comments.json') },
  { match: (a) => a.includes('--paginate') && a.some((x) => x.endsWith('pulls/3/reviews')), reply: fx('reviews.json') },
  ...extra,
];
const newComment = { path: 'src/c.js', line: 8, body: 'New finding.' };
// What gh gives for a GraphQL `errors` answer: ghError tags it, and only such a refusal may start a rebuild.
const gqlError = (msg) => Object.assign(new Error(`gh api graphql failed: ${msg}`), { graphql: true });

test('draft creates a pending review when I have none, with no event field', async () => {
  const { gh, calls } = fakeGh([
    noThreads,
    { match: has('api', 'user'), reply: { login: 'nobody' } },
    { match: (a) => a.includes('--paginate'), reply: fx('reviews.json') },
    { match: (a, input) => input && a.includes('POST') && a.some((x) => x.endsWith('pulls/3/reviews')), reply: { id: 1000 } },
  ]);
  const r = await draft(gh, { repo: 'octo-org/example', pr: 3, head: 'abc', comments: [newComment], backupDir: tmpdir() });
  assert.deepEqual(r, { review_id: 1000, created: true, recreated: false });
  const post = calls.at(-1).input;
  assert.equal('event' in post, false);
  assert.equal(post.commit_id, 'abc');
  assert.deepEqual(post.comments, [{ path: 'src/c.js', line: 8, side: 'RIGHT', body: 'New finding.' }]);
});

test('draft appends to my existing pending review through GraphQL', async () => {
  const { gh, calls } = fakeGh(pendingScript([
    { match: has('graphql'), reply: { data: { addPullRequestReviewThread: { thread: { id: 'PRRT_new' } } } } },
  ]));
  const r = await draft(gh, { repo: 'octo-org/example', pr: 3, head: 'abc', comments: [newComment], backupDir: tmpdir() });
  assert.deepEqual(r, { review_id: 901, created: false, recreated: false });
  const mutation = calls.find((c) => c.args.includes('graphql') && c.input);
  assert.equal(mutation.input.variables.input.pullRequestReviewId, 'PRR_me');
  assert.equal(mutation.input.variables.input.body, 'New finding.');
  assert.ok(!calls.some((c) => c.args.includes('DELETE')), 'nothing is deleted');
  assert.ok(!calls.some((c) => c.args.includes('PUT')), 'no body given, no body update');
});

test('draft sets the review body on an existing review when one is given', async () => {
  const { gh, calls } = fakeGh(pendingScript([
    { match: has('graphql'), reply: { data: { addPullRequestReviewThread: { thread: { id: 'PRRT_new' } } } } },
    { match: (a) => a.includes('PUT') && a.some((x) => x.endsWith('reviews/901')), reply: {} },
  ]));
  await draft(gh, { repo: 'octo-org/example', pr: 3, head: 'abc', comments: [newComment], body: 'New summary.', backupDir: tmpdir() });
  const put = calls.find((c) => c.args.includes('PUT'));
  assert.deepEqual(put.input, { body: 'New summary.' });
});

test('when GraphQL refuses, draft saves my comments, then recreates the review with mine and the new ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-draft-'));
  const { gh, calls } = fakeGh(pendingScript([
    { match: has('graphql'), reply: () => { throw gqlError('not supported'); } },
    { match: (a) => a.includes('DELETE') && a.some((x) => x.endsWith('reviews/901')), reply: () => { assert.equal(readdirSync(dir).length, 1, 'backup exists before the delete'); return {}; } },
    { match: (a, input) => input && a.includes('POST'), reply: { id: 1001 } },
  ]));
  const r = await draft(gh, { repo: 'octo-org/example', pr: 3, head: 'abc', comments: [newComment], backupDir: dir });
  assert.equal(r.recreated, true);
  assert.equal(r.review_id, 1001);
  const saved = JSON.parse(readFileSync(r.backup, 'utf8'));
  assert.equal(saved.comments.length, 2);
  const order = calls.map((c) => (c.args.includes('DELETE') ? 'delete' : c.input?.comments ? 'create' : null)).filter(Boolean);
  assert.deepEqual(order, ['delete', 'create']);
  const created = calls.at(-1).input;
  assert.equal(created.body, 'Overall fine.');
  assert.deepEqual(created.comments.map((c) => c.body), ['Rename this?', 'Extract a helper.', 'New finding.']);
  assert.deepEqual(created.comments[1], { path: 'src/b.js', line: 7, start_line: 5, side: 'RIGHT', body: 'Extract a helper.' });
});

test('the fallback refuses and deletes nothing when one of my comments has no anchor', async () => {
  const bad = fx('review-comments.json');
  bad[0][0].line = null; bad[0][0].original_line = null; bad[0][0].position = null;
  const { gh, calls } = fakeGh([
    noThreads,
    { match: has('api', 'user'), reply: { login: 'me' } },
    { match: has('reviews/901/comments'), reply: bad },
    { match: (a) => a.includes('--paginate'), reply: fx('reviews.json') },
    { match: has('graphql'), reply: () => { throw gqlError('nope'); } },
  ]);
  await assert.rejects(draft(gh, { repo: 'octo-org/example', pr: 3, head: 'abc', comments: [newComment], backupDir: tmpdir() }), /comment 5001 has no line/);
  assert.ok(!calls.some((c) => c.args.includes('DELETE')));
});

const refuseGraphql = { match: has('graphql'), reply: () => { throw gqlError('not supported'); } };

test('when the recreate fails, draft restores my own comments and names the backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-draft-'));
  let posts = 0;
  const { gh, calls } = fakeGh(pendingScript([
    refuseGraphql,
    { match: (a) => a.includes('DELETE'), reply: {} },
    { match: (a, input) => input && a.includes('POST'), reply: () => { if (posts++ === 0) throw new Error('422 line not in diff'); return { id: 1002 }; } },
  ]));
  await assert.rejects(draft(gh, { repo: 'octo-org/example', pr: 3, head: 'abc', comments: [newComment], backupDir: dir }), (e) => {
    assert.match(e.message, /recreated with your own comments, but the new ones were not added \(422 line not in diff\)/);
    assert.ok(e.message.includes(dir));
    return true;
  });
  const restore = calls.at(-1).input;
  assert.deepEqual(restore.comments.map((c) => c.body), ['Rename this?', 'Extract a helper.']);
  assert.equal(restore.body, 'Overall fine.');
});

test('when the restore fails too, the error says the review is gone and where the backup is', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-draft-'));
  const { gh } = fakeGh(pendingScript([
    refuseGraphql,
    { match: (a) => a.includes('DELETE'), reply: {} },
    { match: (a, input) => input && a.includes('POST'), reply: () => { throw new Error('boom'); } },
  ]));
  await assert.rejects(draft(gh, { repo: 'octo-org/example', pr: 3, head: 'abc', comments: [newComment], backupDir: dir }), (e) => /was deleted and could not be recreated/.test(e.message) && e.message.includes(dir));
});

test('draft refuses a bad new comment before any gh call', async () => {
  const { gh, calls } = fakeGh([]);
  for (const bad of [{ path: 'a.js', body: 'x' }, { path: '', line: 1, body: 'x' }, { path: 'a.js', line: 3, start_line: 3, body: 'x' }, { path: 'a.js', line: 3, side: 'UP', body: 'x' }, { path: 'a.js', line: 3, body: ' ' }]) {
    await assert.rejects(draft(gh, { repo: 'octo-org/example', pr: 3, head: 'abc', comments: [bad], backupDir: tmpdir() }), /Nothing was changed/);
  }
  assert.equal(calls.length, 0);
});

test('when a guard stops the fallback after some new comments were appended, it says which, not that nothing changed', async () => {
  let n = 0;
  const { gh, calls } = fakeGh(pendingScript([
    { match: has('graphql'), reply: () => { if (n++ === 0) return { data: { addPullRequestReviewThread: { thread: { id: 'PRRT_ok' } } } }; throw gqlError('not supported'); } },
  ]));
  const three = [newComment, { path: 'src/c.js', line: 9, body: 'Second.' }, { path: 'src/c.js', line: 10, body: 'Third.' }];
  await assert.rejects(draft(gh, { repo: 'octo-org/example', pr: 3, head: 'def', comments: three, backupDir: tmpdir() }), (e) => {
    assert.match(e.message, /made on commit/);
    assert.match(e.message, /1 of the new comments was already added to pending review 901; leave it out when you run draft again/);
    assert.doesNotMatch(e.message, /Nothing was changed/);
    return true;
  });
  assert.ok(!calls.some((c) => c.args.includes('DELETE')));
});

test('the fallback refuses and deletes nothing when my review is on another commit', async () => {
  const { gh, calls } = fakeGh(pendingScript([refuseGraphql]));
  await assert.rejects(draft(gh, { repo: 'octo-org/example', pr: 3, head: 'def', comments: [newComment], backupDir: tmpdir() }), /moved|move your comments/);
  assert.ok(!calls.some((c) => c.args.includes('DELETE')));
});

// Live check, 2026-10-02: the pending review's own comments endpoint returns no line, start_line or side.
test('fetchPending takes line, range and side from the review threads, and marks my draft replies', async () => {
  const rest = [[...fx('review-comments.json')[0], { id: 5003, node_id: 'PRRC_3', path: 'src/s.js', position: 2, body: 'My draft reply.' }]];
  const { gh } = fakeGh([
    threadsQuery(fx('threads-pending.json')),
    { match: has('api', 'user'), reply: { login: 'me' } },
    { match: has('pulls/3/reviews/901/comments'), reply: rest.map((page) => page.map((c) => ({ ...c, line: undefined, original_line: undefined, start_line: undefined, side: undefined }))) },
    { match: has('pulls/3/reviews'), reply: fx('reviews.json') },
  ]);
  const p = await fetchPending(gh, { repo: 'octo-org/example', pr: 3 });
  const by = Object.fromEntries(p.comments.map((c) => [c.id, c]));
  assert.deepEqual([by[5001].line, by[5001].start_line, by[5001].side, by[5001].start_side, by[5001].in_reply_to], [12, null, 'RIGHT', null, null]);
  assert.deepEqual([by[5002].line, by[5002].start_line, by[5002].side, by[5002].start_side, by[5002].in_reply_to], [7, 5, 'LEFT', 'LEFT', null]);
  assert.equal(by[5003].in_reply_to, 41);
});

test('threads leaves out my pending comments and threads that only hold them', () => {
  const t = shapeThreads([fx('threads-pending.json')]);
  assert.deepEqual(t.map((x) => x.thread_id), ['PRRT_s']);
  assert.deepEqual(t[0].comments.map((c) => c.id), [41]);
});

test('the fallback recreates a range comment with its range and side, not its position', async () => {
  const { gh, calls } = fakeGh(pendingScript([
    refuseGraphql,
    { match: (a) => a.includes('DELETE'), reply: {} },
    { match: (a, input) => input && a.includes('POST'), reply: { id: 1003 } },
  ], threadsQuery(fx('threads-pending.json'))));
  await draft(gh, { repo: 'octo-org/example', pr: 3, head: 'abc', comments: [newComment], backupDir: mkdtempSync(join(tmpdir(), 'sc-draft-')) });
  const created = calls.at(-1).input.comments;
  assert.deepEqual(created[1], { path: 'src/b.js', line: 7, start_line: 5, start_side: 'LEFT', side: 'LEFT', body: 'Extract a helper.' });
});

test('the fallback refuses and deletes nothing when my pending review holds a reply', async () => {
  const rest = [[...fx('review-comments.json')[0], { id: 5003, node_id: 'PRRC_3', path: 'src/s.js', position: 2, body: 'My draft reply.' }]];
  const { gh, calls } = fakeGh([
    threadsQuery(fx('threads-pending.json')),
    { match: has('api', 'user'), reply: { login: 'me' } },
    { match: has('reviews/901/comments'), reply: rest },
    { match: (a) => a.includes('--paginate'), reply: fx('reviews.json') },
    refuseGraphql,
  ]);
  await assert.rejects(draft(gh, { repo: 'octo-org/example', pr: 3, head: 'abc', comments: [newComment], backupDir: tmpdir() }), /comment 5003 is a reply/);
  assert.ok(!calls.some((c) => c.args.includes('DELETE')));
});

// Live check, 2026-10-02: for a line outside the diff GitHub answers {"thread": null}, with no errors and exit code 0.
test('draft stops when GitHub adds no thread, says which comment and what was added, and deletes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-draft-'));
  let n = 0;
  const { gh, calls } = fakeGh(pendingScript([
    { match: has('graphql'), reply: () => ({ data: { addPullRequestReviewThread: { thread: n++ === 0 ? { id: 'PRRT_ok' } : null } } }) },
  ]));
  const two = [newComment, { path: 'src/c.js', line: 999, body: 'Outside the diff.' }];
  await assert.rejects(draft(gh, { repo: 'octo-org/example', pr: 3, head: 'abc', comments: two, body: 'New summary.', backupDir: dir }), (e) => {
    assert.match(e.message, /comment 2 \(src\/c\.js:999\)/);
    assert.match(e.message, /1 of the new comments was already added to pending review 901; leave it out when you run draft again/);
    assert.match(e.message, /The body was not set/);
    return true;
  });
  assert.ok(!calls.some((c) => c.args.includes('DELETE') || c.args.includes('PUT')));
  assert.equal(readdirSync(dir).length, 0, 'no backup');
});

// Live check, 2026-10-02: GitHub answers 422 "Could not edit a review with a missing body" when a pending review has no body yet.
test('draft recreates a pending review that has no body when a body is given, without appending first', async () => {
  const reviews = fx('reviews.json');
  reviews[0][1].body = '';
  const dir = mkdtempSync(join(tmpdir(), 'sc-draft-'));
  const { gh, calls } = fakeGh([
    noThreads,
    { match: has('api', 'user'), reply: { login: 'me' } },
    { match: has('pulls/3/reviews/901/comments'), reply: fx('review-comments.json') },
    { match: (a) => a.includes('--paginate') && a.some((x) => x.endsWith('pulls/3/reviews')), reply: reviews },
    { match: (a) => a.includes('DELETE'), reply: {} },
    { match: (a, input) => input && a.includes('POST'), reply: { id: 1004 } },
  ]);
  const r = await draft(gh, { repo: 'octo-org/example', pr: 3, head: 'abc', comments: [newComment], body: 'New summary.', backupDir: dir });
  assert.equal(r.recreated, true);
  assert.ok(!calls.some((c) => c.args.includes('graphql') && c.input), 'no append');
  assert.equal(calls.at(-1).input.body, 'New summary.');
  assert.equal(calls.at(-1).input.comments.length, 3);
});

test('a gh failure carries the reason GitHub gave, not only the HTTP status', () => {
  const stdout = '{"message":"Validation Failed","errors":[{"resource":"PullRequestReview","code":"custom","field":"user_id","message":"user_id can only have one pending review per pull request"}],"status":"422"}';
  const e = ghError(['api', '-X', 'POST', 'repos/o/n/pulls/1/comments/5/replies'], new Error('exit 1'), stdout, 'gh: Validation Failed (HTTP 422)\n');
  assert.match(e.message, /Validation Failed \(HTTP 422\)/);
  assert.match(e.message, /one pending review per pull request/);
  const e2 = ghError(['api', '-X', 'PUT', 'x'], new Error('exit 1'), '{"message":"Unprocessable Entity","errors":["Could not edit a review with a missing body."]}', 'gh: Unprocessable Entity (HTTP 422)');
  assert.match(e2.message, /Could not edit a review with a missing body/);
  assert.equal(ghError(['pr', 'view'], new Error('exit 1'), 'not json', 'no pull requests found').message, 'gh pr view failed: no pull requests found');
});

test('only a GraphQL errors answer is tagged as a GraphQL refusal', () => {
  const gql = ghError(['api', 'graphql', '--input', '-'], new Error('exit 1'), '{"data":null,"errors":[{"type":"FORBIDDEN","message":"not allowed"}]}', 'gh: not allowed\n');
  assert.equal(gql.graphql, true);
  assert.equal(ghError(['api', 'graphql', '--input', '-'], new Error('exit 1'), '', 'error connecting to api.github.com').graphql, undefined, 'a network error');
  assert.equal(ghError(['api', 'graphql', '--input', '-'], new Error('exit 1'), '{"message":"Bad credentials"}', 'gh: Bad credentials (HTTP 401)').graphql, undefined, 'an auth error');
  assert.equal(ghError(['api', '-X', 'PUT', 'x'], new Error('exit 1'), '{"message":"Validation Failed","errors":["nope"]}', 'gh: (HTTP 422)').graphql, undefined, 'a REST error');
});

test('a network or auth failure while appending stops draft without deleting anything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-draft-'));
  for (const fail of [new Error('gh api graphql failed: error connecting to api.github.com'), new Error('gh api graphql failed: gh: Bad credentials (HTTP 401)')]) {
    const { gh, calls } = fakeGh(pendingScript([{ match: has('graphql'), reply: () => { throw fail; } }]));
    await assert.rejects(draft(gh, { repo: 'octo-org/example', pr: 3, head: 'abc', comments: [newComment], backupDir: dir }), (e) => {
      assert.ok(e.message.includes(fail.message));
      assert.match(e.message, /Nothing was changed/);
      return true;
    });
    assert.ok(!calls.some((c) => c.args.includes('DELETE')), 'nothing is deleted');
  }
  assert.equal(readdirSync(dir).length, 0, 'no backup');
});

test('a failed body update after the appends says what was added and deletes nothing', async () => {
  const { gh, calls } = fakeGh(pendingScript([
    { match: has('graphql'), reply: { data: { addPullRequestReviewThread: { thread: { id: 'PRRT_new' } } } } },
    { match: (a) => a.includes('PUT'), reply: () => { throw new Error('gh api -X PUT failed: gh: Validation Failed (HTTP 422)'); } },
  ]));
  await assert.rejects(draft(gh, { repo: 'octo-org/example', pr: 3, head: 'abc', comments: [newComment], body: 'New summary.', backupDir: tmpdir() }), (e) => {
    assert.match(e.message, /HTTP 422/);
    assert.match(e.message, /1 of the new comments was already added to pending review 901.*The body was not set/);
    return true;
  });
  assert.ok(!calls.some((c) => c.args.includes('DELETE')));
});

test('the fallback refuses and deletes nothing when GitHub does not say which commit my review is on', async () => {
  const reviews = fx('reviews.json');
  reviews[0][1].commit_id = null;
  const { gh, calls } = fakeGh([
    noThreads,
    { match: has('api', 'user'), reply: { login: 'me' } },
    { match: has('pulls/3/reviews/901/comments'), reply: fx('review-comments.json') },
    { match: (a) => a.includes('--paginate') && a.some((x) => x.endsWith('pulls/3/reviews')), reply: reviews },
    refuseGraphql,
  ]);
  await assert.rejects(draft(gh, { repo: 'octo-org/example', pr: 3, head: 'abc', comments: [newComment], backupDir: tmpdir() }), /which commit/);
  assert.ok(!calls.some((c) => c.args.includes('DELETE')));
});
