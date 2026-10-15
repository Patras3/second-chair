# Protocol

Second Chair has three parts. The agent calls the `second-chair` command. The command talks to a local server. The userscript on github.com reads proposals from the same server and sends decisions back. This page describes the data they exchange and the order of calls, so any agent that can run shell commands can drive Second Chair.

The decision keys live in two places in the code: `ROUND_KEYS` in `lib/protocol.mjs` and `SC_DECISIONS` in the userscript. A test checks that they are equal.

## Modes and rounds

| Mode | Use | Round 1 keys | Round 2 keys |
|:--|:--|:--|:--|
| `reply` | Answer the review threads on your own pull request | `reply`, `fix`, `pushback`, `manual` | `publish`, `revise`, `hold`, `manual`, `change` |
| `review` | Decide the comments of your pending review on someone else's pull request | `post`, `revise`, `drop` | `post`, `revise`, `drop` |

A payload without `mode` is in `reply` mode. Round 2 is the final round in both modes. `publish` acts only on round 2 decisions.

A round 2 sent with at least one `revise` does not end the work. The agent rewrites those items and pushes round 2 again, and `publish` refuses such decisions.

A round 2 of respond mode with at least one `change` does not end the work either. `change` is derived: the user's notes on the code set it, and the agent never proposes it. The agent changes the code, updates the replies and pushes round 2 again. `publish` refuses such decisions.

The page labels `post` as **Keep**, because in review mode nothing becomes public before the review is submitted.

What each key means:

| Key | Meaning |
|:--|:--|
| `reply` | Answer only. No code change. |
| `fix` | Change the code as planned, then reply. |
| `pushback` | Disagree. The reply explains why. |
| `manual` | The user handles the thread. The agent posts nothing. |
| `publish` | Post the reply. |
| `hold` | Post nothing for now. |
| `post` | Keep the comment, with the text in the decision. For the review body: set the body. The page shows it as **Keep**. |
| `revise` | The agent rewrites the reply or comment as the note says. In round 2 it then pushes round 2 again instead of publishing. A `revise` decision needs a note that is not empty. |
| `drop` | Delete the comment from the pending review. For the review body: clear it. |
| `change` | Set by a note on the code. Not a button. The agent changes the code and sends round 2 again. |

## Proposals

The agent writes items, and `second-chair build` wraps them into a proposals payload:

```json
{
  "tool": "second-chair",
  "kind": "proposals",
  "repo": "octo-org/example",
  "pr": 42,
  "round": 1,
  "head": "8c1f2a7e5b9d04c3a6e1f7b2d8c9e0a1b2c3d4e5",
  "items": [
    {
      "thread_id": "PRRT_kwDOAbc042",
      "comment_id": 1042,
      "author": "ana-ng",
      "path": "src/cache/LruCache.java",
      "line": 42,
      "verdict": "fix",
      "summary": "Evicts on every put, even under capacity",
      "context": "Not intended. 10 000 puts under capacity made 10 000 evictions.",
      "fix": "call `evict()` only when the map is full",
      "reply_en": "Good catch, it wasn't intended. Eviction now runs only when the map is full.",
      "auto": false
    }
  ]
}
```

### Payload fields

