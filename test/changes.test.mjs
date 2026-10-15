import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectChanges, resolveCommits } from '../lib/changes.mjs';

// The tests run git with no user or system config, and a fixed author and date, so the shas are stable.
const ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
Object.assign(process.env, ENV);

let dir;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const write = async (p, text) => { await mkdir(join(dir, p, '..'), { recursive: true }); await writeFile(join(dir, p), text); };
let base, c1, c2, c3, merge;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sc-git-'));
  git('init', '-q', '-b', 'main');
  await write('src/F.java', 'a\nb\nc\n');
  await write('src/Old.java', 'x\ny\nz\nw\n');
  await write('blank.txt', 'x\n\ny\n');
  git('add', '.'); git('commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD');
  await write('src/F.java', 'a\nB\nc\n');
  await write('blank.txt', 'x\n\nY\n');
  await write('docs/Mój plik.md', 'hello\n');
  await write('empty.txt', '');
  await write('logo.png', Buffer.from([0, 1, 2, 0, 255]));
  git('add', '.'); git('commit', '-qm', 'first change');
  c1 = git('rev-parse', 'HEAD');
  git('mv', 'src/Old.java', 'src/New.java');
  await write('src/F.java', 'a\nB\nc\nd\n');
  git('add', '.'); git('commit', '-qm', 'rename and grow F');
  c2 = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'side', base);
  await write('side.txt', 'side\n');
  git('add', '.'); git('commit', '-qm', 'side work');
  git('switch', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  merge = git('rev-parse', 'HEAD');
  await write('src/F.java', 'a\nB\nc\nd\ne\n');
  git('add', '.'); git('commit', '-qm', 'third');
  c3 = git('rev-parse', 'HEAD');
});
after(() => rm(dir, { recursive: true, force: true }));

test('commits come oldest first, along the first parent, with subject, author and counts', async () => {
  const c = await collectChanges({ cwd: dir, base, head: c3 });
  assert.deepEqual(c.commits.map((k) => k.subject), ['first change', 'rename and grow F', 'merge side', 'third']);
  assert.deepEqual(c.commits.map((k) => k.sha), [c1, c2, merge, c3]);
  assert.equal(c.commits[0].author, 'Test');
  assert.equal(c.base, base);
  assert.equal(c.head, c3);
});

test('each file has its path, status, counts and patch', async () => {
  const c = await collectChanges({ cwd: dir, base, head: c3 });
  const files = Object.fromEntries(c.commits[0].files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(files).sort(), ['blank.txt', 'docs/Mój plik.md', 'empty.txt', 'logo.png', 'src/F.java']);
  assert.deepEqual({ ...files['src/F.java'], patch: undefined }, { path: 'src/F.java', old_path: null, status: 'M', add: 1, del: 1, binary: false, patch: undefined });
  assert.match(files['src/F.java'].patch, /^@@ -1,3 \+1,3 @@\n a\n-b\n\+B\n c\n$/);
  assert.equal(files['docs/Mój plik.md'].status, 'A');
  assert.equal(files['empty.txt'].add, 0);
  assert.equal(files['empty.txt'].patch, '');
  assert.equal(files['logo.png'].binary, true);
  assert.equal(files['logo.png'].patch, undefined);
});

test('a rename keeps the old path', async () => {
  const c = await collectChanges({ cwd: dir, base, head: c3 });
  const f = c.commits[1].files.find((x) => x.path === 'src/New.java');
  assert.equal(f.old_path, 'src/Old.java');
  assert.match(f.status, /^R/);
});

test('a merge commit shows the merged changes against its first parent', async () => {
  const c = await collectChanges({ cwd: dir, base, head: c3 });
  assert.deepEqual(c.commits[2].files.map((f) => f.path), ['side.txt']);
});

test('the range is the net diff, and names the commits that changed each file', async () => {
  const c = await collectChanges({ cwd: dir, base, head: c3 });
  const f = c.range.files.find((x) => x.path === 'src/F.java');
  assert.deepEqual(f.commits, [c1, c2, c3]);
  assert.equal(f.add, 3);
  assert.equal(f.del, 1);
  assert.equal(c.add, c.range.files.reduce((n, x) => n + x.add, 0));
  assert.equal(c.del, c.range.files.reduce((n, x) => n + x.del, 0));
});

