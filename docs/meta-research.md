# Meta API research notes

Findings from researching Meta's official docs for this project, with citations. Recorded because
several of these are non-obvious, spread across pages that contradict each other, or cost a rejection
cycle to learn.

Researched 2026-08-11 against Graph API **v26.0**, corrected and extended 2026-08-12 after live
end-to-end testing. Meta moves things; re-check before relying on anything here.

---

## 1. Do you need App Review for your own account? No — corrected 2026-08-12.

This is the question the whole project hung on for most of its life, and the earlier version of this
section concluded "yes" based on the Webhooks page's Advanced-Access language. **That conclusion was
wrong.** Live testing (real webhook delivery + real DM sent to a genuine third party with *zero* role
on the app, on both Instagram and Facebook) directly contradicted it, which sent us back to find the
actual authoritative source.

The definitive answer is Meta's own **"App Review for Instagram API"** doc
(https://developers.facebook.com/documentation/instagram-platform/app-review, updated Jan 21 2025),
which has an explicit table:

| Development scenario | Login type | Access level | App Review |
| --- | --- | --- | --- |
| My app is only for a business I own or manage. | No login or Instagram Login | Standard Access | **Not required** |
| My app is only for a business I own or manage. | No login or Facebook Login | Standard Access | **Not required** |
| I am a Tech Provider and my app serves multiple businesses. | Instagram/Facebook Login | Advanced Access | Required |

This app has no login flow at all and only ever touches accounts the developer owns — it is exactly
the first row. Confirmed by the general
[Access Levels](https://developers.facebook.com/docs/graph-api/overview/access-levels/) doc: "Standard
Access grants access to assets and data that a developer's business or anyone with a role on their app
owns... without having to go through App Review." The commenter receiving the private reply is never an
"app user" in Meta's model — they never log in or grant anything — so their lack of a role on the app is
irrelevant. What matters is that the *asset* (the Page, the IG account, the comment thread on it) is
owned by the developer.

**Why the old reasoning seemed right but wasn't:** the Webhooks page's "Advanced Access required for
`comments` notifications" language and the n8n thread describing exactly that symptom both appear to
describe the **Tech Provider / multi-business** row of the table above, not the single-owner row. At the
time this doc was first written, the two real bugs below (§10, §11) were *also* blocking everything, so
every test looked consistent with "needs Advanced Access" — there was no clean signal to separate "needs
review" from "code is broken." Once both bugs were fixed, delivery and sending both worked for a
non-tester stranger immediately, with no review, confirming the table above rather than the earlier
webhook-page reading.

**Practical takeaway:** if this app is ever extended to serve *other* people's Pages/IG accounts (not
just the developer's own), this conclusion flips — that's the Tech Provider row, and Advanced Access +
App Review becomes required again.

## 2. Business Verification is the real gate

Advanced Access requires it. Meta accepts [five document
types](https://saveoffice.io/blog/meta-business-verification-documents): articles of incorporation,
business registration/license, government business tax document, business bank statement, or a utility
bill (address only — not valid for the legal name).

Sole proprietors without registered business activity are told to contact support for case-by-case
handling — a slow, uncertain path. **With a registered business this is a paperwork afternoon.**

Also: Business Verification is not permanently valid. Meta can require re-verification if business
name, domain, or ownership changes.

## 3. Data deletion — instructions URL is enough

Meta's own text: developers must specify "either a data deletion **callback instruction URL** or a
**callback URL**."
([docs](https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback))

So a static page satisfies it — no `signed_request` parsing. That's what this project does.

If you ever do need the callback, the contract is:

1. Meta POSTs a form param `signed_request`.
2. Format: `<base64url signature>.<base64url JSON payload>`.
3. Verify: split on `.`, base64url-decode both, confirm `algorithm === "HMAC-SHA256"`, recompute
   `HMAC-SHA256(raw_payload_segment, app_secret)` — using the **raw undecoded payload string** as the
   message, output as raw bytes — and compare in constant time.
4. Payload contains `algorithm`, `issued_at`, `expires`, `user_id`.
5. Respond 200 with `{"url": "https://…/status?id=abc", "confirmation_code": "abc"}`.

**Caveat:** this contract is documented at the general Meta-platform level, originally for classic
Facebook Login. Research could not confirm Meta actually invokes it for apps using Instagram API with
Instagram Login. Another reason the instructions URL is the safer choice.

**Deauthorize callback URL: optional.** The Instagram-Platform-specific doc page 404s, suggesting it may
be a legacy Facebook Login concept. Skipped here.

## 4. Screencast requirements

From Meta's [App Review Submission
Guide](https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review/submission-guide):

- Record at 1080p+, but first reduce monitor width to **≤1440px** so UI is legible at review scale.
- **Omit audio** — "our reviewers will not listen to it." Use on-screen captions instead. Several
  third-party guides wrongly claim voiceover is expected; trust the first-party text.
- English UI, or add captions explaining anything not self-explanatory.
- Show the **complete end-to-end flow** for each permission, exercising the actual API call it unlocks.
- For messaging, show the **native Instagram Direct UI**. Screenshots of your own custom interface are
  explicitly insufficient.
- No official length limit found. "Under 3 minutes" is widely repeated third-party advice, unverified
  against first-party docs.

### Most-cited rejection reasons

1. Requesting permissions not actually demonstrated in the screencast.
2. **Reviewer unable to access or test the app** — automatic rejection of the whole submission. Acute
   risk for a single-tenant app: provide step-by-step test instructions.
3. Generic privacy policy that doesn't name the specific Meta/Instagram data collected.
4. Vague or copy-pasted per-permission justifications.
5. Feature shown in the screencast not fully functional.
6. For messaging: not showing the message actually arriving in the real Instagram Direct inbox.

Sources: [Rejection guides](https://developers.facebook.com/docs/app-review/support/rejection-guides/) ·
[Permissions reference](https://developers.facebook.com/docs/permissions/)

## 5. Live mode sequencing — get this wrong and you lock yourself out

Live mode is **required** for webhooks to fire at all. But Meta's guidance is to switch to Live **only
after** App Review completes, because:

> "Apps in Live mode can only request approved permissions from app users, and only approved features
> will be active for app users. This restriction applies to everyone."

Flipping early therefore breaks the app for **everyone including accounts with a role on it** — your own
testing stops working.

Correct order: build in Development mode with your accounts as Testers (Standard Access, fully
functional for you) → submit for Advanced Access → switch to Live after approval.

Switching to Live also requires Privacy Policy URL, Terms of Service URL, App Icon and App Category to
be filled in.

Sources: [App
Dashboard](https://developers.facebook.com/docs/development/create-an-app/app-dashboard/) · [Live mode
blog post](https://developers.facebook.com/blog/post/2019/09/23/live-mode-for-production-use/)

## 6. Pre-submission requirement people miss

Meta checks for **at least 1 successful API call per requested permission**, within roughly 30 days of
submission. You cannot submit for a permission you haven't actually exercised. Run the flow in
Development mode first and confirm each call in `wrangler tail`.

## 7. Token lifetimes

- **Instagram long-lived tokens: 60 days.** Refresh via
  `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=<token>`,
  which resets the 60-day clock.
- A token must be **≥24h old** to be refreshable.
- **A fully expired token cannot be refreshed** — it forces full re-authentication. Best practice is
  refreshing every 30–45 days; this project's daily cron beats that comfortably.
- **Facebook Page tokens derived from a long-lived user token do not expire.**

Sources: [refresh_access_token](https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token/) ·
[access_token](https://developers.facebook.com/docs/instagram-platform/reference/access_token/)

## 8. Ongoing obligation: annual Data Use Checkup

Must be resubmitted yearly to recertify compliance. **Missing the deadline disables the app's data
access with no grace period.** For an unattended Worker this is the most likely silent-failure mode a
year out. The app's contact email must be monitored.

App Review approval itself is durable — no routine resubmission — unless you materially change how a
permission is used, Meta changes policy, or the DUC lapses.

## 9. Private reply error codes (real, not guessed)

Observed codes for `private_replies` / comment-triggered messaging, per an [error-code
compilation](https://instantdm.com/instagram-api-error-codes-for-dm-automation):

| Code / subcode | Meaning |
| --- | --- |
| `100` / `2534025` | Comment invalid for private reply — >7 days old, already replied, or deleted. **~33% of all errors** |
| `100` / `2534014` | "The requested user could not be found" — the comment id can't be resolved to a messageable user. **Confirmed first-hand 2026-08-12**, by POSTing a deliberately bogus `comment_id` to `/{ig-id}/messages` on the live account. Terminal, same as `2534025` |
| `10900` | Activity already replied to — exactly one private reply per comment |
| `10903` / `1893049` | This user can't reply to this activity (recipient restrictions) |
| `200` / `2534066` | Access token lacks the IG private-reply permission scope |
| `200` / `2534041` | Account owner has disabled access to Instagram direct messages |
| `10904` / `1893050` | Page has messages disabled in settings |
| `100` / `33` | Generic "object does not exist / missing permissions" — **also what a POST to the deprecated `/private_replies` edge returns.** Don't assume this always means missing Advanced Access; check the endpoint being called first (§11). |
| `613` | Rate limited. Per-account, scales with recent conversation volume — viral posts hit this |

These are wired into `src/graph.ts` as `isNotReplyable`, `isRecipientRestricted`, `isPermissionError`
and `isRateLimited`, and pinned by `test/graph.test.ts`. Earlier versions of that file used **guessed**
subcodes; if you extend the classification, verify codes against real responses rather than inferring
them.

**Meta localises these error messages.** The `2534014` probe came back as
"リクエストされたユーザーが見つかりません。" — nothing in the request asked for Japanese. So any logic that
matches on the English wording will silently stop working. Classify on the `code`/`error_subcode` pair
only; the message regex left in `isNotReplyable` is a last-resort fallback, not a check to extend.

**Why the classification matters beyond logging:** an unclassified error is treated as unexpected,
which *releases the KV claim* so a redelivery can retry. For a terminal refusal that means Meta
re-attempts a send that cannot succeed. `test/graph.test.ts` asserts the terminal/unexpected split
directly for this reason.

## 10. Instagram Login apps sign webhooks with a separate app secret

When `IG_LOGIN_MODE="instagram"` (Instagram API **with Instagram Login**, as opposed to Instagram
*via* Facebook Login), the app has **two distinct App Secrets**:

- The main Facebook App Secret, under **App Settings → Basic**. This signs `page`/`feed` webhooks.
- A separate **Instagram app secret**, under **Instagram → API setup with Instagram login**, next to
  its own distinct "Instagram app ID". This signs `instagram`/`comments` webhooks.

They are not the same value. Verifying Instagram's `X-Hub-Signature-256` against the main App Secret
fails every single time with "bad signature" — no amount of resetting or re-copying the *main* secret
fixes it, because the code was checking against the wrong secret entirely. The fix: try both secrets
when verifying (`src/index.ts` checks `META_APP_SECRET` and `IG_APP_SECRET`), since which platform a
webhook came from isn't known until after the body is trusted.

Not documented anywhere on a single page — found by comparing which platform's requests verified
successfully (Facebook did, Instagram never did) after confirming the app-level and account-level
webhook subscriptions were both already correct.

## 11. `/{comment-id}/private_replies` is dead — use `/{page-id}/messages` instead

The classic Graph API reference page for
[`/object/private_replies`](https://developers.facebook.com/docs/graph-api/reference/object/private_replies/)
is still served at current API versions (v26.0 included) but carries this line at the top:

> "This document refers to a feature that was removed after Graph API v3.2."

Calling it anyway doesn't error obviously — it returns the same generic
`code=100 subcode=33 "Unsupported post request... does not exist, cannot be loaded due to missing
permissions, or does not support this operation"` that a real permissions problem would produce. This
is exactly why it was mistaken for an Advanced-Access gate for a while (see §1's correction) — the
symptom is indistinguishable from "no permission" unless you already suspect a dead endpoint.

The current, correct endpoint (confirmed against Meta's live
[Private Replies](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/private-replies)
doc) sends a private reply through the same Send API used for everything else on the Page, with the
comment id as the recipient — structurally identical to how Instagram's own `/messages` endpoint
already worked in this codebase:

```
POST /{PAGE-ID}/messages
{ "recipient": { "comment_id": "<COMMENT_ID>" }, "message": { "text": "<TEXT>" } }
```

Permission required: `pages_messaging` (current) — **not** `read_page_mailboxes`, which the old
`/private_replies` doc still lists and which was deprecated as of Graph API v3.3, stopped working
entirely after June 30 2020.

## 12. Liking comments: works on Facebook, impossible on Instagram — and the docs lie

Verified live 2026-08-12 against the real production Page and IG account, using a comment authored by
the account owner so nothing notified a third party. Every result below is a first-hand API response,
not a doc reading — because **the docs are wrong here**.

| Operation | Result |
| --- | --- |
| `POST /{fb-comment-id}/likes` | ✅ `200 {"success":true}`, `like_count` 0 → 1 |
| `DELETE /{fb-comment-id}/likes` | ✅ `200 {"success":true}` — unlike works, so it's reversible |
| `POST /{fb-comment-id}/reactions` `type=LOVE` | ❌ `code=3` "Application does not have the capability to make this API call" |
| `POST /{ig-comment-id}/likes` (graph.instagram.com) | ❌ `code=100/33` "…or does not support this operation" |
| `POST /{ig-comment-id}` `like=true` | ❌ "The parameter hide is required" — that endpoint only does `hide` |

**Meta's reference for the comment `likes` edge says "Creating: This endpoint cannot perform this
operation." That is false** — the call succeeds. Same failure mode as §11's `/private_replies`: a
stale reference page that contradicts the live API. If anyone "fixes" `likeFacebookComment` out of
`src/graph.ts` on the strength of that page, this is the note that should stop them.

The Instagram negative is trustworthy for a specific reason worth copying next time: the test used a
**real** comment id that the *same token had just read successfully* via GET. That rules out the
"object does not exist" half of Meta's combined error string, leaving "does not support this
operation". An earlier probe with a deliberately **bogus** id proved nothing, because `/replies` —
which demonstrably works — returns the identical error for a nonexistent object. Never conclude an
endpoint is missing from a bogus-id probe.

**Reaction types (LOVE, HAHA, WOW…) are not available to apps at all**, on either platform. Only a
plain like. A `❤️` public reply is the closest equivalent for Instagram, and is arguably better —
it notifies the commenter, which a like may not.

There is a claim that Meta shipped Instagram comment liking on **22 April 2026** requiring
`instagram_manage_engagement` and **Facebook** Business Login. Unverified: the permission's reference
page 404s, and this app uses Instagram Login (`IG_LOGIN_MODE="instagram"`), so it is out of reach
without changing the whole IG auth model. Re-check before assuming Instagram likes are impossible
forever.

## 13. Other constraints worth remembering

- The Instagram professional account **must be public** to receive comment webhooks.
- Instagram requires *Settings → Messages → Allow access to messages* enabled.
- Facebook needs `POST /{page-id}/subscribed_apps` with `subscribed_fields=feed`. Without it the
  webhook is configured but never fires.
- Legacy scope names (`instagram_basic`, `instagram_manage_comments`) were **retired 27 Jan 2025** in
  favour of `instagram_business_*`. Doc snippets still showing the old names are stale.

## Unresolved / worth re-checking

| Topic | Status |
| --- | --- |
| Does Meta invoke the data-deletion callback for Instagram-Login-only apps? | Unconfirmed. Sidestepped by using the instructions URL |
| Is the deauthorize callback applicable at all here? | Unconfirmed — official page 404s |
| Screencast length limit | No first-party source found — moot now that App Review isn't required (§1), kept in case that ever changes |
| Does the polling workaround avoid App Review? | Moot — §1's correction means there's nothing to avoid, for a single-owner app |
