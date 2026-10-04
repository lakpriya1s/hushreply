import assert from "node:assert/strict";
import { test } from "node:test";
import { findRule, pickVariant, resolve } from "../src/rules.ts";

const base = {
  platform: "instagram" as const,
  commentId: "c1",
  text: "anything at all",
  mediaId: "m1",
  authorId: "u1",
  isReply: false,
};

test("reply-only rules are allowed (no dm required)", () => {
  const rules = resolve({ rules: [{ keyword: "price", publicReply: "DMs are open" }] });
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.dm, undefined);
  assert.deepEqual(rules[0]!.publicReply, ["DMs are open"]);
});

test("dm-only rules are allowed (no publicReply required)", () => {
  const rules = resolve({ rules: [{ keyword: "x", dm: "hi" }] });
  assert.deepEqual(rules[0]!.publicReply, []);
});

test("a rule with neither dm nor publicReply is dropped", () => {
  const rules = resolve({ rules: [{ keyword: "x" }] });
  assert.deepEqual(rules, []);
});

test("catch-all rule matches every comment", () => {
  const rules = resolve({ rules: [{ match: "any", publicReply: "thanks" }] });
  assert.equal(rules[0]!.id, "catch-all");
  for (const text of ["hello", "🔥", "", "totally unrelated words"]) {
    assert.ok(findRule({ ...base, text }, rules), JSON.stringify(text));
  }
});

test("omitting the keyword implies a catch-all", () => {
  const rules = resolve({ rules: [{ publicReply: "thanks" }] });
  assert.equal(rules[0]!.match, "any");
  assert.ok(findRule(base, rules));
});

test("a keyword-less rule with a real match mode is dropped, not silently catch-all", () => {
  const rules = resolve({ rules: [{ match: "word", publicReply: "thanks" }] });
  assert.deepEqual(rules, []);
});

test("exclude blocks a rule that would otherwise match", () => {
  const rules = resolve({
    rules: [{ match: "any", publicReply: "thanks", exclude: ["http", "follow me"] }],
  });
  assert.ok(findRule({ ...base, text: "great post" }, rules));
  assert.equal(findRule({ ...base, text: "visit http://spam.example" }, rules), undefined);
  assert.equal(findRule({ ...base, text: "FOLLOW ME back" }, rules), undefined);
});

test("includeReplies:false keeps a catch-all out of reply threads", () => {
  const rules = resolve({
    rules: [{ match: "any", publicReply: "thanks", includeReplies: false }],
  });
  assert.ok(findRule({ ...base, isReply: false }, rules));
  assert.equal(findRule({ ...base, isReply: true }, rules), undefined);
});

test("keyword rules still fire inside reply threads by default", () => {
  const rules = resolve({ rules: [{ keyword: "SOMETHING", dm: "x" }] });
  assert.ok(findRule({ ...base, text: "SOMETHING", isReply: true }, rules));
});

test("a reply falls through to the next rule that accepts replies", () => {
  const rules = resolve({
    defaults: { match: "any" },
    rules: [
      { id: "top-level-only", publicReply: "a", includeReplies: false },
      { id: "anywhere", publicReply: "b" },
    ],
  });
  assert.equal(findRule({ ...base, isReply: false }, rules)?.id, "top-level-only");
  assert.equal(findRule({ ...base, isReply: true }, rules)?.id, "anywhere");
});

test("keyword rule beats catch-all when ordered first", () => {
  const rules = resolve({
    rules: [
      { id: "kw", keyword: "SOMETHING", dm: "dm" },
      { id: "catch-all", match: "any", publicReply: "thanks" },
    ],
  });
  assert.equal(findRule({ ...base, text: "SOMETHING" }, rules)?.id, "kw");
  assert.equal(findRule({ ...base, text: "nice" }, rules)?.id, "catch-all");
});

test("pickVariant is deterministic per comment id and spreads across variants", () => {
  const variants = ["a", "b", "c"];
  assert.equal(pickVariant(variants, "c1"), pickVariant(variants, "c1"));
  const seen = new Set(
    Array.from({ length: 300 }, (_, i) => pickVariant(variants, `comment_${i}`)),
  );
  assert.deepEqual([...seen].sort(), ["a", "b", "c"]);
});

test("pickVariant handles the empty and single cases", () => {
  assert.equal(pickVariant([], "c1"), undefined);
  assert.equal(pickVariant(["only"], "c1"), "only");
});

test("publicReply accepts a bare string or an array", () => {
  assert.deepEqual(resolve({ rules: [{ keyword: "x", publicReply: "one" }] })[0]!.publicReply, [
    "one",
  ]);
  assert.deepEqual(
    resolve({ rules: [{ keyword: "x", publicReply: ["one", "two"] }] })[0]!.publicReply,
    ["one", "two"],
  );
  // Blank entries would post an empty comment, so they're stripped.
  assert.deepEqual(
    resolve({ rules: [{ keyword: "x", publicReply: ["one", "  ", ""] }] })[0]!.publicReply,
    ["one"],
  );
});

test("the shipped rules.json parses into usable rules", async () => {
  const cfg = (await import("../rules.json", { with: { type: "json" } })).default;
  const rules = resolve(cfg as never);
  // Don't pin an exact count — rules come and go. It just has to be usable.
  assert.ok(rules.length >= 1);
  // Every enabled rule must do something.
  for (const r of rules) assert.ok(r.dm || r.publicReply.length > 0, r.id);
});