test('base equal to head gives no changes', async () => {
  assert.equal(await collectChanges({ cwd: dir, base: c3, head: c3 }), null);
});

test('refusals say what to do', async () => {
  await assert.rejects(collectChanges({ cwd: dir, base: 'abc', head: c3 }), /40 hex/);
  await assert.rejects(collectChanges({ cwd: dir, base, head: c2 }), /is not this directory's HEAD/);
  git('switch', '-qc', 'other', base);
  try {
    await write('o.txt', 'o\n');
    git('add', '.'); git('commit', '-qm', 'other');
    const other = git('rev-parse', 'HEAD');
    await assert.rejects(collectChanges({ cwd: dir, base: c1, head: other }), /does not contain the pull request's head/);
    await assert.rejects(collectChanges({ cwd: dir, base: 'f'.repeat(40), head: other }), /git fetch/);
  } finally {
    git('switch', '-q', 'main');
  }
});

test('the user git config does not change the output', async () => {
  const cfg = join(dir, '..', `cfg-${process.pid}`);
  await writeFile(cfg, '[color]\n\tui = always\n[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n\trelative = true\n\tsuppressBlankEmpty = true\n[log]\n\tshowSignature = true\n');
  process.env.GIT_CONFIG_GLOBAL = cfg;
  try {
    const c = await collectChanges({ cwd: join(dir, 'src'), base, head: c3 });
    assert.match(c.commits[0].files.find((f) => f.path === 'src/F.java').patch, /^@@ -1,3 \+1,3 @@/);
    assert.equal(c.commits[0].subject, 'first change', 'no signature text in the subject');
    assert.ok(c.commits[0].files.some((f) => f.path === 'blank.txt'), 'diff.relative does not drop files outside the cwd');
    assert.match(c.commits[0].files.find((f) => f.path === 'blank.txt').patch, /\n x\n \n-y\n\+Y\n$/, 'an empty context line keeps its space');
  } finally {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    await rm(cfg, { force: true });
  }
});

test('resolveCommits turns unique prefixes into full shas and refuses the rest', async () => {
  const c = await collectChanges({ cwd: dir, base, head: c3 });
  const out = resolveCommits([{ thread_id: 'T1', commits: [c1.slice(0, 7), c3] }, { thread_id: 'T2' }], c);
  assert.deepEqual(out[0].commits, [c1, c3]);
  assert.equal(out[1].commits, undefined);
  assert.throws(() => resolveCommits([{ thread_id: 'T1', commits: ['abc'] }], c), /T1: commit abc must be at least 7 characters/);
  assert.throws(() => resolveCommits([{ thread_id: 'T1', commits: ['0000000'] }], c), /T1: commit 0000000 is not one of the commits git push will send/);
  const twin = { ...c, commits: [...c.commits, { ...c.commits[0], sha: `${c1.slice(0, 7)}${'0'.repeat(33)}` }] };
  assert.throws(() => resolveCommits([{ thread_id: 'T1', commits: [c1.slice(0, 7)] }], twin), /ambiguous/);
});

test('a file name that contains a tab is read whole', async (t) => {
  const d = await mkdtemp(join(tmpdir(), 'sc-tab-'));
  try {
    const g = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    await writeFile(join(d, 'seed.txt'), 's\n');
    g('add', '.'); g('commit', '-qm', 'seed');
    const b = g('rev-parse', 'HEAD');
    try { await writeFile(join(d, 'a\tb.txt'), 'x\n'); } catch { return t.skip('this filesystem refuses a tab in a file name'); }
    g('add', '.'); g('commit', '-qm', 'tab');
    const c = await collectChanges({ cwd: d, base: b, head: g('rev-parse', 'HEAD') });
    assert.deepEqual(c.range.files.map((f) => f.path), ['a\tb.txt']);
    assert.deepEqual(c.commits[0].files.map((f) => f.path), ['a\tb.txt']);
  } finally { await rm(d, { recursive: true, force: true }); }
});
