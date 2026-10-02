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

## Release checklist

Walk through this list by hand before a release, on your own test repository. Record the date, the versions and each result here.

### Install

- [ ] In a Claude Code session with no Second Chair installed, run `/plugin marketplace add Patras3/second-chair` and `/plugin install second-chair@second-chair`.
- [ ] Start a new session. `second-chair doctor` shows the server as ok.
- [ ] `/second-chair:setup` shows the doctor table and the browser steps that are still missing.
- [ ] Chrome: install Tampermonkey, turn on **Allow user scripts** (or developer mode), and install the userscript from `http://127.0.0.1:7788/second-chair.user.js`. The Second Chair pill (the chair icon) shows on a pull request.
- [ ] Firefox: install a script manager and the userscript. The Second Chair pill (the chair icon) shows on a pull request.

### Respond flow

Use a pull request of your own with three review threads from another account.

- [ ] `/second-chair:respond <PR>`. The three cards show under their threads.
- [ ] Round 1: pick **Fix** on the first thread, **Push back** on the second and **Reply** on the third. Send.
- [ ] The agent commits the fix and does not push.
- [ ] Round 2: pick **Publish** on the first two threads and **Hold** on the third. Send.
- [ ] The agent pushes, runs `publish` and `close`. GitHub shows two replies with the exact approved text, and nothing on the held thread.

### Review flow

Use a pull request by another account.

- [ ] In the GitHub UI, start a review and write one comment by hand. Do not submit it.
- [ ] `/second-chair:review <PR>` with two findings. The pending review now holds three comments, and the hand-written one has a **Your draft comment** card.
- [ ] Round 1: **Revise** one comment with a note, **Drop** one, **Post** the hand-written one. Send.
- [ ] Round 2: the revised text follows the note. Send with **Post** on the two that are left.
- [ ] After `publish`, the pending review on GitHub holds the two comments with the approved texts, and the dropped one is gone. The review is still pending.
- [ ] With no pending review on the pull request, `second-chair draft <PR> --body-file body.md` with no comments file creates a pending review. `second-chair pending <PR>` shows it with that body and no comments.

### Cards after the end

- [ ] After the final send, no card stays on the page and the pill reads **✓ done**.
- [ ] After a reload, the cards stay hidden.
- [ ] Stop the server (`second-chair stop`) and reload. The cards stay hidden.
- [ ] **Show cards on the page** brings them back, read only.

### Server

- [ ] Write the pid of another running process into `server.pid` in the data directory, with the server running. `second-chair stop` says the server is not the one `start` launched. Both processes keep running.
- [ ] With no server running, start two Claude Code sessions at the same moment. One server runs. The pid in `server.pid` equals the `pid` that `curl http://127.0.0.1:7788/health` prints. `second-chair stop` stops it.
- [ ] With the server of the previous version running, update the plugin and start a new session. `curl http://127.0.0.1:7788/health` prints the new `version` and a new `pid`.

### Other systems

- [ ] macOS: the server that the session hook started with `second-chair start` keeps running after the session ends.
- [ ] Windows: the same check.
- [ ] Windows: `bin/second-chair` starts with a shebang line, so outside Git Bash it runs only as `node bin/second-chair`. Note here how the hook and the command behave in PowerShell and in Git Bash.

### GitHub settings

- [ ] Set the repository's social preview to `docs/images/social-preview.png` (Settings → General → Social preview; GitHub has no API for it).

### Release run 2026-10-02

Run with Claude Code 2.1.288, gh 2.95.0, Node 22.23.1 and Second Chair 1.0.0. The plugin was installed from the GitHub marketplace `Patras3/second-chair` at commit 6a5615e. Every check used that installed copy (`~/.claude/plugins/cache/second-chair/second-chair/1.0.0/bin/second-chair`) and the everyday server on port 7788, unless a row says otherwise. Every GitHub write went to the private `Patras3/second-chair-sandbox`.

No browser with a GitHub login was available. The decisions went to the server the way the userscript sends them: `POST /api/decisions` with the header `X-Second-Chair: 1` and the object that `buildExport` builds. Before each send, `GET /api/proposals?repo=...&pr=...&round=R` returned the pushed proposals.

A result is pass, fail, adapted (the check ran another way, as the row says) or needs the user.

#### Install

| Check | Result |
| --- | --- |
| Marketplace add and install | Adapted, pass. The local directory marketplace was removed first. `claude plugin marketplace remove second-chair` also uninstalled the plugin. `claude plugin marketplace add Patras3/second-chair` cloned the private repository over HTTPS. `claude plugin install second-chair@second-chair` installed 1.0.0 at user scope, from commit 6a5615e. The commands ran in a shell, not as `/plugin` in a session. |
| New session, `doctor` ok | Pass. The server was stopped first. In a headless `claude -p ... --allowedTools Bash` session, `command -v second-chair` found the cache copy, and `doctor` showed `server http://127.0.0.1:7788 ok, version 1.0.0`. The server that the hook started (pid 116541, from the cache copy) still answered after the session exited. |
| `/second-chair:setup` | Pass. `claude -p '/second-chair:setup' --allowedTools Bash` showed the doctor table and the browser steps: the script manager, Allow user scripts in Chrome or Edge, the userscript address and the pill. |
| Chrome | Needs the user. |
| Firefox | Needs the user. |

#### Respond flow

