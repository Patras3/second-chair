# PR triage

Answer pull request review threads together with a coding agent. The agent reads every thread
and proposes a verdict, a reply, and a note for you. A Tampermonkey userscript shows each
proposal under its thread on GitHub, next to the code the reviewer marked. You decide every
thread, and the decisions go back to the agent. Nothing is posted until you approve the final
texts in a second round.

## Parts

| Part | What it does |
|:--|:--|
| `pr-triage.user.js` | The userscript: cards under every thread, a side panel, decisions |
| `server.mjs` | Local server on `127.0.0.1:7788`: stores proposals and decisions, serves the userscript |
| `bin/pr-triage` | CLI for the agent: `serve`, `push`, `wait`, `get`, `close`, `status` |
| `build_payload.py` | Wraps proposal arrays into a payload |

No dependencies. The server and the CLI need Node 22 or newer.

## Set up

1. Start the server, either as a systemd user service (`./install-service.sh`) or by hand
   (`bin/pr-triage serve`).
2. Open `http://127.0.0.1:7788/pr-triage.user.js` in the browser. Tampermonkey offers to install
   the script. Updates come from the same URL.

The server listens on `127.0.0.1` only. Every `/api` call needs the `X-PR-Triage: 1` header, and
the `Host` header must name the server. A web page cannot forge either, so other sites cannot
write proposals or decisions.

## Flow

**Round 1: decide.** The agent pushes proposals:

```
bin/pr-triage push payload.json
bin/pr-triage wait --repo owner/name --pr 214 --round 1     # blocks until you send
```

Open the pull request, and the cards load from the server. Every card has these parts:

- **Context — for you**: what the agent checked or measured. It is never posted.
- **How to fix**: the planned change, for a fix.
- **Reply to post**: the draft reply, rendered as markdown. **edit** opens it in a box that grows
  with the text, so nothing scrolls. The edited text wins.
- Four buttons: **Reply** (answer only), **Fix**, **Push back**, **Manual** (you handle it).
  The agent's proposal has a dashed outline.
- **Note for the agent**: a free-text instruction, e.g. "fix it, but differently: …".

**Auto items.** The agent marks an item `auto` when it has no doubt: a clear bug in round 1, a
plain "Done in <sha>" in round 2. An auto item counts as decided with the agent's proposal and
shows as one line. Pick another button to override it, or leave it.

**Send decisions** stays locked until every thread has a decision. It posts the decisions to the
server, where `pr-triage wait` returns them to the agent. After a send the cards fold to one line.

**Round 2: publish.** The agent makes the fixes, one commit per thread, and does not push yet.
It then pushes a round 2 payload with the final reply texts and the commits. The buttons are
**Publish**, **Hold** and **Manual**. After you send, the agent pushes and posts exactly the
replies marked **Publish**, with the text as you left it, and runs `pr-triage close`. A closed
pull request shows no cards; the panel offers to show them anyway.

## Review mode

For a pull request someone else wrote. The agent creates a pending review on GitHub with every
comment it would post, then pushes a payload with `"mode": "review"`, one item per pending
comment plus one general item for the review body:

```
build_payload.py --mode review --repo owner/name --pr 282 --round 1 --head <sha> items.json > payload.json
bin/pr-triage push payload.json
```

Each card shows the context for you and the comment as it will be posted. The buttons are
**Post**, **Revise** and **Drop**. **Revise** counts only once the note says what to change, and
**Send decisions** stays locked until then. You can also edit the text and pick **Post**; the
edited text is what gets posted.

The agent then drops the comments you dropped from the pending review, rewrites the revised ones
and pushes round 2 with the final texts: **Post** or **Drop**. After that send, the pending review
on GitHub holds exactly what you chose. Submitting it stays your move, on GitHub.

Pending comments show only in the **Files changed** tab. When GitHub gives them no
`discussion_r<id>` anchor there, the cards are in the side panel only.

## Without the server

**Load from clipboard** takes a payload from the clipboard or from the paste box. When the server
is not running, **Send decisions** copies the decisions to the clipboard instead, so you can
paste them to the agent.

## Where the cards show

- **Conversation tab**: under each thread, anchored on `#discussion_r<comment id>`. Threads that
  GitHub hides behind "Load more" get their card as soon as they load.
- **Side panel** (the button at the bottom right): every thread, including general items that
  have no thread. The page narrows next to it; **half screen** gives it half the window.

In the panel:

- **Filters** by state (All, To decide, Auto, Mine) and by decision.
- **‹ ›**, **j/k**, or **↑/↓** once an item is selected, move through the filtered list. The
  page scrolls to each thread. **Enter** expands a folded card.
- A thread GitHub has not loaded shows as **hidden**. Moving to it unfolds resolved threads,
  asks GitHub for the thread by its anchor, and clicks **Load more** until it appears.

The browser keeps your decisions per pull request in Tampermonkey storage, so a reload does not
lose them. A new payload for the same round keeps your decisions and edited replies.

## Payload

```
{"tool":"pr-triage","kind":"proposals","repo":"owner/name","pr":214,"round":1,"head":"<sha>",
 "mode":"reply|review",
 "items":[{"thread_id":"PRRT_…","comment_id":123,"author":"…","path":"…","line":1,
           "summary":"…","verdict":"reply|fix|pushback|manual","context":"…",
           "fix":"…","reply_en":"…","auto":false,"commits":["<sha>"]}]}
```

An item with `comment_id: null` is a general item and shows only in the panel. The fields
`summary_pl`, `context_pl` and `fix_pl` are read too, for payloads written by older versions.
Round 2 verdicts are `publish`, `hold` or `manual`. In review mode they are `post`, `revise` or `drop` in round 1 and `post` or `drop` in round 2; `mode` defaults to `reply`. Every text field is markdown. The page loads
`marked` and `DOMPurify` from jsDelivr through `@require`; without them it shows plain text.

The server stores files under `~/.local/share/pr-triage/<owner>/<name>/<pr>/` (override with
`PR_TRIAGE_HOME`). Pushing new proposals for a round deletes that round's decisions, because they
answer proposals that are gone.

## Test

```
npm test                                                     # helpers and server
PLAYWRIGHT=<path>/node_modules/playwright npm run smoke      # DOM, against a real server
```
