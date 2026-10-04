import { findAccount } from "./accounts";
import { RULES } from "./config";
import {
  GraphError,
  likeFacebookComment,
  replyToFacebookComment,
  replyToInstagramComment,
  sendFacebookDm,
  sendInstagramDm,
} from "./graph";
import { findRule, pickVariant, type ResolvedRule } from "./rules";
import type { Account, CommentEvent, Env } from "./types";

const SEVEN_DAYS = 60 * 60 * 24 * 7;

/** Fill {{name}} / {{username}} placeholders in a message body. */
function render(template: string, event: CommentEvent): string {
  const name = event.authorName ?? "there";
  return template.replaceAll("{{name}}", name).replaceAll("{{username}}", name);
}

/**
 * Meta retries webhooks and `feed` can fire more than once for the same
 * comment, so claim each comment id exactly once before doing any work.
 * Returns false if this comment was already claimed.
 */
function claimKey(event: CommentEvent): string {
  return `seen:${event.platform}:${event.commentId}`;
}

async function claim(env: Env, event: CommentEvent): Promise<boolean> {
  const key = claimKey(event);
  if (await env.STATE.get(key)) return false;
  await env.STATE.put(key, "1", { expirationTtl: SEVEN_DAYS });
  return true;
}

/**
 * Give up the claim so a later redelivery can retry. Only for genuinely unexpected
 * failures — the classified Graph errors are all terminal, and releasing on those
 * would just re-attempt something Meta has already refused.
 */
async function releaseClaim(env: Env, event: CommentEvent): Promise<void> {
  try {
    await env.STATE.delete(claimKey(event));
  } catch (err) {
    console.error(`could not release claim for ${event.commentId}: ${(err as Error).message}`);
  }
}

/**
 * Cooldown is per account as well as per rule: the same person commenting on two
 * different accounts of yours is two separate conversations.
 */
async function onCooldown(
  env: Env,
  event: CommentEvent,
  account: Account,
  rule: ResolvedRule,
): Promise<boolean> {
  if (env.DISABLE_COOLDOWN === "true") return false;
  if (rule.cooldownHours <= 0 || !event.authorId) return false;
  const key = `cool:${event.platform}:${account.id}:${rule.id}:${event.authorId}`;
  if (await env.STATE.get(key)) return true;
  await env.STATE.put(key, "1", { expirationTtl: Math.round(rule.cooldownHours * 3600) });
  return false;
}

/** Returns true if the DM went out (or was already delivered previously). */
async function tryDm(
  env: Env,
  event: CommentEvent,
  account: Account,
  text: string,
): Promise<boolean> {
  try {
    if (event.platform === "instagram") {
      await sendInstagramDm(env, account, event.commentId, text);
    } else {
      await sendFacebookDm(env, account, event.commentId, text);
    }
    return true;
  } catch (err) {
    if (!(err instanceof GraphError)) throw err;

    if (err.isNotReplyable) {
      console.log(`dm skipped, comment not replyable: ${err.detail}`);
      return false;
    }
    if (err.isRecipientRestricted) {
      console.log(`dm skipped, recipient blocks message requests: ${err.detail}`);
      return false;
    }
    if (err.isPermissionError) {
      // The match line looks like success, so make the refusal loud. Most likely
      // causes: the wrong token for this account, or DM access disabled on it.
      console.error(
        `DM REFUSED on account=${account.label} for author=${event.authorId ?? "?"} ` +
          `(${event.authorName ?? "?"}). Check that this account's token is current and ` +
          `that the account allows access to messages. Meta said: ${err.detail}`,
      );
      return false;
    }
    if (err.isRateLimited) {
      console.error(`DM rate limited, dropping: ${err.detail}`);
      return false;
    }
    if (err.isAuthError) {
      console.error(
        `TOKEN INVALID for account=${account.label} (${account.id}) — replace it in the ` +
          `dashboard's Accounts tab. Meta said: ${err.detail}`,
      );
      return false;
    }
    throw err;
  }
}

/**
 * A like is cosmetic and independent of the DM, so its failure is logged and
 * swallowed — it must never take down a send that would otherwise have worked.
 */
