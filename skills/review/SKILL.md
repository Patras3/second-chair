---
name: review
description: Use when the user wants to send a review of someone else's GitHub pull request through Second Chair, deciding every comment in the browser before the review is ready. Triggered by "review PR N with Second Chair", a PR URL with that intent, or after another review skill produced findings.
argument-hint: "<PR number or URL>"
---

# Send a review through Second Chair

The review is a pending (draft) GitHub review. The user decides every comment in the browser: Keep, Revise or Drop. Only the user's choices end up in the review. In round 2 the user also chooses what happens to the review: leave it as a draft and submit it on GitHub, or let you submit it with an event.

This skill does not say how to review. The findings come from you, from another skill such as `/code-review`, or from the user.

## Rules

- Never post, reply, resolve or edit anything on GitHub yourself. Comments reach the pending review only through `second-chair draft`, and edits, deletions and the body only through `second-chair publish`.
- Submit the review only when the user chose an event in the panel, or asked for it in this session. `publish` reads the panel's choice by itself, so do not add `--submit` for it. Use `publish --submit <EVENT>` only for an event the user named in this session, and it must agree with the panel.
- Never add `--submit` on your own after an error. This holds for every error, including the one about a missing review body.
- Never create a second pending review. `second-chair draft` adds to the existing one.
- Never touch reviews or comments by other people.
- When you stop to ask the user something, or to wait for their instruction, while the work is with you (the user sent a round, and you have not pushed the next one or closed), first run `second-chair attention --repo O/N --pr N --message "<one line: what you need>"`. The panel then tells the user to come to the terminal, instead of a spinner that never ends. The next `push`, `publish` or `close` clears it. A failed `publish` sets it by itself. So does the plugin's hook when Claude Code waits for input or permission, but your line says more.

## Steps

1. Run `second-chair doctor`, then `second-chair pending <PR>`. It prints the review with `review_id`, `body` and every comment (`id`, `path`, `line`, `start_line`, `side`, `start_side`, `in_reply_to`, `body`, `by`), or `null`. When it prints a review, the user already started one, or an earlier pass did. Its comments and its body become items too (step 4).
   - `by: "you"` marks a comment the user wrote.
   - `by: "second-chair"` marks a comment that an earlier pass of this skill added. Then this run is a second pass (see step 4).
   - `by: "unknown"` means the server was down. Ask the user which comments are theirs.
2. Collect the findings. Every comment needs `path`, `line` (a line the diff changed or shows) and `body`. A range also has `start_line` below `line`. `side` is `RIGHT` by default and `LEFT` for a removed line. Check lines with `gh pr diff <PR>`. GitHub returns no error for a line outside every hunk, and `draft` stops with a message instead. Move such a finding into the review body.
3. Write the new comments to `comments.json` and run `second-chair draft <PR> comments.json`. It prints the pending review with every comment id as JSON on stdout. Its status line, including any backup path, goes to stderr. If there are no new comments and `pending` printed `null`, run `second-chair draft <PR> --body-file body.md` instead. It creates the review with only your body. If there are no new comments and the user already has a review, skip `draft`.
   - Add `--body-file body.md` only when `pending` printed `null` in step 1. Then `draft` creates the review with your body. When the user already has a review, leave the body alone: `draft` would write your body over theirs, and an empty body would force a rebuild of the review. Your proposed body goes into the `BODY` item (step 4) and `publish` applies it.
   - If it says it recreated the review, tell the user the path where their earlier comments are saved.
   - If it stops because GitHub refused a line, its message says how many new comments were already added. Follow that message. Fix or remove the refused comment, leave out the ones already added, and then run `draft` again. Do not rerun the same file.
   - If it stops because a line already has a pending comment, do not add a second one. Propose a new text for the existing comment in its item (step 4). Use `--allow-same-line` only for a separate point on the same lines.
