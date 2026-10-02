# Security

## Report a vulnerability

Please do not open a public issue for a security problem. Use **Report a vulnerability** on the
repository's Security tab. Only the maintainer sees the report.

Include what you did, what happened, and the version (`second-chair doctor` prints it). You get an
answer within a week.

## What counts

Second Chair runs a server on your machine and draws cards on github.com. These are in scope:

- a web page or another site that can read or write the local server;
- text in a payload, a review comment or a pull request that runs script, injects controls or changes
  a decision in the userscript;
- anything that posts, edits or submits on GitHub without the user's decision in the browser;
- `draft` or `publish` losing or changing a comment the user wrote;
- files written outside the data directory.

Bugs in GitHub, `gh`, Claude Code or the user script manager are out of scope. Report them there.

## Supported versions

Only the latest release gets fixes.
