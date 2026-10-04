# Rules

`rules.json` decides which comments get a response and what the response is. It's a plain file in
your repo: version-controlled, diffable, no database. It's compiled into the Worker, so **a change
takes effect on the next deploy**.

Other docs: [setup.md](setup.md) · [dashboard.md](dashboard.md) · [troubleshooting.md](troubleshooting.md)

---

## Editing rules

Two ways, same file:

- **In GitHub.** If you used the Deploy button, open `rules.json` in your copy of the repo, click the
  pencil, edit, commit to `main`. Workers Builds redeploys automatically. No terminal needed.
- **In the local dashboard.** `npm run dashboard` gives you a form-based editor that validates as you
  go and has a Test box that runs the real matcher against a comment you type. See
  [dashboard.md](dashboard.md). After saving, commit and push (Deploy-button installs) or
  `npm run deploy` (CLI installs).

Editing in GitHub skips validation. If a rule is invalid, the Worker drops **that rule** at startup
and logs why (`rule "…" (#2 in shared) skipped: …`); the others keep working. The dashboard refuses to
save an invalid file instead, which is the main reason to use it for anything non-trivial.

---

## Shape

```json
{
  "defaults": { "match": "word", "caseSensitive": false, "platforms": ["instagram", "facebook"], "cooldownHours": 24 },

  "byAccount": {
    "main ig":   [ { "keyword": "PRICE", "dm": "Instagram price list …" } ],
    "shop page": [ { "keyword": "PRICE", "dm": "Shop price list …" } ]
  },

  "shared": [
    { "keyword": "LINK", "dm": "Here's the link …", "publicReply": "Sent! 📬" }
  ]
}
```

| Key | What it holds |
| --- | --- |
| `defaults` | Field values every rule inherits unless it sets its own. |
| `byAccount` | One rule list per account, keyed by the account's **label** (case-insensitive) or its **id** (exact). |
| `shared` | Rules that apply to every account. Checked **after** the account's own list. |
| `rules` | The older flat list. Still works, treated as `shared`. New files should use `shared`. |

With the Deploy button's quick-start accounts (the `IG_USER_ID` / `FB_PAGE_ID` secrets), the labels
are `instagram (env)` and `facebook page (env)`. Key `byAccount` by the account id instead, or keep
everything in `shared`. The shipped example uses only `shared`.

---

## How a comment finds its rule

1. The webhook's account is looked up (by the id Meta sends).
2. That account's `byAccount` list is checked top to bottom, then `shared` top to bottom.
3. **The first rule that matches wins.** One comment triggers one rule, never several.

That ordering gives you three useful properties:

- **Each account can have its own version of a rule**, even with the same id. They never share
  cooldown state, because the cooldown is per account.
- **An account can override a shared rule** by giving one of its own rules the same id. Its version is
  checked first, so it wins. That's intended, not a duplicate-id error.
- **An account with no list of its own** just gets the shared rules.

Put specific rules above general ones. A `match: "any"` catch-all must be **last** in its list, or it
swallows everything below it.

**Renaming an account orphans its rules.** A `byAccount` key that matches no configured account can
never fire. The dashboard shows such a tab in amber so you can rename or move it; the Worker just
ignores it.

---

## Fields

