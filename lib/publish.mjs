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
  // The user may choose the submit in the panel. A flag from the agent must agree with it.
  const chosen = d.body.submit ?? undefined;
  if (submit !== undefined && chosen !== undefined && submit !== chosen) throw new Error(`--submit ${submit} differs from the submit the user chose in the panel (${chosen}). Nothing was posted.`);
  const event = submit ?? chosen;
  const revise = d.body.decisions.filter((x) => x.decision === 'revise').map((x) => x.thread_id);
  if (revise.length) throw new Error(`round ${FINAL_ROUND} asks the agent for a new version of ${revise.join(', ')}. Rewrite ${revise.length === 1 ? 'it' : 'them'}, then build, push and wait for round ${FINAL_ROUND} again. Nothing was posted.`);
  const change = d.body.decisions.filter((x) => x.decision === 'change');
  const notes = Array.isArray(d.body.code_notes) ? d.body.code_notes : [];
  if (change.length || notes.length) {
    const shas = [...new Set(notes.map((n) => String(n.sha).slice(0, 7)))];
    throw new Error(`round ${FINAL_ROUND} asks the agent to change the code${shas.length ? ` of ${shas.join(', ')}` : ''}. Change it, then build, push and wait for round ${FINAL_ROUND} again. Nothing was posted.`);
  }
  // The user approved replies about the code they saw. GitHub must hold exactly that code before anything is posted.
  if (p.changes) {
    const { headRefOid } = await gh.json(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid']);
    if (headRefOid !== p.changes.head) throw new Error(`GitHub has ${String(headRefOid).slice(0, 7)} but the user approved ${p.changes.head.slice(0, 7)}. If you pushed a moment ago, wait a few seconds and run publish again. Otherwise build and push round ${FINAL_ROUND} again. Nothing was posted.`);
  }
  const already = (await api('GET', `/api/published?${q}&round=${p.round}`)).body.items;
  const record = async (thread_id, action, url, ev) => {
    const r = await api('POST', '/api/published', { repo, pr, round: p.round, thread_id, action, url, ...(ev ? { event: ev } : {}) });
    if (r.status !== 200) throw new Error(`could not record ${thread_id} as ${action}: ${r.body?.error ?? r.status}`);
  };
  // done holds real changes on GitHub; kept holds approved comments that already had the approved text.
  const done = [];
  const kept = [];
  const skipped = [];
  const missing = [];
  const target = (x) => p.items.find((it) => it.thread_id === x.thread_id);
  // A submitted review is no longer pending, and everything in it was done before the submit.
  if (mode === 'review' && already.REVIEW) return { done: [], kept: [], skipped: d.body.decisions.map((x) => x.thread_id), missing: [] };
  const todo = d.body.decisions.filter((x) => !already[x.thread_id]);
  const pending = mode === 'review' ? await fetchPending(gh, { repo, pr }) : null;
  if (mode === 'review' && !pending) throw new Error(`you have no pending review on ${repo}#${pr}; it was submitted or deleted`);
  // GitHub refuses a reply while its author has a pending review on the pull request.
  if (mode === 'reply' && todo.some((x) => x.decision === 'publish' && target(x)?.comment_id) && (await fetchPending(gh, { repo, pr }))) {
    throw new Error(`you have a pending review on ${repo}#${pr}, and GitHub posts no reply while it exists. Submit or delete it on GitHub, then run publish again. Nothing was posted.`);
  }
  // GitHub refuses to set a body on a pending review that has none. The submit can carry it.
  const newBody = mode === 'review' && !pending.body && todo.some((x) => x.decision === 'post' && target(x) && target(x).comment_id == null && String(x.reply_en ?? '').trim());
  if (newBody && !event) throw new Error('GitHub adds a body to a pending review that has none only with the submit, and the user chose to leave the review as a draft. Tell the user, and push round 2 again so they can choose an event in the panel or drop the body. Nothing was posted.');
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
  if (event && !already.REVIEW) {
    await gh.json(['api', '-X', 'POST', `repos/${repo}/pulls/${pr}/reviews/${pending.review_id}/events`], withSubmit ? { event, body: withSubmit.body } : { event });
    await record('REVIEW', 'submitted', null, event);
    log(`review submitted as ${event}`);
    if (withSubmit) {
      await record(withSubmit.thread_id, 'body set', null);
      done.push(withSubmit.thread_id);
      log(`${withSubmit.thread_id}: body set with the submit`);
    }
  }
  return { done, kept, skipped, missing };
}
