# Troubleshooting

Start with the logs: **Cloudflare dashboard → your Worker → Logs**, or `npm run tail` from a clone.
Almost every outcome writes one line, and that line usually names the cause. Find your symptom below.

Other docs: [setup.md](setup.md) · [rules.md](rules.md) · [dashboard.md](dashboard.md) ·
[meta-research.md](meta-research.md)

---

## Nothing shows up in the logs at all

Webhooks aren't reaching the Worker. In order of likelihood:

1. **Facebook: the Page isn't subscribed to the app.** The webhook can be configured perfectly and
   still never fire without `POST /{page-id}/subscribed_apps` with `subscribed_fields=feed`
   ([setup.md §3](setup.md#subscribe-the-app-to-the-page)). Check with a `GET` on the same URL.
2. **Instagram: one of the two subscriptions is missing.** Instagram needs **both** the app-level
   `comments` field in the webhook settings **and** the account-level
   `POST /{ig-user-id}/subscribed_apps?subscribed_fields=comments,messages`. The account toggle in
   Meta's dashboard may only cover messaging ([setup.md §5](setup.md#instagram-two-subscriptions-both-required)).
3. **Instagram: the account is private, or not a professional account.** Private accounts get no
   comment webhooks.
4. **Wrong callback URL.** It must end in `/webhook`:
   `https://hushreply.<your-subdomain>.workers.dev/webhook`.
5. **You're watching the wrong thing.** `wrangler tail` run from a background or sandboxed shell can
   show nothing while traffic is arriving. Run it in your own terminal in the foreground, or use the
   Cloudflare dashboard's Logs view.

Quick isolation: send a fake signed webhook with `scripts/send-test.mjs` (see
[setup.md §6](setup.md#6-test)). If that produces a log line and real comments don't, the Worker is
fine and the problem is on Meta's side (1-3 above).

---

## Webhook verification fails when saving the callback URL

| Response | Cause | Fix |
| --- | --- | --- |
| 403 | The `VERIFY_TOKEN` on the Worker doesn't match the one typed into Meta, or it was saved blank. | Set the same value in both places. |
| 500 | `VERIFY_TOKEN` isn't set on the Worker at all. | Add it: Cloudflare dashboard → Worker → Settings → Variables and Secrets, or `npx wrangler secret put VERIFY_TOKEN`. |
| timeout / unreachable | Wrong URL, or the Worker isn't deployed. | Open `https://hushreply.<your-subdomain>.workers.dev/health` in a browser. |

---

## `rejected: bad signature`

Every webhook is checked against Meta's HMAC signature, and this one didn't match any secret the
Worker knows.

- **Facebook works, Instagram never does, no matter how often you re-copy the secret.** Instagram
  Login apps sign Instagram webhooks with a **separate Instagram app secret**, found under
  **Instagram → API setup with Instagram login**, not App settings → Basic. Set it as `IG_APP_SECRET`.
  If only one platform's signature ever verifies, suspect a second secret before suspecting a typo.
  Details: [meta-research.md §10](meta-research.md#10-instagram-login-apps-sign-webhooks-with-a-separate-app-secret).
- **Everything fails.** `META_APP_SECRET` is wrong or from a different app.
- **One account fails, the others work.** That account belongs to a different Meta app. Put that app's
  secret in the account's *App secret* field on the dashboard's Accounts tab.

---

## A comment arrives, but nothing happens

The log line tells you which case it is.

| Log line | Meaning | Fix |
| --- | --- | --- |
| `no rule matched on account=… text="…"` | Webhook, signature and account are all fine. No rule matched the comment, which is quoted in the line. | Check the keyword and `match` mode ([rules.md](rules.md#match-modes)). `word` won't match `linkedin` for `link`. Check `platforms`, `mediaIds`, `exclude`, `includeReplies` and rule order (first match wins). Test it in the dashboard's Test box. |
| `match rule=… [DRY_RUN]` | Matched, and `DRY_RUN` is on, so nothing was sent. | Set `DRY_RUN = "false"` in `wrangler.toml` and deploy ([setup.md §7](setup.md#7-go-live)). |
| `skip cooldown rule=… user=…` | That person already triggered this rule within `cooldownHours`. | Working as intended. For your own testing, see [setup.md §6](setup.md#6-test). |
| `skip duplicate …` | Meta delivered the same comment again. Already handled. | Nothing; see [Duplicate deliveries](#duplicate-deliveries). |
| `no account configured for instagram:<id>` | The id Meta sent matches no configured account. | Copy the id from the log into `IG_USER_ID` / `FB_PAGE_ID`, or the account's row on the Accounts tab. |
| *(no line, your own comment)* | The self-comment guard ignores comments by any configured account. | Comment from another account, or see [setup.md §6](setup.md#6-test) for the testing-only switch. |
| `rule "…" (#n in …) skipped: …` at startup | That rule in `rules.json` is invalid and was dropped. | Fix what the message says. The dashboard refuses to save invalid rules, so use it for edits. |

If the comment matched but the account id differs from the only configured account for that platform,
the Worker uses that account anyway and warns: `does not match the only configured … account — using
it anyway. Fix the id.` It works, but it will stop working when you add a second account. Fix the id.

---

## Matched, but no DM

`DRY_RUN` off and a `match` line logged, but no DM: the next line explains why. Meta's `code` and
`subcode` are always included; they're the only reliable way to tell errors apart, since Meta
translates the message text.

| Log line | Meta code | Meaning |
| --- | --- | --- |
| `dm skipped, comment not replyable` | `10900`, `100/2534025`, `100/2534014` | The comment was already privately replied to (Meta allows **one** private reply per comment, ever), is older than **7 days**, was deleted, or its author can't be resolved. Final; nothing to fix. |
| `dm skipped, recipient blocks message requests` | `10903/1893049` | The commenter's privacy settings. Nothing you can fix. |
| `DM REFUSED on account=…` | `200/2534066`, `200/2534041`, `10904/1893050`, `3`, `10`, `100/33` | Permissions. `2534066`: the token lacks the messaging permission (regenerate it with the scopes in [setup.md](setup.md)). `2534041`: *Allow access to messages* is off on the Instagram account. `1893050`: the Page has messaging turned off. Facebook with `pages_messaging` missing: add the **Engage with customers on Messenger** use case. |
| `TOKEN INVALID for account=…` | `190`, `102`, HTTP 401 | The token expired or was revoked. Paste a fresh one: the Accounts tab, or update `IG_ACCESS_TOKEN` / `FB_PAGE_TOKEN` in Variables and Secrets. No redeploy needed. |
| `DM rate limited, dropping` | `613`, `4`, `32` | Meta throttles messaging per account, scaling with recent conversation volume. Viral posts hit it. The DM is dropped, not retried. |

The public reply is **held back** when a rule's DM fails (`public reply held back: dm did not land`),
because the reply usually says "check your DMs" ([rules.md](rules.md#honest-replies)). A `like` still
happens.

**`Cannot parse access token`** (code `190`): the value isn't a token at all. Almost always the
32-character **Instagram app secret** pasted into the token field. They sit next to each other on
Meta's setup page. The dashboard refuses a 32-character hex value as a token for this reason.

**A Page id with a trailing dot or space** never matches a webhook. Ids are digits only; the dashboard
rejects anything else on save.

---

## The public reply posts but the like doesn't, or vice versa

- `like skipped on instagram` is expected. Instagram has no API for liking a comment
  ([rules.md](rules.md#likes)).
- `like failed: …` on Facebook usually means the Page token lacks `pages_manage_engagement`.
- `public reply failed: …` carries Meta's error. A like or reply failure never blocks the DM.

---

## Instagram stops working after about two months

Instagram long-lived tokens **expire after 60 days** and can't be revived once expired; you have to
generate a new one. The Worker's daily cron (04:17 UTC) refreshes every Instagram Login token so this
doesn't happen while it's running. Check the logs for `instagram token refresh failed for …`.

- **The first refresh after you paste a new token may fail.** A token must be at least 24 hours old
  to refresh. Harmless; the next day's run succeeds.
- **Facebook Page tokens and Instagram-via-Facebook-Login accounts** don't expire and aren't refreshed.
- If the token already expired: generate a new one ([setup.md §2](setup.md#2-instagram)) and replace
  it.

---

## Duplicate deliveries

Meta retries webhooks, and Facebook's `feed` field can fire more than once for the same comment. Each
comment id is claimed in KV for 7 days **before** any work happens, so repeats are dropped
(`skip duplicate`). You should never get two DMs for one comment. A claim is released only on an
unexpected failure (a Meta 5xx or a network error) so that Meta's retry can try again. Classified
refusals, like the ones above, are final.

If someone *does* get two DMs, check that the Worker has a KV namespace bound as `STATE`
(Worker → Settings → Bindings).

---

## Hitting the free-tier limit

Cloudflare's free plan allows **1,000 KV writes a day**, and that's the first limit HushReply reaches:

| What arrives | KV writes |
| --- | --- |
| A comment that matches a rule | 1, or 2 when the rule has a cooldown |
| A comment that matches nothing | 0 |
| A redelivery of a comment already handled | 0 |

So about **500 matching comments a day** with cooldowns on, and unmatched comments are free. Past the
limit, KV writes fail until 00:00 UTC. Options: the Workers Paid plan ($5/month) raises the limits a
long way, or set `cooldownHours: 0` on rules that don't need one.

Meta's own messaging rate limit (`613`) is the other ceiling, and it's per account.

---

## Works for you but not for other people

HushReply doesn't need App Review when every account is yours. It was verified end to end with
commenters who have no role on the app. If DMs work for your test accounts but others get
`DM REFUSED`, check the app's permissions and mode in Meta's app dashboard, and read
[meta-research.md §1](meta-research.md#1-do-you-need-app-review-for-your-own-account-no--corrected-2026-08-12)
and [§5](meta-research.md#5-live-mode-sequencing--get-this-wrong-and-you-lock-yourself-out).
If the account belongs to someone else, App Review *is* required.

---

## Meta's docs say something different

They're sometimes wrong, in both directions. The comment `likes` reference says the operation isn't
supported; it works. `/{comment-id}/private_replies` still has a live-looking reference page; it was
removed after Graph API v3.2 and answers with a misleading `code=100 subcode=33` permissions error.
HushReply sends Facebook private replies the current way: `POST /{page-id}/messages` with
`recipient: {comment_id}`. Trust a call against your real account over the reference docs.
[meta-research.md §11-12](meta-research.md) has the details.

Testing an endpoint yourself? A made-up object id can't tell you whether an endpoint exists: Meta
answers "does not exist, cannot be loaded due to missing permissions, or does not support this
operation" for a bad id, even on endpoints that work. Use a real id the same token can already `GET`.

---

## Local development

| Symptom | Fix |
| --- | --- |
| `npm install` fails with `ERESOLVE` | `@cloudflare/workers-types` must stay on v5 for wrangler 4.120+. Don't pin v4. |
| A lone `401: Unauthorized` from a wrangler command | Wrangler's login token expired. Run the command again; the failed call refreshes it. Still failing: `npx wrangler login`. |
| The dashboard serves old behaviour after an edit | A previous `npm run dashboard` is still running on 8790. Stop it and start again. |
| `npm test` can't import `.ts` files | Node is older than 22.18. |
