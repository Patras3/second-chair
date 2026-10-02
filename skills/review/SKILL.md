---
name: review
description: Use when the user wants to send a review of someone else's GitHub pull request through Second Chair, deciding every comment in the browser before the review is ready. Triggered by "review PR N with Second Chair", a PR URL with that intent, or after another review skill produced findings.
argument-hint: "<PR number or URL>"
---

# Send a review through Second Chair

The review is a pending (draft) GitHub review. The user decides every comment in the browser: Post, Revise or Drop. Only the user's choices end up in the review. Submitting it is the user's move, unless they ask you to submit it for them.

This skill does not say how to review. The findings come from you, from another skill such as `/code-review`, or from the user.

## Rules

- Never submit the review unless the user asked for it in this session. Then use `publish --submit` with the event they named: `COMMENT`, `APPROVE` or `REQUEST_CHANGES`.
- Never add `--submit` on your own after an error. This holds for every error, including the one about a missing review body.
- Never create a second pending review. `second-chair draft` adds to the existing one.
- Never touch reviews or comments by other people.

## Steps

1. Run `second-chair doctor`, then `second-chair pending <PR>`. It prints the review with `review_id`, `body` and every comment (`id`, `path`, `line`, `start_line`, `side`, `start_side`, `in_reply_to`, `body`), or `null`. When it prints a review, the user already started one. Its comments become items too (step 4).
2. Collect the findings. Every comment needs `path`, `line` (a line the diff changed or shows) and `body`. A range also has `start_line` below `line`. `side` is `RIGHT` by default and `LEFT` for a removed line. Check lines with `gh pr diff <PR>`, because GitHub does not report a line outside every hunk as an error. Move such a finding into the review body.
3. Write the new comments to `comments.json` and the body to `body.md`. Run `second-chair draft <PR> comments.json --body-file body.md`. It prints the pending review with every comment id.
   - If it says it recreated the review, tell the user the path where their earlier comments are saved.
   - If it stops because GitHub refused a line, its message says how many new comments were already added. Follow that message. Fix or remove the refused comment, leave out the ones already added, and then run `draft` again. Do not rerun the same file.
   - A review that has no body cannot get one afterwards. `draft --body-file` then rebuilds the review, and that is the case where the earlier comments are saved.
4. Write one item per pending comment, plus one general item for the body:

   | Field | Content |
   |:--|:--|
   | `thread_id` | `C<comment id>`, and `BODY` for the body |
   | `comment_id`, `path`, `line` | from `pending`; `comment_id` is `null` for the body |
   | `verdict` | `post` or `revise` (or `drop` for a comment you now think is wrong) |
   | `summary`, `context` | one line, and your evidence for the user (never posted) |
   | `reply_en` | the comment text as it will be posted |
   | `origin`, `original_en` | for a comment the user wrote: `"user"` and their text. Assess it like yours. For `revise`, put your rewrite in `reply_en` and the reason in `context` |

5. Run `second-chair build --repo O/N --pr N --mode review --round 1 --head SHA items.json > r1.json`, then `push`. Then wait with the Bash tool and `run_in_background: true`: `second-chair wait --repo O/N --pr N --round 1 --timeout 1500`. Exit code 2 means 25 minutes passed without a send, so run it again the same way. Tell the user to open the pull request.
6. Carry out the decisions. Rewrite each `revise` item as its `note` says.
7. Round 2: write one item per comment with the final `reply_en`, verdict `post` or `drop`. Keep the comments the user dropped in round 1 as items with verdict `drop` and their current text, because `publish` only deletes a comment that has a round 2 decision. Run `build --mode review --round 2`, `push`, then `wait --round 2` as above.
8. Run `second-chair publish --repo O/N --pr N`. It edits and deletes pending comments to match. Add `--submit <EVENT>` only under the rule above.
9. Run `second-chair close --repo O/N --pr N`. Tell the user the review is ready to submit on GitHub, with the pull request link.

## If publish refuses

`publish` refuses when the pending review has no body and the user approved a body. GitHub cannot add a body to a review that has none, except together with the submit. Its message says to ask the user. Ask whether to submit now and with which event, or to drop the body. Do not add `--submit` yourself. Use it only if the user answers with an event.

For any other error, show the user the message and wait for their instruction.
