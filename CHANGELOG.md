# Changelog

All notable changes to HushReply are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-04

First public release.

### Added
- Comment-to-DM for Instagram professional accounts and Facebook Pages through Meta's official
  private replies API.
- Optional public reply with rotating variants (chosen deterministically from the comment id), and
  liking the comment on Facebook.
- Keyword rules with `word`, `contains`, `exact`, `starts`, `regex` and `any` match modes; platform,
  post, exclude-word and reply filters; per-person cooldowns.
- Multiple accounts with per-account rule lists plus shared rules.
- Safety guards: webhook signature verification, KV dedupe of every comment, self-comment guard,
  "honest replies" (no "check your DMs" reply when the DM failed), dry-run mode.
- Daily Instagram token refresh; built-in `/privacy`, `/terms`, `/data-deletion` pages; counts-only
  `/health` endpoint.
- Local dashboard for editing rules, accounts and app secrets, with a live match tester, a
  one-click **Commit & push** for Git-connected (Deploy button) copies, and auto-open in the browser.
- One-click Deploy to Cloudflare: auto-created KV namespace, secret prompts with help text, and a
  single-account quick start that needs no CLI.

[1.0.0]: https://github.com/lakpriya1s/hushreply/releases/tag/v1.0.0
