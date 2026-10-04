import { accountToken, igLoginMode, tokenKey } from "./accounts.ts";
import type { Account, Env } from "./types";

const FB_BASE = "https://graph.facebook.com";
const IG_BASE = "https://graph.instagram.com";

export class GraphError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly subcode?: number;

  // Written out longhand rather than as constructor parameter properties, which
  // are the one bit of TypeScript `node --test` cannot strip — and this class's
  // error classification is worth having under test.
  constructor(message: string, status: number, code?: number, subcode?: number) {
    super(message);
    this.name = "GraphError";
    this.status = status;
    this.code = code;
    this.subcode = subcode;
  }

  /**
   * The comment can't take a private reply: already replied (only one is ever
   * allowed), older than 7 days, or deleted. Code 100/2534025 is by far the most
   * common private-reply error in practice.
   *
   * 100/2534014 ("The requested user could not be found") is the other one, and it
   * is equally terminal — observed live against `/{ig-id}/messages` with a comment
   * id Meta can't resolve. Without it here the error falls through to "unexpected",
   * which releases the KV claim and invites a redelivery that fails identically.
   *
   * The message regex is a last resort, not a check to rely on: Meta localises
   * these strings (the 2534014 probe came back in Japanese), so only the
   * code/subcode pair is dependable.
   */
  get isNotReplyable(): boolean {
    return (
      this.code === 10900 ||
      (this.code === 100 && (this.subcode === 2534025 || this.subcode === 2534014)) ||
      /already replied|invalid for a private reply/i.test(this.message)
    );
  }

  /** Commenter's privacy settings block message requests from us. */
  get isRecipientRestricted(): boolean {
    return this.code === 10903 || this.subcode === 1893049;
  }

  /**
   * Permissions refusal. Either the token lacks the messaging scope (200/2534066),
   * the account owner disabled DM access (200/2534041), the Page has messaging off
   * (10904/1893050), the app lacks Advanced Access for this recipient, or (100/33)
   * the edge itself is invisible to this token — Meta's generic "object does not
   * exist, cannot be loaded due to missing permissions" for a private-reply edge
   * without Advanced Access on pages_messaging.
   */
  get isPermissionError(): boolean {
    return (
      this.code === 200 ||
      this.code === 10904 ||
      this.code === 3 ||
      this.code === 10 ||
      (this.code === 100 && this.subcode === 33)
    );
  }

  /** Meta throttles messaging per account; viral posts hit this constantly. */
  get isRateLimited(): boolean {
    return this.code === 613 || this.code === 4 || this.code === 32;
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.code === 190 || this.code === 102;
  }

  /** Meta's code/subcode pair is the only reliable discriminator — always log it. */
  get detail(): string {
    return `status=${this.status} code=${this.code ?? "?"} subcode=${this.subcode ?? "-"}: ${this.message}`;
  }
}

async function call(url: string, token: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok || json?.error) {
    const err = json?.error ?? {};
    throw new GraphError(
      err.message ?? `HTTP ${res.status}: ${text.slice(0, 300)}`,
      res.status,
      err.code,
      err.error_subcode,
    );
  }
  return json;
}

/** Instagram base URL depends on which login flow that account's app uses. */
function igBase(env: Env, account: Account): string {
  return igLoginMode(env, account) === "facebook" ? FB_BASE : IG_BASE;
}

export async function sendInstagramDm(
  env: Env,
  account: Account,
  commentId: string,
  text: string,
): Promise<void> {
  const token = await accountToken(env, account);
  await call(`${igBase(env, account)}/${env.GRAPH_VERSION}/${account.id}/messages`, token, {
    recipient: { comment_id: commentId },
    message: { text },
  });
}

export async function replyToInstagramComment(
  env: Env,
  account: Account,
  commentId: string,
  text: string,
): Promise<void> {
  const token = await accountToken(env, account);
  await call(`${igBase(env, account)}/${env.GRAPH_VERSION}/${commentId}/replies`, token, {
    message: text,
  });
}

export async function sendFacebookDm(
  env: Env,
  account: Account,
  commentId: string,
  text: string,
): Promise<void> {
  const token = await accountToken(env, account);
  // /{comment-id}/private_replies was removed after Graph API v3.2. The current
  // Send API sends a private reply the same way Instagram does: POST to the
  // Page's own /messages edge with the comment id as the recipient.
  await call(`${FB_BASE}/${env.GRAPH_VERSION}/${account.id}/messages`, token, {
    recipient: { comment_id: commentId },
    message: { text },
  });
}

export async function replyToFacebookComment(
  env: Env,
  account: Account,
  commentId: string,
  text: string,
): Promise<void> {
  const token = await accountToken(env, account);
  await call(`${FB_BASE}/${env.GRAPH_VERSION}/${commentId}/comments`, token, { message: text });
}

/**
 * Like a comment as the Page. Facebook only.
 *
 * Meta's own reference for the comment `likes` edge claims "This endpoint cannot
 * perform this operation" — that is wrong. Verified live 2026-08-12: this returns
 * `{"success":true}` and `like_count` increments (docs/meta-research.md §12). Same
 * class of stale doc as `/private_replies` in §11, so don't "fix" this back.
 *
 * Only a plain like is possible. `POST /{comment-id}/reactions` with type=LOVE is
 * refused with code 3, "Application does not have the capability" — reaction types
 * are not available to apps at all. Instagram has no equivalent endpoint.
 */
export async function likeFacebookComment(
  env: Env,
  account: Account,
  commentId: string,
): Promise<void> {
  const token = await accountToken(env, account);
  await call(`${FB_BASE}/${env.GRAPH_VERSION}/${commentId}/likes`, token, {});
}

/**
 * Instagram long-lived tokens last 60 days. Refreshing swaps it for a fresh
 * 60-day token, so a daily cron means the Worker never needs manual attention.
 * Facebook Page tokens obtained from a long-lived user token do not expire, and
 * accounts on Facebook Login use Page tokens too — both are skipped.
 */
export async function refreshInstagramToken(env: Env, account: Account): Promise<string> {
  if (account.platform !== "instagram" || igLoginMode(env, account) === "facebook") {
    throw new Error(`Refresh not applicable for ${account.label}: Page tokens do not expire`);
  }
  const token = await accountToken(env, account);
  const url = new URL(`${IG_BASE}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", token);

  const res = await fetch(url, { method: "GET" });
  const json = (await res.json()) as { access_token?: string; error?: { message?: string } };
  if (!res.ok || !json.access_token) {
    throw new Error(`Token refresh failed: ${json.error?.message ?? res.status}`);
  }
  // Written per account rather than back into the shared `accounts` blob, which
  // the dashboard also writes — no read-modify-write race with a human editing.
  await env.STATE.put(tokenKey(account.id), json.access_token);
  return json.access_token;
}
