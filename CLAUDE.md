# CLAUDE.md

This file guides Claude Code (claude.ai/code), and human contributors, through this repository.

User-facing docs live in `README.md` and `docs/`. `docs/meta-research.md` holds the cited Meta API
findings behind the design decisions. Read it before "fixing" anything that looks like it
contradicts Meta's reference docs. `docs/troubleshooting.md` lists the gotchas already paid for.

## Commands

```bash
npm test           # 82 unit tests: node --test with native TS type-stripping, no build step
npm run typecheck  # tsc --noEmit
npm run dev        # local Worker on :8787 (needs .dev.vars; copy .dev.vars.example)
npm run dashboard  # local rule editor on 127.0.0.1:8790
npm run deploy     # wrangler deploy
npm run tail       # live production logs

# run a single test file
node --test test/rules.test.ts

# fire a correctly-signed fake webhook at a running Worker
node scripts/send-test.mjs instagram "LINK please"
node scripts/send-test.mjs facebook "what is the price?"
TARGET=https://<host>/webhook node scripts/send-test.mjs instagram LINK
```

Node >= 22.18 is required: the tests and the dashboard import `.ts` files directly. There is no linter
and no bundler config; wrangler compiles `src/index.ts` directly.

## Architecture

A single Cloudflare Worker. A comment on the owner's own Instagram or Facebook post triggers a DM
through Meta's *private replies* API, plus an optional public reply and (Facebook only) a like.

```
Meta webhook → verify signature → parse → find account → find rule → claim (KV) → cooldown → DM → public reply
```

It handles **many accounts**: any number of Instagram accounts and Facebook Pages. Each is an
`Account` (`{id, platform, label, token, appSecret?, igLoginMode?}`), and the list lives as JSON in the
KV `STATE` namespace under the key `accounts`. Meta's `entry.id` in the webhook selects which account,
and therefore which token, handles a comment.

The request path is in `src/index.ts`. The Worker returns `200 EVENT_RECEIVED` immediately and does
all Graph API work inside `ctx.waitUntil`, because Meta retries anything slow. A daily cron
(`scheduled`) refreshes Instagram tokens into KV.

- `src/verify.ts`: HMAC-SHA256 on the raw body, plus Meta's GET handshake. Called once per
  candidate secret: `META_APP_SECRET` for Facebook, `IG_APP_SECRET` for Instagram Login apps (which
  sign with their own, separate secret), and any per-account `appSecret`.
- `src/parse.ts`: normalises two very different payload shapes (Instagram `comments`, Page `feed`)
  into one `CommentEvent`, including `accountId` from `entry.id`.
- `src/accounts.ts`:
  - `validateAccounts`: pure, shared with the dashboard.
  - `loadAccounts`: reads KV with a 60s `cacheTtl`.
  - `findAccount`: routes on `entry.id`.
  - `accountToken`, `signingSecrets`.
  - When KV holds no accounts, it falls back to the single account in the `IG_USER_ID`/`IG_ACCESS_TOKEN`
    and `FB_PAGE_ID`/`FB_PAGE_TOKEN` secrets. That fallback is the Deploy-button quick start, so keep it.
- `src/rules.ts`: pure and heavily tested. `validateRules`, `resolve`, `findRule`, `pickVariant`,
  `textMatches`. No I/O, no env. `RuleError` carries `{section, index}`, not just an index, because
  the dashboard needs the section to highlight the right row.
- `src/handle.ts`: the side-effecting orchestration: self-comment guard → claim → cooldown → send.
- `src/graph.ts`: Graph API calls and `GraphError`, which classifies Meta's `code`/`error_subcode`
  pairs into `isNotReplyable` / `isRecipientRestricted` / `isPermissionError` / `isRateLimited`.
- `src/config.ts`: imports `rules.json` at build time into `RULES`. Rules ship inside the bundle,
  so changing them requires a redeploy (for Deploy-button users, a git push).
- `src/pages.ts`: the `/privacy`, `/terms` and `/data-deletion` HTML that Meta's app dashboard asks
  for regardless of access level. Interpolated from the `APP_NAME` / `CONTACT_EMAIL` / `LEGAL_NAME` vars.
  No JS and no external assets, because Meta's crawler runs neither.
