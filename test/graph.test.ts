import assert from "node:assert/strict";
import { test } from "node:test";
import { GraphError } from "../src/graph.ts";

/**
 * These getters decide whether a failed send is terminal or gets retried, so a
 * misclassification either drops a DM that would have worked or re-attempts one
 * Meta has already refused. Codes here are ones seen in the wild, not invented —
 * see docs/meta-research.md §9.
 */
const err = (code?: number, subcode?: number, message = "Meta said no", status = 400) =>
  new GraphError(message, status, code, subcode);

test("not-replyable covers every terminal private-reply refusal", () => {
  // Already private-replied — only one is ever allowed per comment.
  assert.ok(err(10900).isNotReplyable);
  // Comment deleted, or older than 7 days. The most common one in practice.
  assert.ok(err(100, 2534025).isNotReplyable);
  // "The requested user could not be found" — observed live against
  // /{ig-id}/messages with a comment id Meta can't resolve. Equally terminal.
  assert.ok(err(100, 2534014).isNotReplyable);

  // Code 100 on its own is not enough — 100 is Meta's catch-all.
  assert.ok(!err(100).isNotReplyable);
  assert.ok(!err(100, 999).isNotReplyable);
});

test("2534014 is terminal, not an unexpected error", () => {
  // The distinction that matters: an unexpected error releases the KV claim so a
  // redelivery can retry. A terminal one must not, or Meta retries a doomed send.
  const e = err(100, 2534014);
  const terminal =
    e.isNotReplyable || e.isRecipientRestricted || e.isPermissionError || e.isRateLimited;
  assert.ok(terminal, "2534014 must be classified, or handleComment will retry it");
});

test("classification does not depend on the message text, which Meta localises", () => {
  // The 2534014 probe came back in Japanese. Anything relying on English wording
  // silently stops working for other locales.
  const japanese = err(100, 2534014, "リクエストされたユーザーが見つかりません。");
  assert.ok(japanese.isNotReplyable);

  const localisedRateLimit = err(613, undefined, "レート制限に達しました");
  assert.ok(localisedRateLimit.isRateLimited);
});

test("recipient restrictions are told apart from permission problems", () => {
  assert.ok(err(10903).isRecipientRestricted);
  assert.ok(err(undefined, 1893049).isRecipientRestricted);
  assert.ok(!err(10903).isPermissionError);
});

test("permission refusals are recognised, including Meta's generic 100/33", () => {
  for (const code of [200, 10904, 3, 10]) assert.ok(err(code).isPermissionError, String(code));
  assert.ok(err(100, 33).isPermissionError);
  assert.ok(!err(100, 34).isPermissionError);
});

test("rate limits and auth failures are separate buckets", () => {
  for (const code of [613, 4, 32]) assert.ok(err(code).isRateLimited, String(code));
  assert.ok(err(190).isAuthError);
  assert.ok(err(102).isAuthError);
  assert.ok(err(undefined, undefined, "x", 401).isAuthError);
  // An expired token must not read as a rate limit, or it would be silently dropped.
  assert.ok(!err(190).isRateLimited);
});

test("detail always carries the code/subcode pair the logs are read by", () => {
  assert.equal(
    err(100, 2534014, "nope", 400).detail,
    "status=400 code=100 subcode=2534014: nope",
  );
  // Missing values must still render, so a log line is never ambiguous.
  assert.equal(err(undefined, undefined, "nope", 500).detail, "status=500 code=? subcode=-: nope");
});

test("GraphError stays a real Error subclass", () => {
  const e = err(613);
  assert.ok(e instanceof Error);
  assert.equal(e.name, "GraphError");
  assert.equal(e.message, "Meta said no");
  // handleComment branches on `err instanceof GraphError` before classifying.
  assert.ok(e instanceof GraphError);
});
