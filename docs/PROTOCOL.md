# Protocol

Second Chair has three parts. The agent calls the `second-chair` command. The command talks to a local server. The userscript on github.com reads proposals from the same server and sends decisions back. This page describes the data they exchange and the order of calls, so any agent that can run shell commands can drive Second Chair.

The decision keys live in two places in the code: `ROUND_KEYS` in `lib/protocol.mjs` and `SC_DECISIONS` in the userscript. A test checks that they are equal.

## Modes and rounds

| Mode | Use | Round 1 keys | Round 2 keys |
|:--|:--|:--|:--|
| `reply` | Answer the review threads on your own pull request | `reply`, `fix`, `pushback`, `manual` | `publish`, `hold`, `manual` |
| `review` | Decide the comments of your pending review on someone else's pull request | `post`, `revise`, `drop` | `post`, `drop` |

A payload without `mode` is in `reply` mode. Round 2 is the final round in both modes. `publish` acts only on round 2 decisions.

What each key means:

| Key | Meaning |
|:--|:--|
| `reply` | Answer only. No code change. |
| `fix` | Change the code as planned, then reply. |
| `pushback` | Disagree. The reply explains why. |
| `manual` | The user handles the thread. The agent posts nothing. |
| `publish` | Post the reply. |
| `hold` | Post nothing for now. |
| `post` | Keep the comment, with the text in the decision. For the review body: set the body. |
| `revise` | The agent rewrites the comment as the note says. A `revise` decision needs a note that is not empty. |
| `drop` | Delete the comment from the pending review. For the review body: clear it. |

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
| `commits` | array of strings | The commits behind the reply, usually in round 2. The card and the panel show them. |
| `origin` | string | `"agent"` (the default) or `"user"`. `"user"` marks a comment or a review body that the user wrote. Its card says "Your draft comment". |
| `original_en` | string | For `origin: "user"`: the user's own text. When `reply_en` is a different text, the card shows the original in a folded "Your original" block. |

Older payloads spell `summary`, `context` and `fix` as `summary_pl`, `context_pl` and `fix_pl`. The page still reads those names.

### Checks

`build` refuses a payload when:

- a round 1 item has no `thread_id`, `verdict` or `reply_en`;
- a round 2 item has no `thread_id` or `reply_en`;
- a `verdict` is not a key of that mode and round;
- `origin` is neither `agent` nor `user`;
- two items share a `thread_id`;
- a round 2 item has `auto: true` with the verdict `publish` (`reply` mode) or `post` (`review` mode). The user approves every text that gets posted.

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
| `exported_at` | string | When the user sent them. |
| `received_at` | string | Set by the server. |
| `decisions[].thread_id` | string | The item. |
| `decisions[].comment_id` | integer or null | Copied from the item. `publish` takes the target from the proposals, not from here. |
| `decisions[].proposed` | string or null | The item's `verdict`. |
| `decisions[].decision` | string | The user's choice: one of the round's keys. |
| `decisions[].auto` | boolean | `true` when the user left an `auto` item as it was. |
| `decisions[].reply_en` | string | The final text, maybe edited by the user. `publish` posts this text. |
| `decisions[].reply_edited` | boolean | `true` when the user changed the text. |
| `decisions[].note` | string | The user's instruction for the agent. It overrides the agent's plan. |

The server refuses decisions with `409` when:

- `tool` or `kind` is wrong;
- there are no proposals for that pull request and round;
- `repo`, `pr` or `round` do not match the proposals;
- `head` differs from the proposals' `head`;
- a `thread_id` is not in the proposals;
- a `decision` is not a key of that mode and round;
- a `revise` decision has an empty note;
- an item has no decision.

When the server is not running, the page copies the decisions to the clipboard instead. The user pastes them to the agent. The agent saves them to a file and runs `second-chair put-decisions <file>` once the server runs. The server checks them as above, and the work goes on as if the page had sent them.

## Server API

The server listens on `http://127.0.0.1:7788`. `SECOND_CHAIR_PORT` or `serve --port` changes the port.

Rules for every request:

- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`. Otherwise the answer is `403`.
- Every route under `/api/` needs the header `X-Second-Chair: 1`. Otherwise the answer is `403`.
- A body is JSON, at most 5 MB. A larger body gets `413`, and a body that is not JSON gets `400`.
- An error answer is `{"error": "<message>"}`. An unknown route gets `404`, and an unexpected failure gets `500`.
- Every answer carries `Cache-Control: no-store`.

| Method and path | Query or body | Answers |
|:--|:--|:--|
| `GET /health` | | `200 {"ok": true, "tool": "second-chair", "pid": N}`, where `pid` is the server's process id. `stop` signals a process only when this `pid` matches its pid file. Needs no `X-Second-Chair` header. |
| `GET /second-chair.user.js` | | `200` with the userscript, with the server's port written into it. Needs no `X-Second-Chair` header. |
| `GET /api/proposals` | `?repo=O/N&pr=N[&round=R]` | `200` with the payload, `400` without a valid `repo` and `pr`, `404` when there is none. Without `round`: the most recently pushed round, so a new round 1 wins over an older round 2. |
| `PUT /api/proposals` | a proposals payload | `200 {"ok": true, "published_at": "…"}`, or `400` with the reason. It replaces that round's proposals and deletes that round's decisions. |
| `GET /api/decisions` | `?repo=O/N&pr=N&round=R` | `200` with the decisions, `400` without `repo`, `pr` and `round`, `404` when there are none yet. |
| `POST /api/decisions` | a decisions payload | `200 {"ok": true}`, or `409` with the reason (see above). |
| `POST /api/close` | `{"repo": "O/N", "pr": N}` | `200 {"ok": true, "closed_at": "…"}`, `400` without `repo` and `pr`, `404` when the pull request has no proposals. |
| `GET /api/published` | `?repo=O/N&pr=N&round=R` | `200 {"items": {"<thread_id>": {"action": "…", "url": "…", "at": "…"}}}`, `400` without `repo`, `pr` and `round`. |
| `POST /api/published` | `{"repo", "pr", "round", "thread_id", "action", "url"}` | `200 {"ok": true}`, or `409` for an unknown pull request, round or `thread_id`, or an empty `action`. |
| `GET /api/status` | | `200` with one entry per pull request and round: `repo`, `pr`, `round`, `head`, `items`, `published_at`, `decided_at`, `closed_at`. |

`publish` records these actions in `/api/published`: `replied`, `dropped`, `updated`, `kept`, `body set` and `body cleared`.

The server stores plain JSON files under the data directory (`SECOND_CHAIR_HOME`, by default `${XDG_DATA_HOME:-~/.local/share}/second-chair`):

```
<owner>/<name>/<pr>/r<round>-proposals.json
<owner>/<name>/<pr>/r<round>-decisions.json
<owner>/<name>/<pr>/r<round>-published.json
<owner>/<name>/<pr>/closed.json
```

The same directory holds `server.pid` and `server.log` from `second-chair start`, and `backups/` from `draft`.

## Call order: respond

For the threads on your own pull request.

1. `second-chair doctor`.
2. `second-chair threads [PR] > threads.json`. `gh pr view [PR] --json headRefOid` gives the head.
3. Write one item per thread, with a round 1 `verdict`.
4. `second-chair build --repo O/N --pr N --round 1 --head SHA items.json > r1.json`, then `second-chair push r1.json`.
5. `second-chair wait --repo O/N --pr N --round 1 --timeout 1500`. Exit code `2` means the time ran out without a send, so run it again. The skills run `wait` in the background.
6. Carry out the decisions and notes. Commit the fixes, but do not push.
7. Write round 2 items with the final `reply_en`, the `commits`, and a `verdict` of `publish`, `hold` or `manual`. A thread the user marked `manual` in round 1 keeps `verdict: "manual"` with `auto: true`, so the user is not asked twice.
8. `second-chair build --repo O/N --pr N --round 2 --head $(git rev-parse HEAD) items2.json > r2.json`, then `push`, then `wait --round 2`.
9. `git push`, when a reply to publish refers to a commit.
10. `second-chair publish --repo O/N --pr N`. For each `publish` decision it posts `reply_en` as a reply to `comment_id`. A general item becomes a pull request comment. `hold` and `manual` post nothing.
11. `second-chair close --repo O/N --pr N`.

## Call order: review

For a review of someone else's pull request.

1. `second-chair doctor`, then `second-chair pending <PR>`. It prints your pending review, or `null`.
2. Write the new comments to `comments.json` and run `second-chair draft <PR> comments.json`. Add `--body-file body.md` only when `pending` printed `null`. `draft` prints the pending review with every comment id. With no new comments and no pending review, run `second-chair draft <PR> --body-file body.md` alone. It creates the review with only the body. With no new comments and a pending review, skip `draft`.
3. Write one item per pending comment (`thread_id: "C<id>"`) and one `BODY` item with `comment_id: null`. A comment or body the user wrote gets `origin: "user"` and keeps the user's text in `original_en`.
4. `second-chair build --repo O/N --pr N --mode review --round 1 --head SHA items.json > r1.json`, then `push` and `wait --round 1`.
5. Rewrite each `revise` item as its note says.
6. Write round 2 items with the final texts and `post` or `drop`. An item the user dropped in round 1 keeps `verdict: "drop"` with `auto: true`, because `publish` deletes only a comment that has a round 2 decision.
7. `build --mode review --round 2`, `push`, then `wait --round 2`.
8. `second-chair publish --repo O/N --pr N`. For `post` it sets the comment's text to `reply_en` when they differ. For `drop` it deletes the comment. The `BODY` item sets or clears the review body. It does not submit the review.
9. `second-chair close --repo O/N --pr N`. Submitting the review is the user's move on GitHub. Add `--submit COMMENT`, `--submit APPROVE` or `--submit REQUEST_CHANGES` to `publish` only when the user asked for it.

`publish` refuses to run when round 2 has no decisions. It prints what it did, item by item. A second run skips what is already recorded, so a failure halfway can be retried.

Its summary line counts the real changes on GitHub. A comment that already had the approved text counts as kept. An approved comment that is no longer in the pending review gets a line that starts with `WARNING`. It is not recorded, so the next run looks for it again.

## Command formats

`threads` prints one object per unresolved thread:

```json
[{"thread_id": "PRRT_kwDOAbc042", "comment_id": 1042, "path": "src/cache/LruCache.java", "line": 42,
  "outdated": false, "url": "https://github.com/octo-org/example/pull/42#discussion_r1042",
  "comments": [{"id": 1042, "author": "ana-ng", "created_at": "2026-09-28T09:12:00Z", "body": "This evicts on every put…"}]}]
```

`pending` prints your pending review, or `null`:

```json
{"review_id": 2001, "node_id": "PRR_…", "commit_id": "8c1f2a7…", "body": "",
 "comments": [{"id": 2058, "node_id": "PRRC_…", "path": "api/handlers/upload.go", "line": 58, "start_line": null,
               "side": "RIGHT", "start_side": null, "position": 4, "in_reply_to": null, "body": "This reads the whole body into memory…"}]}
```

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
