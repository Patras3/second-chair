import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shapeThreads, fetchThreads, fetchPending, resolvePr, parseGhVersion, versionAtLeast, GH_FLOOR } from '../lib/github.mjs';
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
  const long = fx('threads-page2.json');
  long.data.repository.pullRequest.reviewThreads.nodes[0].comments.pageInfo.hasNextPage = true;
  const f2 = fakeGh([{ match: () => true, reply: long }]);
  await assert.rejects(fetchThreads(f2.gh, { repo: 'octo-org/example', pr: 3 }), /more than 100 comments/);
});

test('fetchPending finds only my pending review, with comment anchors', async () => {
  const { gh } = fakeGh([
    { match: has('user'), reply: { login: 'me' } },
    { match: has('pulls/3/reviews/901/comments'), reply: fx('review-comments.json') },
    { match: has('pulls/3/reviews'), reply: fx('reviews.json') },
  ]);
  const p = await fetchPending(gh, { repo: 'octo-org/example', pr: 3 });
  assert.equal(p.review_id, 901);
  assert.equal(p.node_id, 'PRR_me');
  assert.equal(p.body, 'Overall fine.');
  assert.deepEqual(p.comments[0], { id: 5001, node_id: 'PRRC_1', path: 'src/a.js', line: 12, start_line: null, side: 'RIGHT', position: 4, body: 'Rename this?' });
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
