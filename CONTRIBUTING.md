# Contributing to HushReply

Thanks for helping. Bug reports, docs fixes, new rule features and Meta API findings are all
welcome.

## Before you start

- **Open an issue first** for anything bigger than a small fix, so we can agree on the approach
  before you spend an evening on it.
- **Read [CLAUDE.md](CLAUDE.md).** Despite the name, it's the architecture guide for everyone. Its
  **"Invariants that must not be broken"** section lists the rules that keep HushReply from
  double-DMing people, answering itself forever, or letting strangers send DMs as you. A PR that breaks
  one won't be merged, however tidy it is.
- **Meta's reference docs are sometimes wrong.** If you're about to "fix" something to match them, check
  [docs/meta-research.md](docs/meta-research.md) first. Several of its findings were verified against
  the live API precisely because the docs disagreed.

## Development

Node **22.18 or newer** is required: the tests and the dashboard import `.ts` files directly.

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in any values; they're only used locally
npm test                          # unit tests, no build step
npm run typecheck
npm run dev                       # local Worker on http://127.0.0.1:8787
node scripts/send-test.mjs instagram "LINK please"   # signed fake webhook
npm run dashboard                 # local rule editor on http://127.0.0.1:8790
```

`DRY_RUN` is `"true"` in `wrangler.toml`, so local runs log what they *would* send.

## Pull requests

- Keep each PR focused on one thing.
- Add or update tests. `src/rules.ts` and `src/accounts.ts` are pure and easy to test, so keep logic there
  rather than in `handle.ts` where it needs I/O.
- `npm test` and `npm run typecheck` must pass. CI runs both.
- If you add a secret or var, update all three of `wrangler.toml`, `.dev.vars.example` (secrets only)
  and `package.json` → `cloudflare.bindings`. The Deploy button reads them.
- Update the docs in the same PR when behaviour changes.
- Never commit real tokens, app secrets, account ids or a `.dev.vars` file.

## License

By contributing, you agree that your contributions are licensed under the
[AGPL-3.0](LICENSE), the same license as the project.
