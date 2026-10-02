// Carries out the final round's decisions on GitHub, with the exact approved text. Every action is
// recorded on the server right after it succeeds, so a second run skips what is done.
// The text always comes from the user's decisions, never from the proposals.
import { FINAL_ROUND } from './protocol.mjs';
import { fetchPending } from './github.mjs';

const EVENTS = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];
// REST PATCH answers 404 for a comment in a pending review; this mutation edits it.
const EDIT_COMMENT = `mutation($id:ID!,$body:String!){updatePullRequestReviewComment(input:{pullRequestReviewCommentId:$id,body:$body}){pullRequestReviewComment{id}}}`;

export async function publish({ gh, api, repo, pr, submit, log = console.log, warn = console.error }) {
  if (submit !== undefined && !EVENTS.includes(submit)) throw new Error(`--submit takes COMMENT, APPROVE or REQUEST_CHANGES, not ${submit}`);
  const q = `repo=${encodeURIComponent(repo)}&pr=${pr}`;
  const p = (await api('GET', `/api/proposals?${q}`)).body;
  if (!p || p.round !== FINAL_ROUND) throw new Error(`publish needs round ${FINAL_ROUND} proposals with decisions; the latest round is ${p?.round ?? 'none'}`);
  const mode = p.mode ?? 'reply';
  if (submit && mode !== 'review') throw new Error('--submit only applies to review mode');
  const d = await api('GET', `/api/decisions?${q}&round=${p.round}`);
  if (d.status !== 200) throw new Error(`round ${FINAL_ROUND} has no decisions yet; wait for the user to send them`);
  const already = (await api('GET', `/api/published?${q}&round=${p.round}`)).body.items;
  const record = async (thread_id, action, url) => {
    const r = await api('POST', '/api/published', { repo, pr, round: p.round, thread_id, action, url });
    if (r.status !== 200) throw new Error(`could not record ${thread_id} as ${action}: ${r.body?.error ?? r.status}`);
  };
  // done holds real changes on GitHub; kept holds approved comments that already had the approved text.
  const done = [];
  const kept = [];
  const skipped = [];
  const missing = [];
  const target = (x) => p.items.find((it) => it.thread_id === x.thread_id);
  const todo = d.body.decisions.filter((x) => !already[x.thread_id]);
  const pending = mode === 'review' ? await fetchPending(gh, { repo, pr }) : null;
  if (mode === 'review' && !pending) throw new Error(`you have no pending review on ${repo}#${pr}; it was submitted or deleted`);
  // GitHub refuses a reply while its author has a pending review on the pull request.
  if (mode === 'reply' && todo.some((x) => x.decision === 'publish' && target(x)?.comment_id) && (await fetchPending(gh, { repo, pr }))) {
    throw new Error(`you have a pending review on ${repo}#${pr}, and GitHub posts no reply while it exists. Submit or delete it on GitHub, then run publish again. Nothing was posted.`);
  }
  // GitHub refuses to set a body on a pending review that has none. The submit can carry it.
  const newBody = mode === 'review' && !pending.body && todo.some((x) => x.decision === 'post' && target(x) && target(x).comment_id == null && String(x.reply_en ?? '').trim());
  if (newBody && !submit) throw new Error('GitHub cannot add a body to a pending review that has none. Ask the user whether to submit the review now, and with which event (COMMENT, APPROVE or REQUEST_CHANGES), or to drop the body. Nothing was posted.');
  let withSubmit = null;

  const approved = (x) => {
    if (typeof x.reply_en !== 'string' || x.reply_en.trim() === '') throw new Error(`${x.thread_id}: the approved text is empty`);
  };
  for (const decision of d.body.decisions) {
    // The target comment comes from the proposals, never from the decision.
    const item = p.items.find((it) => it.thread_id === decision.thread_id);
    if (!item) throw new Error(`${decision.thread_id}: not in the round ${p.round} proposals`);
    const x = { ...decision, comment_id: item.comment_id ?? null };
    if (already[x.thread_id]) {
      skipped.push(x.thread_id);
      continue;
    }
    let action = null;
    let url = null;
    if (mode === 'reply') {
      // Only an explicit `publish` posts. hold, manual and anything else do nothing.
      if (x.decision === 'publish') {
        approved(x);
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
      } else if (x.decision === 'post') {
        approved(x);
        if (current && current.body !== x.reply_en) {
          const r = await gh.json(['api', 'graphql'], { query: EDIT_COMMENT, variables: { id: current.node_id, body: x.reply_en } });
          if (!r?.data?.updatePullRequestReviewComment?.pullRequestReviewComment) throw new Error(`${x.thread_id}: GitHub did not update comment ${x.comment_id}`);
          action = 'updated';
        } else if (current) {
          action = 'kept';
        } else {
          // Not recorded, so the next run looks for it again.
          missing.push(x.thread_id);
          warn(`WARNING: ${x.thread_id}: approved comment ${x.comment_id} is not in your pending review; nothing was changed for it`);
        }
      }
    } else if (x.decision === 'post' || x.decision === 'drop') {
      if (x.decision === 'post') approved(x);
      const body = x.decision === 'post' ? x.reply_en : '';
      if (body && !pending.body) {
        withSubmit = { thread_id: x.thread_id, body };
        continue;
      }
      // A body that already has the approved text, such as an empty body that is dropped, is kept.
      if (body === pending.body) {
        action = 'kept';
      } else {
        await gh.json(['api', '-X', 'PUT', `repos/${repo}/pulls/${pr}/reviews/${pending.review_id}`], { body });
        action = x.decision === 'post' ? 'body set' : 'body cleared';
      }
    }
    if (action) {
      await record(x.thread_id, action, url);
      (action === 'kept' ? kept : done).push(x.thread_id);
      log(`${x.thread_id}: ${action}${url ? ` ${url}` : ''}`);
    }
  }
  if (submit) {
    await gh.json(['api', '-X', 'POST', `repos/${repo}/pulls/${pr}/reviews/${pending.review_id}/events`], withSubmit ? { event: submit, body: withSubmit.body } : { event: submit });
    log(`review submitted as ${submit}`);
    if (withSubmit) {
      await record(withSubmit.thread_id, 'body set', null);
      done.push(withSubmit.thread_id);
      log(`${withSubmit.thread_id}: body set with the submit`);
    }
  }
  return { done, kept, skipped, missing };
}