A rule needs **at least one of `dm`, `publicReply` or `like`**.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `id` | string | lowercased `keyword`, or `catch-all` | Stable key for cooldown bookkeeping. Unique within one list. |
| `keyword` | string | — | What to look for. Omit (or use `match: "any"`) to match every comment. |
| `match` | see below | `word` | How `keyword` is compared to the comment. |
| `caseSensitive` | boolean | `false` | |
| `platforms` | `["instagram", "facebook"]` | both | Which platforms the rule fires on. |
| `dm` | string | none | The private reply. Omit for a reply-only rule. |
| `publicReply` | string or string[] | none | A public reply under the comment. An array is a set of variants; see below. |
| `like` | boolean | `false` | Like the comment as the Page. **Facebook only.** |
| `cooldownHours` | number | `0` (`24` in the shipped defaults) | Don't fire this rule again for the same person on the same account within this window. `0` disables. |
| `exclude` | string[] | none | Skip the rule if the comment contains any of these. Case-insensitive substrings. |
| `includeReplies` | boolean | `true` | Whether the rule may fire on replies to other comments, not just top-level ones. |
| `mediaIds` | string[] | any post | Only fire on these posts (Instagram media ids / Facebook post ids). |
| `enabled` | boolean | `true` | `false` parks a rule without deleting it. |
| `accounts` | string[] | every account | Only for rules in `shared` (or the old flat `rules`): limit to these account labels or ids. A rule under `byAccount` must **not** set it; that's a validation error, because the section already scopes it. |

Any of `match`, `caseSensitive`, `platforms`, `cooldownHours`, `publicReply`, `like`, `exclude` and
`includeReplies` can go in `defaults`.

### Match modes

| `match` | Fires when | `LINK` matches | Doesn't match |
| --- | --- | --- | --- |
| `word` (default) | the keyword appears as a whole word | `link please`, `LINK!!`, `🔥LINK🔥` | `linkedin`, `hyperlink` |
| `contains` | the keyword appears anywhere | all of the above, plus `linkedin` | |
| `exact` | the whole comment is the keyword (trimmed) | ` link ` | `link please` |
| `starts` | the comment starts with the keyword | `link please` | `please link` |
| `regex` | the keyword, as a JavaScript regex, matches (flags `iu`, or just `u` with `caseSensitive`) | `^link\b` | |
| `any` | always | everything | |

`word` is the default because `contains` fires on `somethingelse`, which is almost never what you
want. Its word boundary is Unicode-aware: emoji and punctuation right against the keyword still count
as a boundary, which JavaScript's built-in `\b` gets wrong.

A broken `regex` is refused by the dashboard and dropped by the Worker, with the error message.

### Message text

`dm` and `publicReply` can include **`{{name}}`** (or **`{{username}}`**, which is the same thing):
the commenter's Instagram username or Facebook name. If Meta doesn't send one, it becomes `there`.

Use `\n` for line breaks inside a JSON string. Links in a DM are fine.

### Reply variants

```json
"publicReply": ["Just sent it to your DMs 📬", "Check your DMs {{name}} 📬", "Sent! Check your inbox 📬"]
```

One variant is picked per comment by hashing the comment id. Different people see different wording,
so the replies don't read as canned. And the same comment always gets the same variant, so if Meta
redelivers a webhook it can't post a second, different reply.

### Likes

