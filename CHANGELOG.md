# Changelog

## 1.3.1

Changed:

- The respond skill has rules for replies. A reply does not open with "You are right" or "Agreed". When the reviewer read the text differently from what it meant, the reply says first what it meant, with the evidence. When the data says something different from the reviewer's claim, the reply gives the data, also when the change is made.

## 1.3.0

Added:

- The page says when the agent needs you in the terminal. The status line reads **Your turn in the terminal** with the agent's line, the pill says **needs you**, the spinner goes, the tab title starts with `(!)`, and a desktop notification goes out when you look elsewhere. `second-chair attention` sets it, a failed `publish` sets it, and so does the plugin's new `Notification` hook when Claude Code waits for input or a permission. Typing in that session, the next push, a publish or a close clears it.
- A desktop notification when the agent's next round arrives while you look elsewhere.
- `second-chair hook` for the agent's hooks, and `POST /api/session`. `push`, `wait` and `get` tell the server which agent session works on a pull request (`SECOND_CHAIR_SESSION` or `CLAUDE_CODE_SESSION_ID`).

Changed:

- A hidden tab no longer stops polling. It asks every 30 seconds, so a notification can reach you.
- The skills run `second-chair attention` before they stop to ask you something while a round is with the agent.

## 1.2.0

Added:

- Round 2 of respond mode shows the commits that `git push` will send. Each card shows the commits its reply cites, with **View changes**. The side panel has a folded row, **Push will send**, with the number of commits and lines.
- A diff popup over the page: all commits as one diff, or one commit at a time. Large files start folded. Esc, ✕ and a click outside close it. The key `d` opens it.
- Notes on the code. Under each file you can leave a note for the agent and mark lines by clicking their numbers. A note locks the replies that cite the commit as **Change code**. The agent changes the code and sends round 2 again. Deleting the note unlocks the reply.
- `second-chair build --base SHA` adds the commits between the pull request's head on GitHub and the local HEAD.

Changed:

- `publish` refuses while a reply is **Change code**, and when the pull request's head on GitHub is not the head you approved.

## 1.1.5

Added:

- A live tour. The first time you see the cards of a mode and round, Second Chair asks whether to show it: **Show me** or **Not now**. The page then dims, and one part of Second Chair at a time lights up, with a short note and **Next**, **Back** and **Skip**. Each tour has four to eight steps. The **?** in the side panel starts it again.
- A status line under the panel header says whose turn it is and what happens next.
- After you send a round, the panel waits for the agent and shows when the agent picked your decisions up. The next round opens by itself, without a reload.
- **Edit and send again** while the agent works on a round. `second-chair push` refuses the next round until the agent read the change, so the agent always sees it.
- **Revise** in round 2, in both modes. The agent writes a new version, and round 2 comes back. Nothing is posted until you approve it.
- Review mode: a **Your review** block with the review body and, in round 2, the submit choice: **Leave as draft**, **Comment**, **Approve** or **Request changes**. `publish` submits the review with your choice. The send stays locked, with the reason, when GitHub would refuse the choice.
- A second review pass updates the comments of the first pass instead of adding new ones. `second-chair pending` says who wrote each comment, and `second-chair draft` refuses a second comment on lines that already have one (`--allow-same-line` lets a separate point through).
- After the final round, the panel shows what reached GitHub, with links.

Changed:

- In review mode a card under its own pending comment no longer repeats the comment. The caption says **Comment above**, and **✎ Edit** opens the text. The card shows the text when it differs from the comment on GitHub: the agent's rewrite, or your edit. In the side panel the card still shows the text.
- The work on a pull request is done when the agent closes it after `publish`, not at the final send. Until then the panel says that the agent publishes.
- Review mode labels **Post** as **Keep**, because nothing becomes public before the review is submitted.
- Every button explains itself in its tooltip.
- **Write** is now **✎ Edit**, and a click on the shown text starts editing too. **Undo my edits** brings the agent's text back. Each caption says when the text goes out.
- A pull request without proposals keeps the panel closed. When you open it, it says which command starts Second Chair.
- `second-chair push` links the Files changed tab for a review.
- The panel header names the mode as the commands do: Respond or Review.

Fixed:

- **Write**, **expand**, **jump** and the arrows did nothing on the Files changed tab. GitHub's own code took the clicks. Every control is now a button, and Second Chair handles its clicks first.
- Review rows said "general" next to every comment.
- After a send, the text could still be edited, and the edit went nowhere.
- The filter bar in the side panel no longer shows a scroll bar of its own.

## 1.0.1

- In a thread with replies, the card now shows after the last comment. It used to show after the first comment, so it looked like an answer to that comment.

## 1.0.0

First public release.
