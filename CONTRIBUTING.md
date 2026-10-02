# Contributing

Pull requests are welcome. Before you open one:

- run `npm test` and, if you changed the userscript, the smoke test (see the README, Development);
- keep the runtime free of npm dependencies;
- a change to a payload field, a decision key or a mode lands in `lib/protocol.mjs`, the userscript's
  `SC_DECISIONS`, `docs/PROTOCOL.md` and the skills in the same pull request.

Every pull request needs the CI checks to pass and a review by the maintainer before it is merged.
CI for a pull request from a fork waits for the maintainer's approval before it runs.

Report security problems privately, as `SECURITY.md` describes.