| Field | Type | Meaning |
|:--|:--|:--|
| `tool` | string | Always `"second-chair"`. |
| `kind` | string | Always `"proposals"`. |
| `mode` | string | `"review"` for review mode. `build` leaves it out in `reply` mode. |
| `repo` | string | `owner/name`. |
| `pr` | integer | The pull request number. |
| `round` | integer | `1` or `2`. |
| `head` | string | The commit the proposals refer to. In round 1 it is the pull request's head. In round 2 of respond mode it is your local commit, before the push. The decisions must carry the same `head`. |
| `items` | array | One item per thread or comment. At least one. |
| `published_at` | string | Set by the server when the payload is pushed. |
| `closed_at` | string | Set by the server when the work on the pull request was closed after this payload was pushed. The page then hides the cards. |
| `changes` | object | Respond mode, round 2, from `build --base`: the commits that `git push` will send. `base` (the pull request's head on GitHub), `head` (the local HEAD), `add`, `del` (range totals), `commits` (oldest first: `sha`, `subject`, `author`, `add`, `del`, `files`) and `range.files` (the net diff from `base` to `head`, each file with the `commits` that changed it). A file has `path`, `old_path`, `status`, `add`, `del`, `binary` and `patch`. The server keeps the patches apart and serves them on `GET /api/changes`. |

### Item fields

| Field | Type | Meaning |
|:--|:--|:--|
| `thread_id` | string | Required and unique in the payload. Respond mode: the thread id from `threads` (`PRRT_…`), or an id that starts with `GLOBAL` for a general item. Review mode: `C<comment id>`, and `BODY` for the review body. |
| `comment_id` | integer or null | Respond mode: the id of the thread's first comment. Review mode: the id of the pending comment. `null` marks a general item. A general item has no thread on the page, so its card shows in the panel. |
| `author` | string | Respond mode: the reviewer's login, from `comments[0].author`. The panel shows it. |
| `path` | string | The file. The panel groups the items by it. |
| `line` | integer | The line in the file. |
| `verdict` | string | The agent's proposal: one of the round's keys. Required in round 1. The card outlines that button. |
| `summary` | string | One line: what the reviewer asks, or what the comment says. |
| `context` | string | Markdown for the user only, never posted: what the agent checked and found. |
| `fix` | string | Markdown: the planned change, for `fix`. The card shows it under the context as "Plan". |
| `reply_en` | string | Required. Markdown: the reply or comment as it will be posted. For the `BODY` item: the proposed review body. |
| `auto` | boolean | `true` when the item needs no decision from the user. It counts as decided with its `verdict`, and the card shows one line. The user can still pick another button. In round 2, a verdict that posts text (`publish` in `reply` mode, `post` in `review` mode) cannot be `auto`. |
| `commits` | array of strings | Full shas. With `--base`, `build` turns each entry, a unique prefix of 7 or more characters, into the full sha of a commit in `changes`. The card shows each as a row with **View changes**. |
| `origin` | string | `"agent"` (the default), `"user"` or `"earlier"`. `"user"` marks a comment or a review body that the user wrote. Its card says "Your draft comment". `"earlier"` marks a comment that Second Chair added in an earlier review pass. Its card says "Second Chair · earlier pass". |
| `original_en` | string | For `origin: "user"` or `"earlier"`: the text the comment has now. When `reply_en` is a different text, the card shows it in a folded block, "Your original" or "Earlier text". |
| `needs_submit` | boolean | `BODY` item only. `true` when the pending review has no body. GitHub then adds a body only together with the submit, so the page asks for a submit event when the body is kept. |
| `suggested_submit` | string | `BODY` item only, round 2. The agent's suggestion for the submit: `COMMENT`, `APPROVE` or `REQUEST_CHANGES`. The page outlines it and never picks it for the user. |

Older payloads spell `summary`, `context` and `fix` as `summary_pl`, `context_pl` and `fix_pl`. The page still reads those names.

### Checks

`build` refuses a payload when:

- a round 1 item has no `thread_id`, `verdict` or `reply_en`;
- a round 2 item has no `thread_id` or `reply_en`;
- a `verdict` is not a key of that mode and round;
- a verdict is `change`: the user's notes set it, the agent never proposes it;
- `origin` is not `agent`, `user` or `earlier`;
- `suggested_submit` is not a submit event, `needs_submit` is not a boolean, or either sits on an item other than `BODY`;
- two items share a `thread_id`;
- a round 2 item has `auto: true` with the verdict `publish` (`reply` mode) or `post` (`review` mode). The user approves every text that gets posted;
- `changes` has a bad shape, or sits outside round 2 of respond mode.

With `--base SHA`, `build` also refuses when:

- `--base` or `--head` is not 40 hex characters;
- `--head` is not this directory's HEAD. Build from the pull request's working tree;
- the base is not an ancestor of HEAD. The local branch does not contain the pull request's head on GitHub. A rebase would need a force push, which Second Chair does not do. Tell the user;
- git does not know the base. Run `git fetch`, then build again;
- an entry of `commits` is not a unique prefix of 7 or more characters of a commit between the base and HEAD.

When the base equals HEAD, `build` leaves `changes` out. `--base` is allowed only in respond mode, round 2. `build` runs git from the repository's top level, through `execFile` and never a shell, with fixed options and `--literal-pathspecs`.

`build` puts the general items first. The server checks less: `tool`, `kind`, `repo`, `pr`, `mode`, `round`, at least one item, unique `thread_id` values and the `auto` rule above. The page also never counts such an item as decided until the user picks a button.

## Decisions

The userscript sends this when the user clicks **Send decisions**. `wait` and `get` print it:

```json
{
  "tool": "second-chair",
  "kind": "decisions",
  "mode": "reply",
  "repo": "octo-org/example",
  "pr": 42,
  "round": 1,
  "head": "8c1f2a7e5b9d04c3a6e1f7b2d8c9e0a1b2c3d4e5",
  "exported_at": "2026-09-30T18:03:00.000Z",
  "received_at": "2026-09-30T18:03:00.120Z",
  "decisions": [
    {
      "thread_id": "PRRT_kwDOAbc042",
      "comment_id": 1042,
      "proposed": "fix",
      "decision": "fix",
      "auto": false,
      "reply_en": "Good catch, it wasn't intended. Eviction now runs only when the map is full.",
      "reply_edited": false,
      "note": ""
    }
  ]
}
```

| Field | Type | Meaning |
|:--|:--|:--|
| `tool`, `kind` | string | `"second-chair"` and `"decisions"`. |
| `mode` | string | `"reply"` or `"review"`. Always present. |
| `repo`, `pr`, `round`, `head` | as in the proposals | Copied from the proposals they answer. |
| `published_at` | string | The `published_at` of the proposals these decisions answer. The server refuses decisions for a publication the agent replaced since. A page from 1.0 leaves it out, and is not checked. |
| `exported_at` | string | When the user sent them. |
| `received_at` | string | Set by the server. |
| `revision` | integer | Set by the server. `1` for the first send of a round, one more for every later send of the same round. |
| `picked_up_at` | string or null | Set by the server the first time the agent reads this revision with `wait` or `get`. The page reads with `peek=1`, which does not count. |
| `decisions[].thread_id` | string | The item. |
| `decisions[].comment_id` | integer or null | Copied from the item. `publish` takes the target from the proposals, not from here. |
| `decisions[].proposed` | string or null | The item's `verdict`. |
| `decisions[].decision` | string | The user's choice: one of the round's keys. |
| `decisions[].auto` | boolean | `true` when the user left an `auto` item as it was. |
| `decisions[].reply_en` | string | The final text, maybe edited by the user. `publish` posts this text. |
| `decisions[].reply_edited` | boolean | `true` when the user changed the text. |
| `decisions[].note` | string | The user's instruction for the agent. It overrides the agent's plan. |
| `code_notes` | array | Respond mode, round 2 only. The user's notes on the code, see below. |
| `submit` | string or null | Review mode, round 2 only. What happens to the review after `publish` applied the decisions: `COMMENT`, `APPROVE` or `REQUEST_CHANGES` submits it with that event. `null` or missing leaves it as a draft. |

### Code notes

In round 2 of respond mode the user can leave a note under a file of the diff. The decisions then carry `code_notes`:

```json
"code_notes": [
  { "sha": "4e1a9c2b7d3f5a6081c2d3e4f5a6b7c8d9e0f1a2", "path": "src/main/java/cache/LruCache.java", "view": "range",
    "lines": [ { "side": "new", "n": 40 }, { "side": "new", "n": 41 } ],
    "text": "Evict only when the key is new.",
    "thread_ids": ["PRRT_kwDOAbc042"] }
]
```

- `sha` and `path` name a commit of `changes.commits` and a file of that commit. The note has a `text` that is not empty.
- `view` is `"range"` or `"commit"`. In `"range"`, a new-side line number is the line in that file at HEAD, and an old-side number is the line at the base. In `"commit"`, a new-side number is the line in the file as of `sha` (`git show <sha>:<path>`), and an old-side number is the line in the file in the parent of `sha`. A `"range"` note's `sha` is the last commit that changed the file.
- There is one note per `sha`, `path` and `view`.
- `thread_ids` are the threads whose item cites the `sha` in `commits`. The server computes the same set and refuses a mismatch.
- Each of those threads has the decision `change`. Every `change` is covered by a note.
- A note on a commit that no reply cites has empty `thread_ids`. It is still a request to the agent.

`change` is in `DERIVED` in `lib/protocol.mjs`: it is never a verdict, and the page gives it no button.

The server refuses decisions with `409` when:

- `tool` or `kind` is wrong;
- there are no proposals for that pull request and round;
- `repo` has a `.` or `..` part, or `pr` or `round` is not a whole number of 1 or more;
- `repo`, `pr` or `round` do not match the proposals;
- `head` differs from the proposals' `head`;
- a `thread_id` is not in the proposals;
- a `decision` is not a key of that mode and round;
- a `revise` decision has an empty note;
- `code_notes` is set outside respond mode, round 2, or the proposals have no `changes`, or a note breaks the rules above;
- a `change` decision is not covered by a note, or a thread in a note's `thread_ids` is not `change`;
- `submit` is set outside review mode or round 2, or is not `COMMENT`, `APPROVE` or `REQUEST_CHANGES`;
- `published_at` is set and differs from the proposals' `published_at`: the agent sent a new version of the round;
- an item has no decision.

The server also refuses a send with `409` once the agent pushed the next round after the earlier send: "the agent already sent round 2; decide there".

### Changed decisions

The user can send a round again while the agent works on it (**Edit and send again** on the page). Each send is a new `revision`. The agent may already have read the earlier one, so the server makes sure it sees the change: `PUT /api/proposals` refuses a push with `409` while round R or R-1 holds a revision above 1 that nobody read yet. The message names the `get` command to run. A decisions file from 1.0 has no `revision`, and counts as revision 1, read.

When the server is not running, the page copies the decisions to the clipboard instead. The user pastes them to the agent. The agent saves them to a file and runs `second-chair put-decisions <file>` once the server runs. The server checks them as above, and the work goes on as if the page had sent them.

## Server API

The server listens on `http://127.0.0.1:7788`. `SECOND_CHAIR_PORT` or `serve --port` changes the port.

Rules for every request:

- A `repo` is `owner/name`, and neither part may be `.` or `..`.
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`. Otherwise the answer is `403`.
- Every route under `/api/` needs the header `X-Second-Chair: 1`. Otherwise the answer is `403`.
- A body is JSON, at most 5 MB, except `PUT /api/proposals`, which takes up to 64 MB for the patches. A larger body gets `413`, and a body that is not JSON gets `400`.
- An error answer is `{"error": "<message>"}`. An unknown route gets `404`, and an unexpected failure gets `500`.
- Every answer carries `Cache-Control: no-store`.

| Method and path | Query or body | Answers |
|:--|:--|:--|
| `GET /health` | | `200 {"ok": true, "tool": "second-chair", "pid": N, "version": "1.0.0"}`. `pid` is the server's process id. `stop` signals a process only when this `pid` matches the pid file. `version` is the version in the server's `package.json`. `start` restarts a server whose version is older than its own, or missing. It keeps a newer server. Needs no `X-Second-Chair` header. |
| `GET /second-chair.user.js` | | `200` with the userscript, with the server's port written into it. Needs no `X-Second-Chair` header. |
| `GET /api/proposals` | `?repo=O/N&pr=N[&round=R]` | `200` with the payload, `400` without a valid `repo` and `pr` or with a `round` that is not a whole number of 1 or more, `404` when there is none. Without `round`: the most recently pushed round, so a new round 1 wins over an older round 2. |
| `PUT /api/proposals` | a proposals payload | `200 {"ok": true, "published_at": "…"}`, `400` with the reason, or `409` while round R or R-1 has a changed revision the agent has not read (see [Changed decisions](#changed-decisions)). It replaces that round's proposals and deletes that round's decisions. A round 1 starts a new cycle, so it also deletes the record of what `publish` did in the last cycle. |
| `GET /api/changes` | `?repo=O/N&pr=N&round=R` | `200 {"published_at", "commits", "range"}` with the patches, `400` without a valid `repo`, `pr` and `round`, `404` when the round has none. The patches are stored apart in `r<round>-changes.json` with the server's `published_at`, and a `published_at` in the client's payload is overridden. The page uses them only when this `published_at` equals the proposals'. |
| `GET /api/decisions` | `?repo=O/N&pr=N&round=R[&peek=1]` | `200` with the decisions, `400` without `repo`, `pr` and `round`, `404` when there are none yet. Without `peek=1` the first read of a revision sets its `picked_up_at`. |
| `POST /api/decisions` | a decisions payload | `200 {"ok": true, "revision": N}`, or `409` with the reason (see above). |
| `POST /api/close` | `{"repo": "O/N", "pr": N}` | `200 {"ok": true, "closed_at": "…"}`, `400` without `repo` and `pr`, `404` when the pull request has no proposals. |
| `GET /api/published` | `?repo=O/N&pr=N&round=R` | `200 {"items": {"<thread_id>": {"action": "…", "url": "…", "at": "…"}}}`, `400` without `repo`, `pr` and `round`. |
| `POST /api/published` | `{"repo", "pr", "round", "thread_id", "action", "url"}` | `200 {"ok": true}`, or `409` for an unknown pull request, round or `thread_id`, or an empty `action`. In review mode, `{"thread_id": "REVIEW", "action": "submitted", "event": "COMMENT"}` records the submit. |
| `GET /api/drafted` | `?repo=O/N&pr=N` | `200 {"ids": [...]}`: the pending comments that `draft` added for Second Chair. `400` without `repo` and `pr`. |
| `POST /api/drafted` | `{"repo", "pr", "ids"}` | `200 {"ok": true}`. Replaces the list. `400` when an id is not a whole number of 1 or more. |
| `GET /api/status` | | `200` with one entry per pull request and round: `repo`, `pr`, `round`, `head`, `items`, `published_at`, `decided_at`, `revision`, `picked_up_at`, `closed_at`. |

`publish` records these actions in `/api/published`: `replied`, `dropped`, `updated`, `kept`, `body set` and `body cleared`, and `submitted` under `REVIEW`.

The server stores plain JSON files under the data directory (`SECOND_CHAIR_HOME`, by default `${XDG_DATA_HOME:-~/.local/share}/second-chair`):

```
<owner>/<name>/<pr>/r<round>-proposals.json
<owner>/<name>/<pr>/r<round>-changes.json
<owner>/<name>/<pr>/r<round>-decisions.json
<owner>/<name>/<pr>/r<round>-published.json
<owner>/<name>/<pr>/closed.json
<owner>/<name>/<pr>/drafted.json
```

The same directory holds `server.log` from `second-chair start`, and `backups/` from `draft`. It also holds `server.pid` while a server that `start` launched runs. That server writes the file once it listens on the port, and removes it when it stops. On Windows, `stop` removes it, and so does the next `start` when the file names another process than the server on the port.

## Call order: respond

For the threads on your own pull request.

1. `second-chair doctor`.
2. `second-chair threads [PR] > threads.json`. `gh pr view [PR] --json headRefOid` gives the head.
3. Write one item per thread, with a round 1 `verdict`.
4. `second-chair build --repo O/N --pr N --round 1 --head SHA items.json > r1.json`, then `second-chair push r1.json`.
5. `second-chair wait --repo O/N --pr N --round 1 --timeout 1500`. Exit code `2` means the time ran out without a send, so run it again. The skills run `wait` in the background.
6. Carry out the decisions and notes. Commit the fixes, but do not push.
7. Write round 2 items with the final `reply_en`, the `commits` (only commits that are not on GitHub yet), and a `verdict` of `publish`, `hold` or `manual`. A thread the user marked `manual` in round 1 keeps `verdict: "manual"` with `auto: true`, so the user is not asked twice.
8. `second-chair build --repo O/N --pr N --round 2 --head $(git rev-parse HEAD) --base $(gh pr view N --json headRefOid -q .headRefOid) items2.json > r2.json`, from the pull request's working tree. Then `push`, then `wait --round 2`. If `push` refuses because the decisions changed, run the `get` command it names, redo what changed, and push again.
   - When the decisions hold a `revise`, rewrite those replies and repeat this step.
   - When they hold a `change`, read `code_notes` and change the code. Make a new commit or rewrite the unpushed commits, but keep the base an ancestor of HEAD. Update `commits` and the reply text so they name the new shas, then repeat this step. Never push while a `change` is open.
9. Check that `git rev-parse HEAD` equals `changes.head` of the round 2 the user decided. If it differs, the user has not seen the code: repeat step 8. Otherwise run `git push`, but only when a reply the user decided to `publish` refers to a commit. When none does, do not push.
10. `second-chair publish --repo O/N --pr N`. For each `publish` decision it posts `reply_en` as a reply to `comment_id`. A general item becomes a pull request comment. `hold` and `manual` post nothing. It refuses while a decision is `revise` or `change`, or `code_notes` is not empty. It also checks the pull request's head on GitHub (`headRefOid`) before any write. When a reply to post refers to a commit, the head must be `changes.head`. Otherwise `changes.base` or `changes.head` is fine. With nothing left to post, it makes no check. A wrong head gets a hint to wait a few seconds and run it again, or to build and push round 2 again. It posts nothing in all these cases.
11. `second-chair close --repo O/N --pr N`.

## Call order: review

For a review of someone else's pull request.

1. `second-chair doctor`, then `second-chair pending <PR>`. It prints your pending review, or `null`.
2. Write the new comments to `comments.json` and run `second-chair draft <PR> comments.json`. Add `--body-file body.md` only when `pending` printed `null`. `draft` prints one status line on stderr and the pending review with every comment id as JSON on stdout, so `draft ... > pending.json` gives a valid JSON file. With no new comments and no pending review, run `second-chair draft <PR> --body-file body.md` alone. It creates the review with only the body. With no new comments and a pending review, skip `draft`.
3. Write one item per pending comment (`thread_id: "C<id>"`) and one `BODY` item with `comment_id: null`. A comment or body the user wrote gets `origin: "user"` and keeps the user's text in `original_en`.
4. `second-chair build --repo O/N --pr N --mode review --round 1 --head SHA items.json > r1.json`, then `push` and `wait --round 1`. If a later `push` refuses because the decisions changed, run the `get` command it names, redo what changed, and push again.
5. Rewrite each `revise` item as its note says.
6. Write round 2 items with the final texts and `post` or `drop`. An item the user dropped in round 1 keeps `verdict: "drop"` with `auto: true`, because `publish` deletes only a comment that has a round 2 decision.
7. `build --mode review --round 2`, `push`, then `wait --round 2`.
8. When the round 2 decisions hold a `revise`, rewrite those items and go back to step 7. `publish` refuses such decisions.
9. `second-chair publish --repo O/N --pr N`. For `post` it sets the comment's text to `reply_en` when they differ. For `drop` it deletes the comment. The `BODY` item sets or clears the review body. When the decisions carry `submit`, it then submits the review with that event and records it under `REVIEW`. Without `submit`, the review stays a draft. `--submit COMMENT`, `--submit APPROVE` or `--submit REQUEST_CHANGES` submits too, when the user asked for it in the session. It must agree with the panel's choice.
10. `second-chair close --repo O/N --pr N`. When the review stays a draft, submitting it is the user's move on GitHub.

`publish` refuses to run when round 2 has no decisions. It prints what it did, item by item. A second run skips what is already recorded, so a failure halfway can be retried.

Its summary line counts the real changes on GitHub. A comment or a review body that already had the approved text counts as kept, and `publish` sends nothing for it. An empty body that the user dropped is such a case. An approved comment that is no longer in the pending review gets a line that starts with `WARNING`. It is not recorded, so the next run looks for it again.

## Command formats

`threads` prints one object per unresolved thread:

```json
[{"thread_id": "PRRT_kwDOAbc042", "comment_id": 1042, "path": "src/cache/LruCache.java", "line": 42,
  "outdated": false, "url": "https://github.com/octo-org/example/pull/42#discussion_r1042",
  "comments": [{"id": 1042, "author": "ana-ng", "created_at": "2026-09-28T09:12:00Z", "body": "This evicts on every put…"}]}]
```

`pending` prints your pending review, or `null`. Each comment has `by`: `"second-chair"` when `draft` added it for Second Chair, `"you"` otherwise, and `"unknown"` when the server is down and cannot say:

```json
{"review_id": 2001, "node_id": "PRR_…", "commit_id": "8c1f2a7…", "body": "",
 "comments": [{"id": 2058, "node_id": "PRRC_…", "path": "api/handlers/upload.go", "line": 58, "start_line": null,
               "side": "RIGHT", "start_side": null, "position": 4, "in_reply_to": null, "body": "This reads the whole body into memory…",
               "by": "second-chair"}]}
```

`draft` records the ids of the comments it added with the server (`POST /api/drafted`), so a later review pass can tell them from the user's. After a rebuild it records the new ids. It refuses a comment on lines that already hold a pending comment (same file and side, overlapping lines), names that comment, and changes nothing: a second pass proposes a new text for the existing comment instead. `--allow-same-line` lets a separate point on the same lines through.

`draft` reads a list of comments. `line` must be a line that the diff changed or shows. A range adds `start_line` below `line`. `side` is `RIGHT` by default, and `LEFT` for a removed line.

```json
[{"path": "api/handlers/upload.go", "line": 58, "body": "This reads the whole body into memory…"},
 {"path": "api/handlers/upload.go", "start_line": 16, "line": 17, "side": "RIGHT", "body": "The error from `MaxBytesReader` is dropped…"}]
```

## GitHub limits

These answers from GitHub shape `draft` and `publish`. [TESTING.md](TESTING.md#what-github-answered) has the live checks behind them.

- GitHub allows one pending review per user and pull request. `draft` adds comments to the existing one through the GraphQL mutation `addPullRequestReviewThread`. If GitHub refuses, `draft` saves your comments to `backups/` in the data directory, deletes the review, and creates it again with your comments and the new ones. It does not rebuild a review that holds a reply in an existing thread, or that sits on an older commit than the pull request's head.
- When you have a pending review on a pull request, GitHub refuses your replies to review comments with `422`. `publish` in respond mode checks for a pending review first. If one exists, it posts nothing.
- A pending review with an empty body cannot get a body, except together with the submit. `draft --body-file` rebuilds the review in that case. `publish` refuses without `--submit`, and the agent asks the user.
- For a line outside the diff, GitHub adds no comment and reports no error. `draft` stops, names the comment, and says how many new comments it already added.
- REST cannot read or edit a comment of a pending review. `publish` edits it through the GraphQL mutation `updatePullRequestReviewComment`. Deleting works through REST.