- `dashboard/`: a local-only Node server, **never deployed**. It imports `findRule`, `pickVariant`
  and `validateRules` straight from `src/rules.ts`, and `validateAccounts` from `src/accounts.ts`, so
  the preview can't drift from production.

## Invariants that must not be broken

Each of these exists because breaking it causes a real, hard-to-reverse failure.

- **Every comment id is claimed in KV before any work happens.** Meta redelivers, and Facebook's
  `feed` fires more than once per comment. Only genuinely unexpected errors (Graph 5xx, network)
  release the claim. Classified `GraphError`s are terminal and must not be retried.
- **Self-comment guard in `handleComment`.** The Worker's own public replies arrive back as
  webhooks; without the guard a catch-all rule answers itself forever.
  - It checks the author against **every** configured account id, not just the one that received the
    webhook. Otherwise two accounts could answer each other.
  - The `DISABLE_SELF_COMMENT_GUARD` and `DISABLE_COOLDOWN` env vars bypass this guard and the
    cooldown check for manual testing. They are deliberate escape hatches, not a violation of this
    invariant, but they must be `"false"` (or unset) whenever real commenters can reach the Worker.
- **Signature verification on every POST.** Without it, anyone with the URL can make the Worker DM
  people as the account owner.
- **`pickVariant` is deterministic on the comment id.** A redelivery must never post a *different*
  reply variant.
- **When a rule has both `dm` and `publicReply`, the reply is held back if the DM failed.** Reply
  copy typically says "check your DMs", and posting it after a failed send is a public lie.
  - A `like` is **not** gated this way and fires first. It acknowledges the comment rather than
    claiming anything was sent, and Meta's like is idempotent, so re-liking on a redelivery is harmless.
- **`like` is Facebook-only, and `likeFacebookComment` must not be "corrected" away.** Meta's own
  reference for the comment `likes` edge claims the operation is unsupported. It is not; this was
  verified live (`docs/meta-research.md`, the comment-likes section).
  - Instagram genuinely has no equivalent, so `validateRules` rejects a like on an Instagram-only rule
    and `handleComment` skips it (with a log line) on mixed rules.
  - Meta refuses reaction *types* (LOVE/HAHA) for all apps. Don't add them.
- **First matching rule wins** (`findRule` uses `.find`). Order in `rules.json` is behaviour: a
  `match: "any"` catch-all must be last.
- **`/health` deliberately does not expose rules, keywords, account ids or labels.** It is a public
  endpoint. Counts only.
- **The Worker exposes no route that reads or writes credentials.** The dashboard manages accounts and
  secrets by shelling out to the local `wrangler` CLI (`kv key get/put`, `secret put`). Adding an admin
  endpoint would put the tokens behind whatever auth it invented; there is deliberately nothing to
  authenticate.
- **Account tokens never touch the filesystem or git.**
  - `writeAccounts` in `dashboard/server.mjs` pipes them through a `chmod 600` temp file that is
    deleted immediately. It's a temp file rather than an argv value because command lines are visible
    to `ps`.
  - `secret put` values go via stdin for the same reason.
- **Cron token refresh uses `Promise.allSettled` and a per-account KV key** (`igtok:<id>`). One
  account's dead token must not stop the others from refreshing, and the cron must not rewrite the
  shared `accounts` blob, which a human may be editing in the dashboard at the same time.

## Packaging for the Deploy to Cloudflare button

The repo is a template that the button copies into the user's own GitHub account. The button then
deploys it with Workers Builds. Keep these working:

- **The KV binding in `wrangler.toml` has no `id`.** Wrangler (>= 4.45) and the button create the
  namespace on first deploy, named `<worker name>-state`. The dashboard's `resolveNamespaceId()`
  finds it by that name, or by an `id` someone pinned in `wrangler.toml`.
- **`.dev.vars.example` is the list of secrets the button asks for.** Never put a `[vars]` name in it.
  A secret and a var with the same name break `wrangler deploy`.
