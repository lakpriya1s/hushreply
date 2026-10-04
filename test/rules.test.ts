import assert from "node:assert/strict";
import { test } from "node:test";
import { findRule, resolve, textMatches } from "../src/rules.ts";

test("word match ignores case and tolerates surrounding punctuation and emoji", () => {
  for (const text of [
    "SOMETHING",
    "something please",
    "hey, Something!",
    "🔥 SOMETHING 🔥",
    "(something)",
    "yes — something.",
  ]) {
    assert.equal(textMatches(text, "SOMETHING", "word", false), true, text);
  }
});

test("word match does not fire on substrings", () => {
  for (const text of ["somethingelse", "presomething", "SOMETHINGS"]) {
    assert.equal(textMatches(text, "SOMETHING", "word", false), false, text);
  }
});

test("contains match fires on substrings, exact does not", () => {
  assert.equal(textMatches("somethingelse", "SOMETHING", "contains", false), true);
  assert.equal(textMatches("something else", "SOMETHING", "exact", false), false);
  assert.equal(textMatches("  something  ", "SOMETHING", "exact", false), true);
});

test("caseSensitive rejects a different casing", () => {
  assert.equal(textMatches("something", "SOMETHING", "word", true), false);
  assert.equal(textMatches("SOMETHING", "SOMETHING", "word", true), true);
});

test("regex mode is honoured and literal modes escape metacharacters", () => {
  assert.equal(textMatches("price is 20usd", "\\d+usd", "regex", false), true);
  // In contains mode the dot must be literal, not "any character".
  assert.equal(textMatches("aXb", "a.b", "contains", false), false);
  assert.equal(textMatches("a.b", "a.b", "contains", false), true);
});

test("resolve applies defaults, keeps overrides, drops disabled rules", () => {
  const rules = resolve({
    defaults: { match: "exact", cooldownHours: 12, platforms: ["instagram"] },
    rules: [
      { keyword: "A", dm: "a" },
      { id: "b", keyword: "B", dm: "b", match: "contains", platforms: ["facebook"] },
      { keyword: "C", dm: "c", enabled: false },
    ],
  });

  assert.equal(rules.length, 2);
  assert.deepEqual(
    rules.map((r) => r.id),
    ["a", "b"],
  );
  assert.equal(rules[0]!.match, "exact");
  assert.equal(rules[0]!.cooldownHours, 12);
  assert.deepEqual(rules[0]!.platforms, ["instagram"]);
  assert.equal(rules[1]!.match, "contains");
  assert.deepEqual(rules[1]!.platforms, ["facebook"]);
});

const event = {
  platform: "instagram" as const,
  commentId: "c1",
  text: "SOMETHING",
  mediaId: "m1",
  authorId: "u1",
  isReply: false,
};

test("findRule respects platform and mediaIds filters", () => {
  const igOnly = resolve({ rules: [{ keyword: "SOMETHING", dm: "x", platforms: ["instagram"] }] });
  assert.ok(findRule(event, igOnly));
  assert.equal(findRule({ ...event, platform: "facebook" }, igOnly), undefined);

  const scoped = resolve({ rules: [{ keyword: "SOMETHING", dm: "x", mediaIds: ["m9"] }] });
  assert.equal(findRule(event, scoped), undefined);
  assert.ok(findRule({ ...event, mediaId: "m9" }, scoped));
});

test("byAccount rules only fire on their own account", () => {
  const rules = resolve({
    byAccount: {
      "main ig": [{ keyword: "SOMETHING", dm: "from main ig" }],
      "shop page": [{ keyword: "SOMETHING", dm: "from shop page" }],
    },
  });
  assert.equal(rules.length, 2);
  assert.equal(findRule({ ...event, accountLabel: "main ig" }, rules)?.dm, "from main ig");
  assert.equal(findRule({ ...event, accountLabel: "shop page" }, rules)?.dm, "from shop page");
  // A comment on an account with no list of its own, and no shared rules.
  assert.equal(findRule({ ...event, accountLabel: "third" }, rules), undefined);
});

test("an account's own rule beats a shared rule with the same id", () => {
  const rules = resolve({
    byAccount: { "main ig": [{ id: "price", keyword: "SOMETHING", dm: "account copy" }] },
    shared: [{ id: "price", keyword: "SOMETHING", dm: "shared copy" }],
  });
  // Same id in different sections is legal: the cooldown key includes the account.
  assert.equal(rules.length, 2);
  assert.equal(findRule({ ...event, accountLabel: "main ig" }, rules)?.dm, "account copy");
  assert.equal(findRule({ ...event, accountLabel: "other" }, rules)?.dm, "shared copy");
});

test("shared rules are checked after every account's own, whatever the key order", () => {
  const rules = resolve({
    // Shared is declared first here on purpose — order in the file must not matter.
    shared: [{ id: "catchall", match: "any", publicReply: "shared" }],
    byAccount: { "main ig": [{ id: "specific", keyword: "SOMETHING", dm: "specific" }] },
  });
  assert.equal(findRule({ ...event, accountLabel: "main ig" }, rules)?.id, "specific");
  assert.equal(findRule({ ...event, accountLabel: "main ig", text: "hello" }, rules)?.id, "catchall");
});

test("a byAccount section can be keyed by account id as well as label", () => {
  const rules = resolve({ byAccount: { "17841400000000000": [{ keyword: "SOMETHING", dm: "x" }] } });
  assert.ok(findRule({ ...event, accountId: "17841400000000000" }, rules));
  assert.equal(findRule({ ...event, accountId: "other" }, rules), undefined);
});

test("legacy flat rules with an accounts field still scope correctly", () => {
  const scoped = resolve({
    rules: [{ keyword: "SOMETHING", dm: "x", accounts: ["main ig", "pg2"] }],
  });
  // Unscoped events (nothing configured yet) still match an unscoped rule.
  assert.equal(findRule(event, scoped), undefined);
  // Either the account's label or its id will do — whichever was easier to type.
  assert.ok(findRule({ ...event, accountLabel: "main ig" }, scoped));
  assert.ok(findRule({ ...event, accountId: "pg2" }, scoped));
  // Labels are matched case-insensitively; ids are not, being exact Meta ids.
  assert.ok(findRule({ ...event, accountLabel: "MAIN IG" }, scoped));
  assert.equal(findRule({ ...event, accountLabel: "other ig" }, scoped), undefined);

  const everywhere = resolve({ rules: [{ keyword: "SOMETHING", dm: "x" }] });
  assert.ok(findRule({ ...event, accountLabel: "anything at all" }, everywhere));
});

test("defaults apply inside byAccount sections too", () => {
  const rules = resolve({
    defaults: { match: "contains", cooldownHours: 6, platforms: ["instagram"] },
    byAccount: { "main ig": [{ keyword: "SOMETHING", dm: "x" }] },
  });
  assert.equal(rules[0]!.match, "contains");
  assert.equal(rules[0]!.cooldownHours, 6);
  assert.deepEqual(rules[0]!.platforms, ["instagram"]);
  assert.deepEqual(rules[0]!.accounts, ["main ig"]);
});

test("findRule returns the first match so ordering decides", () => {
  const rules = resolve({
    defaults: { match: "contains" },
    rules: [
      { id: "specific", keyword: "SOMETHING BIG", dm: "1" },
      { id: "general", keyword: "SOMETHING", dm: "2" },
    ],
  });
  assert.equal(findRule({ ...event, text: "something big please" }, rules)?.id, "specific");
  assert.equal(findRule({ ...event, text: "something please" }, rules)?.id, "general");
});