Adapted. Pull request 2 (https://github.com/Patras3/second-chair-sandbox/pull/2, `validate-ttl` into `add-cache`) adds a `ttlMs` check to `src/cache.js`. Its three review threads came from the author's own account, through REST `POST /pulls/2/comments` with `commit_id`, `path`, `line` and `side`, on lines 4, 5 and 3. There is no second account.

| Check | Result |
| --- | --- |
| Cards show | Adapted, pass. `threads 2` listed the three threads. `build` and `push` gave 3 items, and `GET /api/proposals` served them with the verdicts fix, pushback and reply. The cards on the page need the user. |
| Round 1 | Adapted, pass. Sent Fix, Push back and Reply. The Reply text was edited (`reply_edited: true`). `wait`, run in the background, exited 0 and printed the three decisions. |
| The fix is committed, not pushed | Pass. Commit 854a392 in the scratch clone. The pull request's head stayed d91b3c9 until round 2 was decided. |
| Round 2 | Adapted, pass. The round 2 head was 854a392, the local commit. Sent Publish, Publish and Hold. The second reply was edited to a text with backticks, double quotes, `$HOME` and a blank line. |
| Push, `publish`, `close` | Pass. `publish` printed `published 2, kept 0 unchanged, skipped 0 already done` and the replies `#discussion_r4170502352` and `#discussion_r4170502433`. The pull request then had 5 review comments, 2 of them replies. Both bodies equal the approved text byte for byte. The held thread (comment 4170496674) has no reply. A second `publish` printed `published 0, kept 0 unchanged, skipped 2 already done`, and the count stayed at 5. |

#### Review flow

Adapted. Pull request 1 is by the same account. Its old pending review 5397374499 (Patras3, PENDING) was deleted first.

| Check | Result |
| --- | --- |
| Start a review by hand | Adapted, pass. REST `POST /pulls/1/reviews` with one comment on line 11, no `event` and no body, like a review started in the UI. Review 5397647973, comment 4170512139. |
| Review with two findings | Pass. `pending 1` showed the hand-written comment. `draft 1 comments.json`, without `--body-file` because a review existed, added comment 4170513434 (line 4) and 4170513515 (lines 18 to 20). The review then held three comments. The hand-written comment became item `C4170512139` with `origin: "user"` and `original_en`. The card on the page needs the user. |
| Round 1 | Adapted, pass. Revise with a note on 4170513434, Drop on 4170513515, Post on the hand-written comment, Post on the body. The server refused a Revise with a blank note (`409 thread C4170513434: revise needs a note`) and kept the stored decisions. |
| Round 2 | Adapted, pass. The revised text follows the note. The dropped comment kept `drop` with `auto: true`. Sent Post on the two comments and Post on the body. `publish` refused, because the review has no body: `GitHub cannot add a body to a pending review that has none. ... Nothing was posted.` This is the documented limit. As the review skill says, round 2 was pushed again with the body set to drop, and sent again. No `--submit`. |
| After `publish` | Pass after a fix. `publish` printed `BODY: body cleared`, `C4170512139: kept`, `C4170513434: updated` and `C4170513515: dropped`. In REST and in GraphQL, the pending review then held exactly the two approved texts, byte for byte, and 4170513515 was gone. The review is still PENDING, with an empty body. A second run skipped all 4 items. The summary said `published 3`, but GitHub saw two changes: the body was already empty, so nothing was sent for it. Fixed in dffade2, see below. |
| Body-only `draft` | Pass. On pull request 2, which had no pending review, `pending 2` printed `null`. `draft 2 --body-file body.md` printed `created pending review 5397675516`. `pending 2` showed that body, byte for byte, and no comments. The review was deleted afterwards, so pull request 2 has no pending review. |

#### Cards after the end

All four checks: needs the user. There was no browser on github.com. `npm run smoke` (Playwright Chromium, on a mock pull request page) printed `all ok`. On that page it checks these:

- After the final send, no card stays on the page and the pill reads done.
- A reload with the server down keeps the cards hidden.
- A page load with the server up, after `close`, shows no cards.
- Show cards brings the cards back, read only.

The same checks on github.com need the user.

#### Server

| Check | Result |
| --- | --- |
| Foreign pid | Pass. With the server (pid 116541) running, the pid of a `sleep` process went into `server.pid`. `stop` printed `the server on http://127.0.0.1:7788 is not the one second-chair start launched; stopped nothing and removed the stale pid file`. Both processes kept running. |
| Two sessions at once | Pass. With no server running, two headless `claude -p` sessions started at the same moment. Both printed `/health` with pid 117221, and `server.pid` held 117221. `server.log` shows that the other spawned server exited with `port 7788 is in use`. `stop` stopped the server. |
| Version update | Adapted, pass. In place of a plugin update, `start` ran from a temporary copy of 1.0.0 with version 0.9.9 in `package.json`. `/health` then showed `0.9.9`, pid 117585. A new headless session restarted it. `/health` showed `1.0.0`, pid 117684, and `server.pid` held 117684. |

In this container, a stopped server stays in `ps` as `<defunct>`, because PID 1 is `sleep infinity` and does not reap orphans. Such a process answers nothing and holds no port.

#### Other systems and GitHub settings

- macOS and Windows: needs the user, on a macOS or a Windows machine.
- Social preview: needs the user, after the repository is public.

#### Bugs and notes

- Fixed in dffade2: `publish` counted a review body that already had the approved text as a change. In the review flow above, the drop of an empty body printed `body cleared` and counted in `published 3`, but nothing was sent. Such a body now counts as kept, and `publish` sends nothing for it. A unit test covers drop and post. With the fix, a rerun against the same review, on a separate server on port 7799, printed `published 0, kept 3 unchanged` and changed nothing on GitHub.
- Not changed: `draft` prints a status line before the JSON, so `draft ... > file.json` does not give a valid JSON file. `threads` and `pending` print only JSON. The docs do not say that `draft` prints only JSON.