- **`package.json` → `cloudflare.bindings`** holds the help text the deploy screen shows for each
  secret, var and binding. Keep it in step with `wrangler.toml` and `.dev.vars.example`.
- **`DRY_RUN` ships as `"true"`.** Vars must be changed in `wrangler.toml` and committed; a deploy
  resets any var edited in the Cloudflare dashboard.
- The `deploy` script is what Workers Builds runs. There's deliberately no `build` script.

## Rules and the dashboard

`rules.json` is the source of truth: version-controlled, no database. `validateRules` returns
`{rules, errors}`. The dashboard blocks a save on any error, while `resolve` (the Worker path) logs
and drops the offending rule. A rule needs at least one of `dm`, `publicReply` or `like`. The default match
mode is `word`, because `contains` would fire on `somethingelse`. The `word` matcher hand-rolls a Unicode
boundary, because `\b` is ASCII-only and comments are full of emoji.

`rules.json` is **split per account**:

```json
{
  "defaults": { ... },
  "byAccount": { "main ig": [ ...rules... ], "shop page": [ ...rules... ] },
  "shared":    [ ...rules that apply to every account... ]
}
```

Keys under `byAccount` are an account's label **or** its id (label match is case-insensitive, id match
exact). `validateRules` flattens all `byAccount` sections first, then `shared`, and stamps each rule's
`accounts` field from its section. So `findRule` needs no section awareness, and for any one comment
that account's own rules are checked before the shared ones. Consequences worth knowing:

- **Ids only need to be unique within a section.** Every account can have its own `welcome`. The
  cooldown key is `cool:{platform}:{accountId}:{ruleId}:{authorId}`, so same-id rules on different
  accounts never share state.
- **A shared rule is overridden by reusing its id** in an account's section. The account's copy wins
  because it's checked first. That's intended, not a duplicate-id error.
- **A rule inside `byAccount` must not also set `accounts`.** That's a validation error, because
  silently picking one would hide a rule that looks like it should fire.
- **The old flat `rules: [...]` array still works**, treated as `shared` with each rule's own
  `accounts` scope honoured. Don't remove that path; it's what keeps an older `rules.json` valid.
- **A `byAccount` key matching no configured account can never fire.** The Worker just won't match it,
  and the dashboard flags it as an orphan tab. A renamed account label produces exactly this.

The dashboard has three tabs. Only one of them needs a deploy:

| Tab | Writes | Deploy needed |
| --- | --- | --- |
| Rules | `rules.json` (in git) | yes: the **Commit & push** button (`git commit -- rules.json` + push) for a Git-connected Worker, else **Deploy** |
| Accounts | KV key `accounts` via `wrangler kv key put` | no |
| App keys | Worker secrets via `wrangler secret put` (allowlisted names only) | no |

The Rules tab has a second tab strip, one per account plus **Shared**, that switches which list is
being edited. Add, reorder and delete act on the visible list only. A rule's scope comes entirely from
the list it's in, so there is deliberately **no per-rule "accounts" input** in the editor. Adding one
back would give two overlapping controls for the same thing.

Stored tokens are returned to the browser masked (last 6 chars). A value still masked on save means
"unchanged": `mergeSecrets` in `dashboard/server.mjs` re-reads KV and restores it. Don't "simplify"
that away. Without it, saving a label change would wipe every token.

The dashboard binds to `127.0.0.1` and rejects non-loopback `Host` headers. It has no auth because
nothing on the network can reach it. It writes files and can trigger `wrangler deploy`, so never put
it behind a tunnel or reverse proxy.

## Meta access level

**No Meta App Review is needed as long as every account belongs to the operator.** The verdict turns
on *whose* accounts they are, not how many. An app that only touches accounts its own operator manages,
with no login flow, gets Standard Access automatically. An account belonging to someone else (a
client's Page) is Meta's "Tech Provider" scenario and needs Advanced Access + App Review. Citations
are in `docs/meta-research.md` §1.

## Dependency pin

`@cloudflare/workers-types` must stay on **v5**. A v4 pin makes `npm install` fail with `ERESOLVE`
against wrangler 4.120+.