4. Write one item per pending comment, plus one general item for the body:

   | Field | Content |
   |:--|:--|
   | `thread_id` | `C<comment id>`, and `BODY` for the body |
   | `comment_id`, `path`, `line` | from `pending`; `comment_id` is `null` for the body |
   | `verdict` | `post` or `revise` (or `drop` for a comment you now think is wrong) |
   | `summary`, `context` | one line, and your evidence for the user (never posted) |
   | `reply_en` | the comment text as it will be posted. For the body: your proposed body |
   | `origin`, `original_en` | for a comment the user wrote: `"user"` and their text. For a comment from an earlier pass: `"earlier"` and its current text. For the body: when `pending.body` is not empty, `"user"` and that text. Assess it like yours. For `revise`, put your rewrite in `reply_en` and the reason in `context` |
   | `needs_submit` | `BODY` only: `true` when `pending` printed a review with an empty `body`, or when `draft` created the review without a body. GitHub then adds a body only with the submit, and the panel asks the user for an event |
   | `suggested_submit` | `BODY` only, round 2, optional: your suggestion for the submit (`COMMENT`, `APPROVE` or `REQUEST_CHANGES`), with the reason in `context`. The panel outlines it. The user picks |
   | `auto` | `true` only for an item that needs no decision from the user (see step 7) |

   **A second pass.** When `pending` holds comments `by: "second-chair"`, do not draft a new comment for a finding that one of them covers. Put your new text into that comment's item: `reply_en` is the new text, `original_en` the current text, `origin` is `"earlier"`, and `context` says what changed. An earlier comment that this pass no longer supports gets `verdict: "drop"` and the reason in `context`.

5. Get the head with `gh pr view <PR> --json headRefOid --jq .headRefOid`. Run `second-chair build --repo O/N --pr N --mode review --round 1 --head SHA items.json > r1.json`, then `push`. Give the user the link that `push` printed: the Files changed tab, where the draft comments are. Tell them not to submit the review on GitHub until Second Chair says it is ready. Then wait with the Bash tool and `run_in_background: true`: `second-chair wait --repo O/N --pr N --round 1 --timeout 1500`. Exit code 2 means 25 minutes passed without a send, so run it again the same way. If the user pastes decisions instead, save them to a file, run `second-chair put-decisions <file>`, and go on with the next step.
6. Carry out the decisions. Rewrite each `revise` item as its `note` says.
7. Round 2: write one item per comment and one for the body, with the final `reply_en` and verdict `post` or `drop`. Keep the items the user dropped in round 1 with verdict `drop`, `auto: true` and their current text, because `publish` only deletes a comment that has a round 2 decision, and `auto` spares the user a second decision. Keep `needs_submit` on the `BODY` item. Add `suggested_submit` there when you have a suggestion for the submit. Never mark a `post` item `auto`. `build` refuses it, because the user approves every text that gets posted. Use the same head command as in step 5. Run `build --mode review --round 2`, `push`, then `wait --round 2` as above.
8. If any round 2 decision is `revise`, rewrite those items as the notes say, then build, push and wait for round 2 again. Do not publish while a `revise` is in the decisions.
9. Run `second-chair publish --repo O/N --pr N`. It edits and deletes pending comments to match. When the decisions carry `submit`, it then submits the review with that event. If it prints a `WARNING` that an approved comment is not in the pending review, tell the user which one.
10. Run `second-chair close --repo O/N --pr N`. When the decisions carry `submit`, tell the user the review was submitted with that event, with the pull request link. Without `submit`, the review is ready and still a draft: the user submits it on GitHub (Files changed, Review changes, Submit).

## If publish refuses

`publish` refuses when the pending review has no body, the user kept a body, and the user left the review as a draft. GitHub adds such a body only with the submit. The panel blocks this when `BODY` has `needs_submit: true`, so it happens only when that flag was missing. Tell the user, set `needs_submit: true` on the `BODY` item, then build, push and wait for round 2 again. The user then chooses an event or drops the body. Do not add `--submit` yourself.

## If push refuses because the decisions changed

The user can send a round again while you work on it (**Edit and send again**). `push` then refuses the next round until you read the change. Its message names a `get` command.

1. Run that `get` command. It prints the new decisions.
2. Compare them with the decisions you worked from.
3. Change the work to match: rewrite or restore the comments.
4. Tell the user what changed, then build and push again. When the changed decisions are round 2's and hold no `revise` any more, do not push: go on with `publish`.

For any other error, run `second-chair attention` with a one-line summary, show the user the message, and wait for their instruction.
