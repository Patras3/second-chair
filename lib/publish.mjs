// Carries out the final round's decisions on GitHub, with the exact approved text. Every action is
// recorded on the server right after it succeeds, so a second run skips what is done.
// The text always comes from the user's decisions, never from the proposals.
import { FINAL_ROUND } from './protocol.mjs';
import { fetchPending } from './github.mjs';

const EVENTS = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];

export async function publish({ gh, api, repo, pr, submit, log = console.log }) {
  if (submit !== undefined && !EVENTS.includes(submit)) throw new Error(`--submit takes COMMENT, APPROVE or REQUEST_CHANGES, not ${submit}`);
  const q = `repo=${encodeURIComponent(repo)}&pr=${pr}`;
  const p = (await api('GET', `/api/proposals?${q}`)).body;
  if (!p || p.round !== FINAL_ROUND) throw new Error(`publish needs round ${FINAL_ROUND} proposals with decisions; the latest round is ${p?.round ?? 'none'}`);
  const d = await api('GET', `/api/decisions?${q}&round=${p.round}`);
  if (d.status !== 200) throw new Error(`round ${FINAL_ROUND} has no decisions yet; wait for the user to send them`);
  const already = (await api('GET', `/api/published?${q}&round=${p.round}`)).body.items;
  const record = async (thread_id, action, url) => {
    const r = await api('POST', '/api/published', { repo, pr, round: p.round, thread_id, action, url });
    if (r.status !== 200) throw new Error(`could not record ${thread_id} as ${action}: ${r.body?.error ?? r.status}`);
  };
  const done = [];
  const skipped = [];
  const mode = p.mode ?? 'reply';
  const pending = mode === 'review' ? await fetchPending(gh, { repo, pr }) : null;
  if (mode === 'review' && !pending) throw new Error(`you have no pending review on ${repo}#${pr}; it was submitted or deleted`);

  for (const x of d.body.decisions) {
    if (already[x.thread_id]) {
      skipped.push(x.thread_id);
      continue;
    }
    let action = null;
    let url = null;
    if (mode === 'reply') {
      // Only an explicit `publish` posts. hold, manual and anything else do nothing.
      if (x.decision === 'publish') {
        if (typeof x.reply_en !== 'string' || x.reply_en.trim() === '') throw new Error(`${x.thread_id}: the approved text is empty`);
        const r = x.comment_id
          ? await gh.json(['api', '-X', 'POST', `repos/${repo}/pulls/${pr}/comments/${x.comment_id}/replies`], { body: x.reply_en })
          : await gh.json(['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`], { body: x.reply_en });
        action = 'replied';
        url = r?.html_url ?? null;
      }
    } else if (x.comment_id) {
      const current = pending.comments.find((c) => c.id === x.comment_id);
      if (x.decision === 'drop' && current) {
        await gh.json(['api', '-X', 'DELETE', `repos/${repo}/pulls/comments/${x.comment_id}`]);
        action = 'dropped';
      } else if (x.decision === 'post' && current && current.body !== x.reply_en) {
        await gh.json(['api', '-X', 'PATCH', `repos/${repo}/pulls/comments/${x.comment_id}`], { body: x.reply_en });
        action = 'updated';
      } else if (x.decision === 'post') {
        action = current ? 'kept' : 'missing';
      }
    } else if (x.decision === 'post' || x.decision === 'drop') {
      const body = x.decision === 'post' ? x.reply_en : '';
      if (body !== pending.body) await gh.json(['api', '-X', 'PUT', `repos/${repo}/pulls/${pr}/reviews/${pending.review_id}`], { body });
      action = x.decision === 'post' ? 'body set' : 'body cleared';
    }
    if (action) {
      await record(x.thread_id, action, url);
      done.push(x.thread_id);
      log(`${x.thread_id}: ${action}${url ? ` ${url}` : ''}`);
    }
  }
  if (submit) {
    await gh.json(['api', '-X', 'POST', `repos/${repo}/pulls/${pr}/reviews/${pending.review_id}/events`], { event: submit });
    log(`review submitted as ${submit}`);
  }
  return { done, skipped };
}