async function tryLike(env: Env, event: CommentEvent, account: Account): Promise<void> {
  if (event.platform !== "facebook") {
    // validateRules rejects like-only Instagram rules, so this is the mixed-platform
    // case: the rule covers both and the like simply doesn't apply here.
    console.log(`like skipped on ${event.platform}: no such API outside Facebook`);
    return;
  }
  try {
    await likeFacebookComment(env, account, event.commentId);
  } catch (err) {
    const detail = err instanceof GraphError ? err.detail : (err as Error).message;
    console.error(`like failed: ${detail}`);
  }
}

async function tryPublicReply(
  env: Env,
  event: CommentEvent,
  account: Account,
  text: string,
): Promise<void> {
  try {
    if (event.platform === "instagram") {
      await replyToInstagramComment(env, account, event.commentId, text);
    } else {
      await replyToFacebookComment(env, account, event.commentId, text);
    }
  } catch (err) {
    const detail = err instanceof GraphError ? err.detail : (err as Error).message;
    console.error(`public reply failed: ${detail}`);
  }
}

export async function handleComment(
  env: Env,
  event: CommentEvent,
  accounts: Account[],
): Promise<void> {
  const dryRun = env.DRY_RUN === "true";

  const account = findAccount(accounts, event.platform, event.accountId);
  if (!account) {
    console.warn(
      `no account configured for ${event.platform}:${event.accountId ?? "?"} — ignoring comment ` +
        `${event.commentId}. Add it in the dashboard's Accounts tab.`,
    );
    return;
  }

  // Our own comments and auto-replies arrive as webhooks too. Without this guard
  // a catch-all reply rule would answer itself forever. Every configured account
  // counts as "us", not just the one that received this webhook.
  if (env.DISABLE_SELF_COMMENT_GUARD !== "true") {
    if (event.authorId && accounts.some((a) => a.id === event.authorId)) return;
    if (event.authorId && event.accountId && event.authorId === event.accountId) return;
  }

  const scoped: CommentEvent = { ...event, accountLabel: account.label };
  const rule = findRule(scoped, RULES);
  if (!rule) {
    // Without this, a comment that matches nothing is indistinguishable from a
    // broken webhook, a bad token, or a dropped rule — all of which look like
    // silence. This is the single most useful line when "nothing happened".
    console.log(
      `no rule matched on account=${account.label} platform=${event.platform} ` +
        `comment=${event.commentId} text=${JSON.stringify(event.text.slice(0, 80))}`,
    );
    return;
  }

  if (!(await claim(env, event))) {
    console.log(`skip duplicate ${event.platform}:${event.commentId}`);
    return;
  }

  if (await onCooldown(env, event, account, rule)) {
    console.log(`skip cooldown rule=${rule.id} account=${account.label} user=${event.authorId}`);
    return;
  }

  const actions = [rule.dm && "dm", rule.publicReply.length > 0 && "reply", rule.like && "like"]
    .filter(Boolean)
    .join("+");
  console.log(
    `match rule=${rule.id} actions=${actions} platform=${event.platform} ` +
      `account=${account.label} comment=${event.commentId} ` +
      `author=${event.authorName ?? "?"}${dryRun ? " [DRY_RUN]" : ""}`,
  );
  if (dryRun) return;

  // Liked first, and deliberately not gated on the DM: it's an acknowledgement, not
  // a claim that anything was sent, so it stays true even if the send fails. Also
  // idempotent on Meta's side, so a redelivery re-liking is harmless.
  if (rule.like) await tryLike(env, event, account);

  let dmDelivered = true;
  if (rule.dm) {
    try {
      dmDelivered = await tryDm(env, event, account, render(rule.dm, event));
    } catch (err) {
      // Unexpected failure (Graph 5xx, network blip). We already returned 200 to
      // Meta, so nothing will retry unless we let go of the claim first.
      await releaseClaim(env, event);
      throw err;
    }
  }

  const replyTemplate = pickVariant(rule.publicReply, event.commentId);
  if (!replyTemplate) return;

  // A reply-only rule always posts. But when the rule also sends a DM, the reply
  // copy usually says "check your DMs" — posting that after a failed send would
  // be a public lie, so hold it back.
  if (rule.dm && !dmDelivered) {
    console.log(`public reply held back: dm did not land for ${event.commentId}`);
    return;
  }

  await tryPublicReply(env, event, account, render(replyTemplate, event));
}
