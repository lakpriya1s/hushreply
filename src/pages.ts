/**
 * Static privacy / terms / data-deletion pages.
 *
 * Meta requires all three as publicly reachable HTTPS URLs before an app can be
 * switched to Live, and its crawler runs no JavaScript — so these are plain HTML
 * with no external assets.
 *
 * The privacy text deliberately names the exact data this Worker stores. A generic
 * policy that doesn't mention the Instagram/Facebook data collected is one of the
 * most commonly cited App Review rejection reasons.
 */

export interface SiteConfig {
  /** Display name of the app/business shown on the pages. */
  appName: string;
  /** Contact address for privacy and deletion requests. */
  contactEmail: string;
  /** Public origin the pages are served from, e.g. https://automation.example.com */
  origin: string;
  /** Legal entity name, if different from appName. */
  legalName?: string;
}

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function layout(title: string, cfg: SiteConfig, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — ${esc(cfg.appName)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 16px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    max-width: 44rem; margin: 0 auto; padding: 2.5rem 1.25rem 5rem;
    color: #1a1a1a; background: #fff;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e8e8e8; background: #16171a; }
    a { color: #7fb2ff; }
    th, td { border-color: #34363b !important; }
    code { background: #26282d; }
  }
  h1 { font-size: 1.7rem; margin-bottom: .25rem; }
  h2 { font-size: 1.15rem; margin-top: 2.25rem; }
  .meta { color: #6b6b6b; font-size: .9rem; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: .93rem; }
  th, td { border: 1px solid #d8d8d8; padding: .5rem .6rem; text-align: left; vertical-align: top; }
  th { font-weight: 600; }
  code { background: #f2f2f2; padding: .1rem .3rem; border-radius: 3px; font-size: .88em; }
  footer { margin-top: 3rem; font-size: .88rem; color: #6b6b6b; }
  .wrap { overflow-x: auto; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p class="meta">${esc(cfg.appName)} · last updated ${new Date().toISOString().slice(0, 10)}</p>
${body}
<footer>
  <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> ·
  <a href="/data-deletion">Data deletion</a>
</footer>
</body>
</html>`;
}

export function privacyPage(cfg: SiteConfig): string {
  const owner = esc(cfg.legalName ?? cfg.appName);
  return layout(
    "Privacy Policy",
    cfg,
    `
<p>${esc(cfg.appName)} is a private automation tool operated by ${owner}. It replies to comments on
our own Instagram and Facebook posts, and sends the commenter a direct message when their comment
contains a keyword we have configured. It is used only for our own accounts and is not offered to
other businesses.</p>

<h2>What data we receive</h2>
<p>When someone comments on one of our posts, Meta sends us a webhook notification containing the
comment's ID, the comment text, the post/media ID, and the commenter's platform user ID and
username or display name. We use this solely to decide whether the comment matches one of our
keywords and to send the corresponding reply.</p>

<h2>What we store, and for how long</h2>
<div class="wrap">
<table>
  <thead><tr><th>Data</th><th>Why</th><th>Retention</th></tr></thead>
  <tbody>
    <tr><td>Comment ID</td><td>So a repeated webhook delivery cannot send you a duplicate message</td><td>7 days, then deleted automatically</td></tr>
    <tr><td>Commenter's platform user ID</td><td>To avoid messaging the same person repeatedly for the same keyword</td><td>Between 1 hour and 7 days depending on the rule, then deleted automatically</td></tr>
    <tr><td>Our own Instagram access token</td><td>Required to send messages on our behalf</td><td>Until replaced by a refreshed token</td></tr>
  </tbody>
</table>
</div>

<p><strong>We do not store the text of your comment, and we do not store the content of any
message.</strong> Our keyword rules and message templates are held in our own source code, not in a
database of user data. Operational logs may briefly contain a commenter's username while we
diagnose problems; these are not retained as records and are not used for any other purpose.</p>

<h2>What we never do</h2>
<ul>
  <li>We do not sell, rent, or share your data with third parties.</li>
  <li>We do not use it for advertising, profiling, or building audiences.</li>
  <li>We do not attempt to identify you beyond the account that left the comment.</li>
</ul>

<h2>Where it is processed</h2>
<p>The service runs on Cloudflare Workers, with the short-lived values above held in Cloudflare
Workers KV. Data is transmitted to and from Meta's APIs over HTTPS.</p>

<h2>Your rights</h2>
<p>You can ask us to delete the limited data described above at any time — see
<a href="/data-deletion">Data deletion</a>. You can also stop receiving messages entirely by
adjusting your Instagram or Facebook message-request settings, or by not commenting the keyword.</p>

<h2>Contact</h2>
<p>Privacy questions: <a href="mailto:${esc(cfg.contactEmail)}">${esc(cfg.contactEmail)}</a>.</p>
`,
  );
}

export function termsPage(cfg: SiteConfig): string {
  const owner = esc(cfg.legalName ?? cfg.appName);
  return layout(
    "Terms of Service",
    cfg,
    `
<p>${esc(cfg.appName)} ("the service") is a private tool operated by ${owner} for managing replies to
comments on our own Instagram and Facebook accounts. These terms cover what you can expect if the
service replies to you.</p>

<h2>What the service does</h2>
<p>If you comment on one of our posts and your comment contains a keyword we have configured, the
service may reply publicly to your comment and send you one direct message. Meta permits a single
private reply per comment, so you will not receive repeated messages for the same comment.</p>

<h2>No guarantee of delivery</h2>
<p>Message delivery depends on Meta's platform and on your own privacy settings. A message may not
arrive if your settings block message requests, if the comment is more than seven days old, if the
comment is deleted, or if Meta rate-limits or otherwise refuses the request. The service is provided
as-is, without warranty, and we are not liable for a message that fails to arrive.</p>

<h2>Acceptable use</h2>
<p>Please do not attempt to abuse the automation — for example by mass-commenting keywords to
generate traffic. We may hide or delete comments, block accounts, or disable a keyword at any time,
and we may change or withdraw the service without notice.</p>

<h2>Not affiliated with Meta</h2>
<p>The service is not endorsed by, sponsored by, or affiliated with Meta Platforms, Inc. Instagram
and Facebook are trademarks of Meta Platforms, Inc. Your use of Instagram and Facebook remains
governed by Meta's own terms.</p>

<h2>Privacy</h2>
<p>See our <a href="/privacy">Privacy Policy</a> for what data the service handles.</p>

<h2>Contact</h2>
<p><a href="mailto:${esc(cfg.contactEmail)}">${esc(cfg.contactEmail)}</a></p>
`,
  );
}

export function dataDeletionPage(cfg: SiteConfig): string {
  return layout(
    "Data Deletion",
    cfg,
    `
<p>This page explains how to have data held by ${esc(cfg.appName)} deleted.</p>

<h2>What there is to delete</h2>
<p>The service holds very little: a comment ID used to prevent duplicate messages, and your platform
user ID used to avoid messaging you repeatedly about the same keyword. Both expire and are deleted
automatically — the comment ID after 7 days, and the user ID within 7 days at most. We do not store
your comment text or any message content. See the <a href="/privacy">Privacy Policy</a> for the full
list.</p>

<h2>Request deletion now</h2>
<p>Email <a href="mailto:${esc(cfg.contactEmail)}?subject=Data%20deletion%20request">${esc(cfg.contactEmail)}</a>
with the subject <code>Data deletion request</code> and include the Instagram or Facebook username
you commented from. That username is all we need to locate and remove the records above.</p>

<p>We will confirm deletion by email within 30 days, and normally within a few days. There is no
charge, and you do not need an account with us to make a request.</p>

<h2>Deleting your connection from Meta's side</h2>
<p>Because this tool only ever acts on our own posts, you have not granted it access to your account
and there is nothing to revoke. If you want to review apps connected to your own account, use
<em>Settings → Website permissions → Apps and websites</em> on Instagram, or
<em>Settings → Apps and Websites</em> on Facebook.</p>

<h2>Stop receiving messages</h2>
<p>To stop receiving automated replies without contacting us, either do not comment our keywords, or
turn off message requests from accounts you do not follow in your Instagram or Facebook privacy
settings.</p>
`,
  );
}
