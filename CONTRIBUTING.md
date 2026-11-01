# Contributing

Thanks for helping! Bug reports, docs fixes, new transports and escalation
adapters are all welcome.

## Development

```bash
npm install
npm run check   # node --check on every JS file
npm test        # node:test suites — no network, no API key needed
```

Tests run against a fake OpenAI WebSocket and fake transports, so they are fast
and free. If you change call flow logic in `packages/core/realtime.js`, add or
adjust a case in `test/realtime.test.js`.

For a real end-to-end test you need an OpenAI key and one of the PBX options
from the README (the quickest is Asterisk + AudioSocket, or Twilio).

## Guidelines

- Keep the core transport-agnostic and business-agnostic. Anything specific to
  one company belongs in an agent (see `examples/`).
- Plain Node.js (CommonJS), no build step, minimal dependencies.
- New transport? Implement the `CallSession` interface documented at the top of
  `packages/core/realtime.js` and add a small test with a fake socket.
- New escalation adapter? `{ name, notify(handoff) }` in `packages/core/escalation/`,
  wired into `notifiersFromEnv()` only if it is generally useful.
- Update `.env.example`, the README table and `CHANGELOG.md` ("Unreleased") when
  you add configuration.
- **Never commit** real phone numbers, API keys, SIP credentials, recordings or
  transcripts, not even in tests. Use `+1 555 01xx` style numbers and
  `example.com` domains.

## Commit messages and PRs

Short imperative subject ("Add Slack notifier"), a body explaining *why* when it
is not obvious. Fill in the PR template checklist.

By contributing you agree that your contributions are licensed under the MIT
License.
