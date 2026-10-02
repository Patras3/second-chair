---
name: respond
description: Use when the user wants to answer the review threads on their own GitHub pull request through Second Chair, so they decide every reply in the browser before anything is posted. Triggered by "respond to the review", "answer the threads", a PR number or URL with that intent.
argument-hint: "[PR number or URL]"
---

# Answer review threads through Second Chair

Second Chair shows your proposal for every thread next to it on GitHub. The user decides each one in the browser. You carry out the decisions. Nothing reaches GitHub until the user approved it, and it goes out through `second-chair publish` with the exact approved text.

This skill covers the mechanics only. How you investigate a thread and what you answer is your own judgment and the user's instructions.

## Rules

- Never post, reply, resolve or edit anything on GitHub yourself. `second-chair publish` posts.
- Never touch comments by other people.
- Never push commits before round 2 is decided.
- Never delete or submit the user's pending review to get past an error. Tell the user instead.

## Steps

1. Run `second-chair doctor`. Fix what it reports, or run `/second-chair:setup`.
2. Run `second-chair threads [PR] > threads.json`. It prints the unresolved threads with `thread_id`, `comment_id`, `path`, `line` and the whole conversation. It leaves out the user's own pending (draft) comments. `gh pr view [PR] --json headRefOid` gives the head.
3. For every thread write one item into `items.json`:

   | Field | Content |
   |:--|:--|
   | `thread_id`, `comment_id`, `path`, `line` | from `threads.json` |
   | `author` | the first comment's author (`comments[0].author`) |
   | `verdict` | `reply`, `fix`, `pushback` or `manual` |
   | `summary` | one line: what the reviewer asks |
   | `context` | for the user only, never posted: what you checked and found |
   | `fix` | the change you plan, for `fix` |
   | `reply_en` | the reply you would post, markdown |
   | `auto` | `true` only when there is no doubt (a plain bug, a typo) |

   A general item for the whole pull request has `comment_id: null` and a `thread_id` starting with `GLOBAL`.
4. Run `second-chair build --repo O/N --pr N --round 1 --head SHA items.json > r1.json`, then `second-chair push r1.json`. Tell the user to open the pull request. The cards are under the threads.
5. Wait with the Bash tool and `run_in_background: true`: `second-chair wait --repo O/N --pr N --round 1 --timeout 1500`. You are notified when it exits. Exit code 2 means 25 minutes passed without a send, so run it again the same way. The timeout stays under the Bash tool's 30 minute background limit on purpose. Meanwhile, answer the user if they write. If the user pastes decisions instead, save them to a file, run `second-chair put-decisions <file>`, and go on with the next step.
6. Read the decisions that `wait` printed. Each has `decision`, `note` and `reply_en` (the user's text, maybe edited). Carry them out. Make the fixes for `fix`, following the project's conventions. A `note` overrides your plan. Commit, but do not push.
7. Round 2: write one item per thread with the final `reply_en` and, for fixes, `commits: ["<sha>"]`. Give each item your proposed `verdict` (`publish`, `hold` or `manual`) so the suggested button shows. The user's round 2 choices are the same three. Keep the threads the user marked `manual` in round 1 with verdict `manual` and `auto: true`, so the user is not asked twice. Never mark a `publish` item `auto`. `build` refuses it, because the user approves every reply that gets posted. Run `second-chair build --repo O/N --pr N --round 2 --head $(git rev-parse HEAD) items2.json > r2.json`. The head is your local commit, not the pushed head. Then run `push` and `wait --round 2` as above.
8. If any reply to publish refers to a commit, run `git push`.
9. Run `second-chair publish --repo O/N --pr N`. It posts exactly the replies marked `publish`. A second run skips what is already posted.
10. Run `second-chair close --repo O/N --pr N`. Report what was posted, with the links `publish` printed.

## If publish refuses

`publish` refuses while the user has a pending review on the pull request, because GitHub posts no reply while one exists. It posts nothing in that case. Tell the user to submit or delete that review on GitHub, then stop. Run `publish` again only after the user says it is done.

For any other error, show the user the message and wait for their instruction.
