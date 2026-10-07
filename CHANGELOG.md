# Changelog

## Unreleased

Added:

- A guide opens in the side panel the first time Second Chair runs. It says who does what, what the two rounds are, and what each button does, for both modes. The **?** in the panel opens it again.
- A status line under the panel header says whose turn it is and what happens next.
- After you send a round, the panel waits for the agent and shows when the agent picked your decisions up. The next round opens by itself, without a reload.
- **Edit and send again** while the agent works on a round. `second-chair push` refuses the next round until the agent read the change, so the agent always sees it.
- **Revise** in round 2, in both modes. The agent writes a new version, and round 2 comes back. Nothing is posted until you approve it.
- Review mode: a **Your review** block with the review body and, in round 2, the submit choice: **Leave as draft**, **Comment**, **Approve** or **Request changes**. `publish` submits the review with your choice. The send stays locked, with the reason, when GitHub would refuse the choice.
- A second review pass updates the comments of the first pass instead of adding new ones. `second-chair pending` says who wrote each comment, and `second-chair draft` refuses a second comment on lines that already have one (`--allow-same-line` lets a separate point through).
- After the final round, the panel shows what reached GitHub, with links.

Changed:

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

## 1.0.1

- In a thread with replies, the card now shows after the last comment. It used to show after the first comment, so it looked like an answer to that comment.

## 1.0.0

First public release.