`"like": true` likes the comment as your Page. **Facebook only**: Instagram has no API for liking a
comment ([meta-research.md §12](meta-research.md#12-liking-comments-works-on-facebook-impossible-on-instagram--and-the-docs-lie)).

- A like-only rule restricted to Instagram is refused; it could never do anything.
- A rule covering both platforms is fine. The like applies on Facebook and is skipped on Instagram
  (`like skipped on instagram` in the log). Give it a `dm` or `publicReply` so Instagram still does
  something.
- Only a plain like is possible. Meta refuses reaction types (LOVE, HAHA…) for every app. On
  Instagram, a one-emoji `publicReply` like `["❤️", "🙌"]` is the closest thing, and it notifies the
  commenter.

The like fires first and isn't held back if the DM fails: it acknowledges the comment rather than
claiming anything was sent.

---

## Honest replies

When a rule has both `dm` and `publicReply`, the DM is sent first. **If the DM fails, the public reply
is held back**, because reply copy usually says "check your DMs" and posting that after a failed send
is a public lie. The log says:

```
public reply held back: dm did not land for <comment_id>
```

Reply-only rules have nothing to wait for, so they always post.

The DM can fail for reasons outside your control: the comment was already privately replied to (Meta
allows one, ever), it's older than 7 days, it was deleted, or the commenter blocks message requests.
See [troubleshooting.md](troubleshooting.md).

---

## Cooldowns

`cooldownHours` stops the same person triggering the same rule again within the window. It's tracked
per **platform, account, rule and person**: someone commenting on two of your accounts is two
conversations and can get a DM from each.

Each first-time trigger with a cooldown costs one extra KV write, which matters on the free tier (1,000
writes a day, so about 500 matching comments a day with cooldowns on). Comments that match nothing
cost no writes at all.

---

## Rule shapes

```json
{ "keyword": "LINK", "dm": "…", "publicReply": "Check your DMs 📬" }      // DM + public reply
{ "keyword": "LINK", "dm": "…" }                                          // DM only, quietly
{ "keyword": "price", "publicReply": "DMs are open, message us 💬" }      // public reply only
{ "keyword": "price", "platforms": ["facebook"], "like": true }          // like only (Facebook)
```

## The shipped example

`rules.json` ships with three rules in `shared`:

```json
{
  "id": "link",
  "keyword": "LINK",
  "dm": "Hey {{name}}! Here's the link you asked for 👇\n\nhttps://example.com\n\nAny questions, just reply here.",
  "publicReply": ["Just sent it to your DMs 📬", "Check your DMs {{name}} 📬", "Sent! Check your inbox 📬"]
}
```

`link` matches `LINK` as a whole word on both platforms, with the 24-hour cooldown from `defaults`.

```json
{
  "id": "price",
  "keyword": "price",
  "platforms": ["facebook"],
  "exclude": ["spam"],
  "dm": "Hi {{name}}, thanks for asking! Our full price list is here: https://example.com/pricing",
  "publicReply": "Sent you the details in Messenger 💬",
  "like": true
}
```

`price` is Facebook-only: it likes the comment, DMs, then replies. A comment containing `spam` is
skipped.

```json
{
  "id": "catch-all",
  "match": "any",
  "enabled": false,
  "includeReplies": false,
  "publicReply": ["Thanks for the comment! 🙌", "Appreciate you {{name}} 🙏"]
}
```

`catch-all` replies to every top-level comment, and ships **disabled**. Replace the example URLs
before going live.

---

## Auto-replying to every comment

A `match: "any"` rule is a generic engagement responder. Replying to everything is also how accounts
get reported as spam, which is why the example ships disabled. If you turn it on, use all four of
these:

```json
{
  "id": "catch-all",
  "match": "any",
  "publicReply": ["Thanks for commenting {{name}} 🙌", "Appreciate the comment 🙏"],
  "exclude": ["http", "www.", "follow me", "check my", "dm me", "free followers"],
  "includeReplies": false,
  "cooldownHours": 72
}
```

- **`publicReply` as an array.** One identical line under every comment reads like a bot.
- **`exclude`.** Don't thank spam.
- **`includeReplies: false`.** Top-level comments only. Otherwise another bot replying to your reply
  can start a loop.
- **`cooldownHours`.** A prolific commenter doesn't get thanked ten times.

Keep it **last**. Rules are first-match-wins, so a catch-all above your keyword rules answers
everything with a generic thank-you and your keyword rules never fire:

```json
"shared": [
  { "keyword": "LINK",  "dm": "…", "publicReply": "Check your DMs 📬" },
  { "keyword": "price", "publicReply": "DMs are open 💬" },
  { "match": "any",     "publicReply": "Thanks! 🙌" }
]
```

Someone who comments `LINK` gets the `LINK` rule's DM and reply, not those plus a thank-you.

The Worker's own replies come back as webhooks too. The self-comment guard ignores comments by any of
your configured accounts, which is what stops a catch-all answering itself forever. Keep
`DISABLE_SELF_COMMENT_GUARD = "false"` whenever a catch-all is enabled.
