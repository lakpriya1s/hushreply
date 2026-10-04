# Setup guide

From nothing to "comment a keyword, get a DM", on your own Instagram account and/or Facebook Page.
Budget an hour the first time. Almost all of it is on Meta's side; the Cloudflare part is one button.

The order matters: you need values from Meta (two app secrets, tokens) before you deploy, and Meta
needs your Worker's URL before it will send webhooks. So: Meta app → tokens → deploy → webhooks →
test → go live.

Other docs: [rules.md](rules.md) (writing rules) · [dashboard.md](dashboard.md) (local editor,
several accounts) · [troubleshooting.md](troubleshooting.md) · [meta-research.md](meta-research.md)
(Meta API findings, with citations).

---

## Prerequisites

- **An Instagram professional account** (Business or Creator), and it must be **public**. A private
  account gets no comment webhooks at all.
- On that account, **Settings → Messages → Allow access to messages** turned on. Without it every DM
  is refused.
- **A Facebook Page you admin**, if you want Facebook too. Either platform on its own is fine.
- **A Meta developer account**: [developers.facebook.com](https://developers.facebook.com).
- **A free Cloudflare account** and **a free GitHub account**. The Deploy button puts a copy of this
  repo in your GitHub and the Worker in your Cloudflare account. No credit card for either.

Limits worth knowing before you start:

- A private reply must be sent within **7 days** of the comment.
- Meta allows **one private reply per comment**, ever. HushReply treats "already replied" as done.
- Only comments on **your own** posts can be privately replied to.

> **Do this in a browser you're sitting at.** Meta's "Add account", "Generate token" and
> "Generate Access Token" buttons open OAuth popups. Popup blockers (and browser automation) block
> them silently: the button appears to do nothing.

---

## 1. Create the Meta app

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create app**.
2. Meta's app creation now asks for **use cases** rather than an app type. Pick the ones that match
   what you'll connect:
   - Instagram: **Manage messaging & content on Instagram**.
   - Facebook Page: **Manage everything on your Page**, **and also** add **Engage with customers on
     Messenger from Meta**. The second one is what unlocks `pages_messaging`, the permission that
     sends the DM. Without it, Facebook comments are matched but every DM is refused.
3. Open **App settings → Basic** and copy the **App secret**. This is `META_APP_SECRET`. It signs
   Facebook webhooks.
4. Make up a `VERIFY_TOKEN`: any random string. You'll paste it into Cloudflare and into Meta's
   webhook form, and the two must match.

   ```bash
   openssl rand -hex 16
   ```

You don't need App Review for this. See [App Review](#app-review) at the bottom.

---

## 2. Instagram

In your app's Instagram use case, open **API setup with Instagram login**.

1. Under **Generate access tokens** → **Add account**, log in to your Instagram professional account.
2. Grant `instagram_business_basic`, `instagram_business_manage_messages` and
   `instagram_business_manage_comments`.
3. Copy the **Instagram user ID** (digits only) → `IG_USER_ID`.
4. Copy the **access token** → `IG_ACCESS_TOKEN`. It's a 60-day long-lived token; the Worker
   refreshes it every day, so it doesn't expire as long as the Worker keeps running.
5. **On the same page**, copy the **Instagram app secret** → `IG_APP_SECRET`. It sits next to the
   "Instagram app ID", and it is **not** the App secret from step 1.

**Why two app secrets:** an app on Instagram Login signs its Instagram webhooks with the Instagram app
secret and its Facebook webhooks with the main one. If you only set `META_APP_SECRET`, every Instagram
webhook fails with `rejected: bad signature` while Facebook works fine. That's the most common setup
mistake. Full write-up: [meta-research.md §10](meta-research.md#10-instagram-login-apps-sign-webhooks-with-a-separate-app-secret).

**Don't mix up the app secret and the token.** They sit next to each other on that page. An app
secret is exactly 32 hex characters; a token is much longer. Pasting the secret as a token gets you
`Cannot parse access token` from Meta.

> **Instagram via a Facebook Page instead?** If your Instagram account is connected through
> *Instagram API with Facebook Login*, set `IG_LOGIN_MODE = "facebook"` in `wrangler.toml` and use
> the Page access token from step 3 as `IG_ACCESS_TOKEN`. Token refresh is skipped, since Page
> tokens don't expire. Most people should stay on the default, `"instagram"`.

---

## 3. Facebook Page

Facebook needs your **Page id** and a **Page access token that never expires**.

### Facebook Page token

Three steps, using [Graph API Explorer](https://developers.facebook.com/tools/explorer/).

1. Select your app, click **Generate Access Token**, and grant `pages_show_list`,
   `pages_read_engagement`, `pages_manage_engagement`, `pages_manage_metadata` and `pages_messaging`.
   This gives you a short-lived *user* token.

   > **`Invalid Scopes: pages_read_user_content`?** The Explorer requests the use case's whole
   > recommended permission set, not just what you ticked. Add `pages_read_user_content` to the
   > *Manage everything on your Page* use case (so it shows "Ready for testing"), then generate
   > again. HushReply doesn't use it; the Explorer just insists on it.

2. Exchange it for a long-lived user token. `<APP_ID>` and `<APP_SECRET>` are from
   **App settings → Basic**:

   ```bash
   curl -s "https://graph.facebook.com/v26.0/oauth/access_token\
   ?grant_type=fb_exchange_token\
   &client_id=<APP_ID>\
   &client_secret=<APP_SECRET>\
   &fb_exchange_token=<SHORT_LIVED_USER_TOKEN>"
   ```

3. List your Pages with it. A Page token derived from a long-lived user token never expires:

   ```bash
   curl -s "https://graph.facebook.com/v26.0/me/accounts?access_token=<LONG_LIVED_USER_TOKEN>"
   ```

   For your Page, `data[].id` is `FB_PAGE_ID` and `data[].access_token` is `FB_PAGE_TOKEN`.

**Copy the id carefully.** Ids are digits only. A trailing dot or space from a copy-paste means
webhooks for that Page don't match it.

### Subscribe the app to the Page

This is the step everyone misses. Without it the webhook is configured but **never fires**:

```bash
curl -X POST "https://graph.facebook.com/v26.0/<PAGE_ID>/subscribed_apps" \
  -d "subscribed_fields=feed" \
  -d "access_token=<PAGE_TOKEN>"
```

Check it stuck. You want `"subscribed_fields": ["feed"]` in the response:

```bash
curl -s "https://graph.facebook.com/v26.0/<PAGE_ID>/subscribed_apps?access_token=<PAGE_TOKEN>"
```

---

## 4. Deploy

### Path A: the Deploy to Cloudflare button (no terminal)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lakpriya1s/hushreply)

The button:

1. **Copies this repo into your GitHub account.** That copy is now your config: `rules.json` and
   `wrangler.toml` live there.
2. **Creates the Worker and its KV namespace** in your Cloudflare account. Keep the default
   namespace name.
3. **Asks for the secrets** listed in `.dev.vars.example`, with a short description of each:

   | Secret | From | Required |
   | --- | --- | --- |
   | `META_APP_SECRET` | §1 step 3 | yes |
   | `IG_APP_SECRET` | §2 step 5 | for Instagram |
   | `VERIFY_TOKEN` | §1 step 4 | yes |
   | `IG_USER_ID`, `IG_ACCESS_TOKEN` | §2 | for Instagram |
   | `FB_PAGE_ID`, `FB_PAGE_TOKEN` | §3 | for Facebook |

   Leave a platform's pair blank to skip that platform. The four account values are the quick-start
   path for **one** Instagram account and **one** Page. For more, see [dashboard.md](dashboard.md).

4. **Sets up Workers Builds.** Every push to your copy's `main` branch redeploys the Worker. That's
   how you change rules and settings later, without a terminal.

When it finishes you get a URL like `https://hushreply.<your-subdomain>.workers.dev`. Open
`/health` on it:

```json
{ "ok": true, "dryRun": true, "instagram": true, "facebook": true, "accountCount": 2, "ruleCount": 2 }
```

`instagram` / `facebook` say whether an account for that platform is configured. `/health` never
shows ids, labels or keywords; it's public.

### Path B: the CLI

```bash
git clone https://github.com/lakpriya1s/hushreply.git
cd hushreply
npm install
npx wrangler login
npx wrangler deploy          # first deploy creates the KV namespace (or asks which to use)

npx wrangler secret put META_APP_SECRET
npx wrangler secret put IG_APP_SECRET
npx wrangler secret put VERIFY_TOKEN
npx wrangler secret put IG_USER_ID          # skip the pairs for a platform you don't use
npx wrangler secret put IG_ACCESS_TOKEN
npx wrangler secret put FB_PAGE_ID
npx wrangler secret put FB_PAGE_TOKEN
```

Each `secret put` prompts for the value, so it never lands in your shell history. With this path,
changes to `rules.json` or `wrangler.toml` go live with `npx wrangler deploy` (or `npm run deploy`).

### Changing secrets later

Secrets can be changed any time without a redeploy: **Cloudflare dashboard → Workers & Pages → your
Worker → Settings → Variables and Secrets**. Or the local dashboard's **App keys** tab, or
`npx wrangler secret put <NAME>`.

---

## 5. Connect webhooks

Meta needs to know where to send comments. The callback URL is your Worker's `/webhook` path:

```
https://hushreply.<your-subdomain>.workers.dev/webhook
```

### Instagram: two subscriptions, both required

1. **App-level.** In the Instagram use case's webhook settings (on the **API setup with Instagram
   login** page): callback URL as above, verify token = your `VERIFY_TOKEN`, then subscribe to the
   **`comments`** field.
2. **Account-level.** The "webhook subscription" toggle next to your account in the same panel may
   only cover messaging. Subscribe the account to `comments` explicitly, with the Instagram token:

   ```bash
   curl -X POST "https://graph.instagram.com/v26.0/<IG_USER_ID>/subscribed_apps\
   ?subscribed_fields=comments,messages&access_token=<IG_ACCESS_TOKEN>"
   ```

   And check it:

   ```bash
   curl -s "https://graph.instagram.com/v26.0/<IG_USER_ID>/subscribed_apps?access_token=<IG_ACCESS_TOKEN>"
   ```

On `IG_LOGIN_MODE = "facebook"`, make the same calls on `graph.facebook.com` with the Page token.

Missing either one looks identical: real comments produce no log activity at all, while a fake
signed webhook (§6) matches fine.

### Facebook Page

In the Page use case's webhook settings: object **Page**, same callback URL and verify token, then
subscribe to the **`feed`** field. Together with the `subscribed_apps` call from §3, that's everything.

### The handshake

When you save a callback URL, Meta immediately sends a GET request with your verify token. The Worker
answers it. If Meta says verification failed:

- **403**: the `VERIFY_TOKEN` in Cloudflare doesn't match what you typed into Meta (or it was saved
  blank).
- **500**: `VERIFY_TOKEN` isn't set on the Worker at all.

---

## 6. Test

`DRY_RUN` ships as `"true"`: the Worker logs every match and sends nothing. Test in this mode first.

**Watch the logs.** `wrangler.toml` enables Workers observability, so logs show up in the
**Cloudflare dashboard → your Worker → Logs**, no terminal needed. From a clone you can also stream
them with `npm run tail`.

**Comment on your own post** from a *different* account (your own account's comments are ignored by
the self-comment guard, see below). With the example `rules.json`, comment `LINK`. You want:

```
match rule=link actions=dm+reply platform=instagram account=… comment=… author=… [DRY_RUN]
```

What else you might see:

| Log line | Means |
| --- | --- |
| nothing at all | The webhook isn't reaching the Worker. Re-check §5, both Instagram subscriptions, or the Page `subscribed_apps` call. |
| `rejected: bad signature` | Wrong app secret. For Instagram, set `IG_APP_SECRET` (§2 step 5). |
| `no rule matched on account=… text="…"` | Webhook and account are fine; no rule's keyword matched. The line quotes the comment. |
| `no account configured for instagram:…` | The id Meta sent isn't one you configured. Copy it from the log into `IG_USER_ID` / `FB_PAGE_ID`. |

More in [troubleshooting.md](troubleshooting.md).

**Testing from your own account.** The self-comment guard ignores comments by any configured
account (it's what stops the Worker answering its own replies), and the cooldown stops a rule firing
twice for the same person within `cooldownHours`. For a solo test you can bypass both in
`wrangler.toml`:

```toml
# TESTING ONLY. Put both back to "false" before anyone else comments.
DISABLE_SELF_COMMENT_GUARD = "true"
DISABLE_COOLDOWN = "true"
```

Without the self-comment guard, an enabled catch-all rule can reply to its own replies forever.

**Fake webhooks, no real comments.** From a clone, `scripts/send-test.mjs` sends a correctly signed
fake comment. It exercises signature check, parsing and matching. It can't produce a real DM (the
comment id isn't real), so use it with `DRY_RUN = "true"`:

```bash
cp .dev.vars.example .dev.vars        # fill in at least META_APP_SECRET / IG_APP_SECRET
npm run dev                           # local Worker on :8787
node scripts/send-test.mjs instagram "hey, LINK please"
node scripts/send-test.mjs facebook "what's the price?"
node scripts/send-test.mjs instagram "nice post"      # should not match

# against the deployed Worker, signed with the real secret
TARGET=https://hushreply.<your-subdomain>.workers.dev/webhook \
  IG_APP_SECRET=<instagram app secret> \
  node scripts/send-test.mjs instagram LINK
```

---

## 7. Go live

In **your GitHub copy** (the one the Deploy button made), edit `wrangler.toml` in the browser:

```toml
DRY_RUN = "false"
APP_NAME = "Your brand"
CONTACT_EMAIL = "you@yourdomain.com"   # a real inbox; it's on your privacy page
LEGAL_NAME = ""                         # optional: the person or company responsible
```

Commit to `main`. Workers Builds redeploys within a minute or two, and `/health` shows
`"dryRun": false`. Comment your keyword from another account: a DM arrives, then the public reply.

**Change vars in `wrangler.toml`, not in the Cloudflare dashboard.** Vars edited in the dashboard are
reset to whatever `wrangler.toml` says on the next deploy, and every push is a deploy. Secrets are
different: they live only in Cloudflare and no deploy touches them.

With the CLI path, edit `wrangler.toml` locally and run `npm run deploy`.

Now write your own rules: [rules.md](rules.md).

---

## 8. Legal pages

Meta's app settings ask for a Privacy Policy URL, Terms of Service URL and data-deletion
instructions URL. The Worker serves all three, so there's nothing else to host:

| Route | Meta app settings field |
| --- | --- |
| `/privacy` | Privacy Policy URL |
| `/terms` | Terms of Service URL |
| `/data-deletion` | User data deletion → Data Deletion Instructions URL |

They're filled in from `APP_NAME`, `CONTACT_EMAIL` and `LEGAL_NAME`, so set those first (§7). They're
plain HTML with no JavaScript, because Meta's crawler doesn't run any. An instructions page is enough;
Meta accepts it instead of a deletion callback ([meta-research.md §3](meta-research.md#3-data-deletion--instructions-url-is-enough)).

---

## App Review

**Not needed, as long as every account is yours.** Meta's own *App Review for Instagram API* doc has
a table for this case: an app "only for a business I own or manage", with no login flow, gets
Standard Access and **App Review: Not required**. HushReply has no login screen and only touches
accounts you connected yourself. It was confirmed end to end with commenters who have no role on the
app, on both platforms, with no review submitted. Citations:
[meta-research.md §1](meta-research.md#1-do-you-need-app-review-for-your-own-account-no--corrected-2026-08-12).

**That flips if you run it for other people's accounts**, say a client's Page. That's Meta's "Tech
Provider serving multiple businesses" case, and it needs Advanced Access through App Review, plus
Business Verification. The number of accounts doesn't matter; whose they are does.

---

## Adding more accounts later

The four `IG_*` / `FB_*` secrets cover one account per platform. For more, use the local dashboard's
Accounts tab, which stores any number of accounts in KV: [dashboard.md](dashboard.md).

Each extra account still has to be wired up on Meta's side, the same as the first: connect it in the
app, subscribe its webhooks (§5), and for a Page, run the `subscribed_apps` call (§3). Adding it to
HushReply only tells the Worker which token to use.
