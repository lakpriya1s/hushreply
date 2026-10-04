# Security policy

HushReply holds access tokens that can send messages as the account owner, so security reports are
taken seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub:
**[Report a vulnerability](https://github.com/lakpriya1s/hushreply/security/advisories/new)**
(the repo's Security tab → *Report a vulnerability*).

Include what you found, how to reproduce it, and the impact you think it has. You'll get an
acknowledgement within a few days. Fixes ship as a new release, and reporters are credited unless they'd
rather not be.

## Scope

In scope:
- Anything that lets someone without the app secret make the Worker send a DM, reply or like
  (e.g. bypassing webhook signature verification).
- Anything that exposes tokens, secrets, rules or account ids through the deployed Worker.
- Ways to make the Worker message the same person repeatedly, or answer its own replies, despite the
  dedupe, cooldown and self-comment guards.
- The local dashboard being reachable from, or controllable by, another machine or a web page
  (DNS rebinding, CSRF and the like).

Out of scope:
- Leaked credentials in *your own* deployment (rotate them in Meta's app dashboard and Cloudflare).
- Meta's or Cloudflare's own platforms. Report those to them directly.
- Running with `DISABLE_SELF_COMMENT_GUARD` or `DISABLE_COOLDOWN` set to `"true"`. They're documented
  testing-only switches.

## Supported versions

Only the latest release on `main` gets security fixes. A deployment made with the Deploy button
updates when you pull upstream changes into your copy.
