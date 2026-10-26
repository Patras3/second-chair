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
- Never push while round 2 holds a `change`.
- Never delete or submit the user's pending review to get past an error. Tell the user instead.
- When you stop to ask the user something, or to wait for their instruction, while the work is with you (the user sent a round, and you have not pushed the next one or closed), first run `second-chair attention --repo O/N --pr N --message "<one line: what you need>"`. The panel then tells the user to come to the terminal, instead of a spinner that never ends. The next `push`, `publish` or `close` clears it. A failed `publish` sets it by itself. So does the plugin's hook when Claude Code waits for input or permission, but your line says more.

## Replies

- Do not open a reply by agreeing: no "You are right", "Good catch", "Agreed". Start with the facts or with what changes.
- When the reviewer read the text differently from what it meant, say first what it meant, with the evidence. Then say whether the wording changes, so the next reader does not read it the same way. A misread is not an error in the work.
- Agree only with what you checked. When the data says something different from the reviewer's claim, give the data, also when you make the change they asked for.

## Steps

1. Run `second-chair doctor`. Fix what it reports, or run `/second-chair:setup`.
2. Run `second-chair threads [PR] > threads.json`. It prints the unresolved threads with `thread_id`, `comment_id`, `path`, `line` and the whole conversation. It leaves out the user's own pending (draft) comments. `gh pr view [PR] --json headRefOid` gives the head.
   Then run `second-chair pending [PR]`. When it prints a review, tell the user now: GitHub posts no reply while they have a pending review on this pull request, so they must submit or delete it before `publish` runs at the end.
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

   A thread whose last comment is the user's own waits on the reviewer. `gh api user --jq .login` gives the user's login. Give such a thread `verdict: "manual"` and `auto: true`, and say in `context` that the user already answered.
4. Run `second-chair build --repo O/N --pr N --round 1 --head SHA items.json > r1.json`, then `second-chair push r1.json`. Give the user the link that `push` printed. The cards are under the threads, and the side panel says whose turn it is.
5. Wait with the Bash tool and `run_in_background: true`: `second-chair wait --repo O/N --pr N --round 1 --timeout 1500`. You are notified when it exits. Exit code 2 means 25 minutes passed without a send, so run it again the same way. The timeout stays under the Bash tool's 30 minute background limit on purpose. Meanwhile, answer the user if they write. If the user pastes decisions instead, save them to a file, run `second-chair put-decisions <file>`, and go on with the next step.
6. Read the decisions that `wait` printed. Each has `decision`, `note` and `reply_en` (the user's text, maybe edited). Carry them out. Make the fixes for `fix`, following the project's conventions. A `note` overrides your plan. Commit, but do not push.
7. Round 2: write one item per thread with the final `reply_en` and, for fixes, `commits: ["<sha>"]`. Give each item your proposed `verdict` (`publish`, `hold` or `manual`) so the suggested button shows. The user's round 2 choices are these three plus `revise`, which asks you for a new version. A note on the code makes a reply `change`: the user wants the code changed. Keep the threads the user marked `manual` in round 1 with verdict `manual` and `auto: true`, so the user is not asked twice. Never mark a `publish` item `auto`. `build` refuses it, because the user approves every reply that gets posted. Build from the pull request's working tree, with the pull request's head on GitHub as the base: `second-chair build --repo O/N --pr N --round 2 --head $(git rev-parse HEAD) --base $(gh pr view N --json headRefOid -q .headRefOid) items2.json > r2.json`. The page then shows the user every commit that `git push` will send. Put in `commits` only commits that are not on GitHub yet: `build` refuses a sha it cannot find between the base and HEAD. A commit that is already pushed may still be named in the reply text. Then run `push` and `wait --round 2` as above.
8. If any round 2 decision is `revise` or `change`, the user wants a new version. For `revise`, rewrite the reply as the note says. For `change`, read `code_notes`: each names a commit, a file, the marked lines and what to change. `view: "range"` means the line numbers belong to the whole diff from the base, `view: "commit"` to that commit alone. Change the code, in a new commit or by rewriting the unpushed commits, but keep the base an ancestor of HEAD. Then update `commits` and the reply text of the threads in the note's `thread_ids`, so they name the new shas. A note whose `thread_ids` is empty is still a request: carry it out, and say what changed in the `context` of a related item or of a `GLOBAL` item. Keep the other items as they are. Then build, push and wait for round 2 again. Do not publish while a `revise` or a `change` is in the decisions: `publish` refuses it.
9. If a reply the user decided to `publish` refers to a commit, check that `git rev-parse HEAD` equals the `head` in the round 2 decisions that `get` or `wait` printed (the full sha, the same as `changes.head`). If it differs, the user has not seen the code: build, push and wait for round 2 again. Otherwise run `git push`. If no reply to publish refers to a commit, do not push. `publish` then accepts GitHub's old head or the new one. It refuses when a reply to publish refers to a commit and GitHub's head is not the head the user approved.
10. Run `second-chair publish --repo O/N --pr N`. It posts exactly the replies marked `publish`. A second run skips what is already posted.
11. Run `second-chair close --repo O/N --pr N`. The page then shows the user what was posted. Report it here too, with the links `publish` printed.

## If push refuses because the decisions changed

The user can send a round again while you work on it (**Edit and send again**). `push` then refuses the next round until you read the change. Its message names a `get` command.

1. Run that `get` command. It prints the new decisions.
2. Compare them with the decisions you worked from.
3. Change the work to match: revert or adjust commits, rewrite replies.
4. Tell the user what changed, then build and push again. When the changed decisions are round 2's and hold no `revise` and no `change` any more, do not push the proposals: go on with step 9 and `publish`.

## If publish refuses

`publish` refuses while the user has a pending review on the pull request, because GitHub posts no reply while one exists. It posts nothing in that case. Tell the user to submit or delete that review on GitHub, then stop. Run `publish` again only after the user says it is done.

For any other error, run `second-chair attention` with a one-line summary, show the user the message, and wait for their instruction.
