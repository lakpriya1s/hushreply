#!/usr/bin/env node
/**
 * Fires a correctly-signed fake webhook at a running Worker so you can test
 * matching without posting real comments.
 *
 *   node scripts/send-test.mjs instagram LINK
 *   node scripts/send-test.mjs facebook "hey, LINK please"
 *   TARGET=https://hushreply.<your-subdomain>.workers.dev/webhook node scripts/send-test.mjs instagram LINK
 *
 * The Worker routes on the webhook's `entry.id`, so the fake comment has to
 * arrive on an account it knows. Defaults to IG_USER_ID / FB_PAGE_ID from
 * .dev.vars; override with ACCOUNT:
 *
 *   ACCOUNT=17841400000000000 node scripts/send-test.mjs instagram LINK
 *
 * Signs with IG_APP_SECRET for Instagram (what signs real Instagram Login
 * webhooks) and META_APP_SECRET for Facebook, each read from the env first,
 * then from .dev.vars. Instagram falls back to META_APP_SECRET when no
 * IG_APP_SECRET is set.
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const platform = process.argv[2] ?? "instagram";
const text = process.argv[3] ?? "LINK";
const target = process.env.TARGET ?? "http://127.0.0.1:8787/webhook";

/** Env first, then .dev.vars. Blank counts as unset. */
function setting(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${name}=`));
    const value = line?.slice(name.length + 1).trim();
    if (value) return value;
  } catch {
    /* no .dev.vars */
  }
  return undefined;
}

function appSecret() {
  const secret =
    (platform === "instagram" ? setting("IG_APP_SECRET") : undefined) ?? setting("META_APP_SECRET");
  if (secret) return secret;
  console.error("Set META_APP_SECRET (and IG_APP_SECRET for Instagram) in the env or .dev.vars");
  process.exit(1);
}

// Meta puts the receiving account's id here, and the Worker uses it to pick which
// account's token to send with.
const accountId =
  process.env.ACCOUNT ??
  (platform === "facebook" ? setting("FB_PAGE_ID") : setting("IG_USER_ID")) ??
  (platform === "facebook" ? "100000000000000" : "17841400000000000");

const stamp = Math.floor(Date.now() / 1000);
// Needs a random suffix: two runs inside the same second would otherwise share a
// comment id and the second one would be dropped as a duplicate.
const commentId = `test_comment_${stamp}_${randomBytes(4).toString("hex")}`;

// Vary the commenter too, so per-author cooldowns don't mask later runs.
const authorId = process.env.TEST_AUTHOR ?? `test_user_${randomBytes(3).toString("hex")}`;

const body =
  platform === "facebook"
    ? {
        object: "page",
        entry: [
          {
            id: accountId,
            time: stamp,
            changes: [
              {
                field: "feed",
                value: {
                  item: "comment",
                  verb: "add",
                  comment_id: commentId,
                  post_id: `${accountId}_1`,
                  parent_id: `${accountId}_1`,
                  created_time: stamp,
                  from: { id: authorId, name: "Test Person" },
                  message: text,
                },
              },
            ],
          },
        ],
      }
    : {
        object: "instagram",
        entry: [
          {
            id: accountId,
            time: stamp,
            changes: [
              {
                field: "comments",
                value: {
                  from: { id: authorId, username: "test_person" },
                  media: { id: "test_media_1", media_product_type: "FEED" },
                  id: commentId,
                  text,
                },
              },
            ],
          },
        ],
      };

const raw = JSON.stringify(body);
const signature = `sha256=${createHmac("sha256", appSecret()).update(raw).digest("hex")}`;

const res = await fetch(target, {
  method: "POST",
  headers: { "content-type": "application/json", "x-hub-signature-256": signature },
  body: raw,
});

console.log(`${platform} "${text}" -> ${res.status} ${await res.text()}`);
console.log(`comment id: ${commentId}`);
console.log(`account id: ${accountId} (override with ACCOUNT=…)`);
console.log("Watch the Worker logs for the match/skip line (`npm run tail` when deployed).");
