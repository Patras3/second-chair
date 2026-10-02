# Testing

Run the unit tests with `npm test`. They need Node 22 and nothing else. Every GitHub call in them goes to a scripted stand-in for `gh`, so they never touch the network.

The live checks below ran once against real GitHub. They are the evidence behind the behaviour the unit tests pin down. Repeat them after a change to `lib/github.mjs` or `lib/publish.mjs`, and only on your own test repository.

## Live checks

Run on 2026-10-02 with Claude Code 2.1.287, gh 2.95.0 and Node 22.23.1. The test repository is the private `Patras3/second-chair-sandbox`, with pull request 1 that adds `src/cache.js`. The checks for `push`, `publish` and decisions used a separate `SECOND_CHAIR_HOME` and port, so they did not touch the everyday server.

### Plugin

| Check | Result |
| --- | --- |
| `claude plugin validate .` | Pass. The first run warned that the marketplace manifest had no description. With one added, it passes with no warnings. |
| `claude plugin validate .claude-plugin/plugin.json` | Pass, no warnings. |
| `claude plugin marketplace add <repo>` and `claude plugin install second-chair@second-chair` | Pass. Installed at user scope. |
| `second-chair` on the Bash tool's PATH in a fresh `claude -p` session | Pass. `command -v second-chair` found the plugin's `bin/second-chair`. |
| The SessionStart hook starts the server | Pass. `doctor` in that session showed `server http://127.0.0.1:7788 ok`. |
| The server outlives the session | Pass. After `claude -p` exited, `curl http://127.0.0.1:7788/health` printed `{"ok":true,"tool":"second-chair"}`. Spawning with `detached` was enough; `setsid` was not needed. |

When the marketplace is a local directory, Claude Code runs the hook and puts `bin/` on PATH from that directory itself. It does not use the copy under `~/.claude/plugins/cache`, although `installed_plugins.json` names that copy as the install path. So a change to the working tree takes effect in the next session without a reinstall.

### GitHub

| Check | Result |
| --- | --- |
| 1. `second-chair threads 1` lists the review comment on line 5 | Pass. The thread came back with its `comment_id`. |
| 2. `draft` with no pending review creates one | Pass. `pending` showed it, and the REST list of reviews showed state `PENDING`. |
| 3. `draft` again appends through GraphQL | Pass. `addPullRequestReviewThread` accepted a single-line and a multi-line comment on a review that `draft` created. |
| 3b. The fallback, when GitHub refuses a change to the pending review | Pass after a fix. `draft --body-file` on a pending review with no body took the fallback: it saved a backup, deleted the review and recreated it with all four comments and the body. The multi-line comment kept its range. |
| 4. `draft` appends to a pending review started outside Second Chair | Pass. The review was started through the REST API from the same account, with one comment and no `event`. `draft` added a second comment through GraphQL. |
| 5. `publish` in review mode edits, drops and keeps pending comments, and sets the body | Pass after a fix. A second run published nothing. |
| 5b. `publish --submit COMMENT` with a body for a pending review that has none | Pass after a fix. The review was submitted with that body. Without `--submit`, `publish` refused and changed nothing. |
| 6. `publish` in respond mode posts a reply with tricky text, once | Pass after a fix. The reply body matched the approved text byte for byte: backticks, double quotes, `$HOME`, a blank line and an @mention. A second run printed `published 0, skipped 1 already done`. |

### What GitHub answered

These answers are why the code looks the way it does.

- `gh api graphql` exits with code 1 when the response carries `errors`. This held both with `-f query=...` and with the body on stdin through `--input -`. gh still prints the JSON to stdout. The `draft` fallback depends on this exit code.
- For a line outside the diff, `addPullRequestReviewThread` answers `{"data":{"addPullRequestReviewThread":{"thread":null}}}`, with no `errors` and exit code 0. `draft` used to report such a comment as added. It now stops, names the comment, says how many comments before it were added, and deletes nothing.
- `GET /repos/{o}/{n}/pulls/{pr}/reviews/{id}/comments` gives no `line`, `start_line` or `side` for the comments of a pending review, only `position`. `pending` now reads the anchors from the review threads in GraphQL, which carry `line`, `startLine`, `diffSide` and `startDiffSide`. A single-line thread reports `startLine` equal to `line`, so that case is not treated as a range.
- The pull request's review threads include the viewer's own pending comments, with state `PENDING`. `threads` used to list them as conversations to answer. It now leaves them out.
- `GET` and `PATCH` on `/repos/{o}/{n}/pulls/comments/{id}` answer `404 Not Found` for a comment in a pending review. `DELETE` on the same path works. `publish` now edits a pending comment with the GraphQL mutation `updatePullRequestReviewComment`, which works.
- A pending review whose body is empty cannot get a body. REST `PUT` on the review and the GraphQL mutation `updatePullRequestReview` both answer `Could not edit a review with a missing body.` This also happens after the body was cleared. Changing or clearing a body that is not empty works. So `draft` rebuilds the review to add a body, and `publish` sends a new body with `--submit`, or refuses without it.
- While the author has a pending review on a pull request, a reply to a review comment fails with `422 Validation Failed: user_id can only have one pending review per pull request`. `publish` in respond mode now checks for a pending review first and posts nothing while one exists.
- On an HTTP error gh prints only the status line to stderr, such as `gh: Validation Failed (HTTP 422)`. GitHub's reason is in the JSON on stdout. Error messages from Second Chair now include that reason.
