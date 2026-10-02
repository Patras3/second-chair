---
name: setup
description: Use when the user installs Second Chair, when its cards do not show on GitHub, or when second-chair doctor reports a problem.
---

# Set up Second Chair

1. Run `second-chair doctor` and show the user its table.
2. Fix each row that is not ok:
   - node: Node 22 or newer is needed.
   - gh: run `gh auth login`.
   - server: run `second-chair start`. If the port is taken, set `SECOND_CHAIR_PORT` and start again.
3. Browser, once:
   - Install Tampermonkey or Violentmonkey.
   - Chrome or Edge: open the extension's details page and turn on "Allow user scripts". On older versions turn on developer mode in `chrome://extensions` instead.
   - Open the userscript URL that doctor printed and confirm the install.
4. Ask the user to open any pull request on GitHub. A small "SC" pill at the bottom right means it works.
