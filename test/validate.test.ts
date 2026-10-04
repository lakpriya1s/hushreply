import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve, validateRules } from "../src/rules.ts";

test("valid config produces no errors", () => {
  const { rules, errors } = validateRules({
    rules: [
      { id: "a", keyword: "SOMETHING", dm: "hi" },
      { id: "b", keyword: "price", publicReply: "DMs are open" },
    ],
  });
  assert.deepEqual(errors, []);
  assert.equal(rules.length, 2);
});

test("a rule with neither dm nor publicReply is reported with its index", () => {
  const { rules, errors } = validateRules({
    rules: [{ keyword: "ok", dm: "x" }, { keyword: "broken" }],
  });
  assert.equal(rules.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.index, 1);
  assert.equal(errors[0]!.id, "broken");
  assert.match(errors[0]!.message, /needs a DM/i);
});

test("a like counts as an action on its own", () => {
  // Before `like` existed, a rule with no dm and no reply was always invalid.
  const { rules, errors } = validateRules({
    rules: [{ keyword: "thanks", like: true }],
  });
  assert.deepEqual(errors, []);
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.like, true);
  assert.equal(rules[0]!.dm, undefined);
  assert.deepEqual(rules[0]!.publicReply, []);
});

test("a rule with nothing at all still names the like option", () => {
  const { errors } = validateRules({ rules: [{ keyword: "empty" }] });
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /needs a DM, a public reply, a like/);
});

test("like defaults to false and can come from defaults", () => {
  assert.equal(validateRules({ rules: [{ keyword: "a", dm: "x" }] }).rules[0]!.like, false);
  const withDefault = validateRules({
    defaults: { like: true },
    rules: [{ keyword: "a", dm: "x" }],
  });
  assert.equal(withDefault.rules[0]!.like, true);
});

test("an Instagram-only like rule is refused — Instagram has no like API", () => {
  const { rules, errors } = validateRules({
    rules: [{ keyword: "a", like: true, platforms: ["instagram"] }],
  });
  assert.deepEqual(rules, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /like only works on Facebook/);
});

test("a like rule spanning both platforms is allowed", () => {
  // The like applies on Facebook and is skipped on Instagram, which is useful
  // rather than an error — as long as something else can happen on Instagram.
  const { rules, errors } = validateRules({
    rules: [{ keyword: "a", like: true, dm: "hi", platforms: ["instagram", "facebook"] }],
  });
  assert.deepEqual(errors, []);
  assert.equal(rules[0]!.like, true);
});

test("keyword-less rule with a real match mode is reported", () => {
  const { errors } = validateRules({ rules: [{ match: "word", publicReply: "hi" }] });
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /needs a keyword/i);
});

test("an invalid regex is caught instead of throwing at match time", () => {
  const { rules, errors } = validateRules({
    rules: [{ id: "bad", keyword: "([unclosed", match: "regex", dm: "x" }],
  });
  assert.deepEqual(rules, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /invalid regex/i);
});

test("a valid regex passes", () => {
  const { errors } = validateRules({
    rules: [{ keyword: "\\d+usd", match: "regex", dm: "x" }],
  });
  assert.deepEqual(errors, []);
});

test("duplicate ids are rejected — they would share cooldown state", () => {
  const { rules, errors } = validateRules({
    rules: [
      { id: "dup", keyword: "a", dm: "1" },
      { id: "dup", keyword: "b", dm: "2" },
    ],
  });
  assert.equal(rules.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /duplicate id/i);
});

test("two keywords differing only in case would collide on the derived id", () => {
  // Ids default to the lowercased keyword, so this is a real footgun worth catching.
  const { errors } = validateRules({
    rules: [{ keyword: "Sale", dm: "1" }, { keyword: "SALE", dm: "2" }],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /duplicate id/i);
});

test("disabled rules are skipped entirely, not validated", () => {
  const { rules, errors } = validateRules({
    rules: [{ keyword: "broken", enabled: false }],
  });
  assert.deepEqual(rules, []);
  assert.deepEqual(errors, []);
});

test("error indexes point at the original array, gaps included", () => {
  const { errors } = validateRules({
    rules: [
      { keyword: "ok1", dm: "x" },
      { keyword: "skipped", enabled: false },
      { keyword: "bad" },
    ],
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.index, 2);
});

test("resolve still returns just the rules, dropping invalid ones", () => {
  const rules = resolve({ rules: [{ keyword: "ok", dm: "x" }, { keyword: "bad" }] });
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.id, "ok");
});

// The tests above all use the legacy flat `rules` array, which doubles as coverage
// that an older rules.json still validates the same way. Sections below.

test("errors say which section the bad rule is in", () => {
  const { rules, errors } = validateRules({
    byAccount: {
      "main ig": [{ keyword: "ok", dm: "x" }, { keyword: "broken" }],
      "shop page": [{ keyword: "alsobroken" }],
    },
    shared: [{ keyword: "sharedbroken" }],
  });
  assert.equal(rules.length, 1);
  assert.deepEqual(
    errors.map((e) => [e.section, e.index, e.id]),
    [
      ["main ig", 1, "broken"],
      ["shop page", 0, "alsobroken"],
      ["", 0, "sharedbroken"],
    ],
  );
});

test("the same id in two different sections is fine", () => {
  const { rules, errors } = validateRules({
    byAccount: {
      "main ig": [{ id: "welcome", keyword: "hi", dm: "1" }],
      "shop page": [{ id: "welcome", keyword: "hi", dm: "2" }],
    },
    shared: [{ id: "welcome", keyword: "hi", dm: "3" }],
  });
  assert.deepEqual(errors, []);
  assert.equal(rules.length, 3);
});

test("a duplicate id within one section is still rejected", () => {
  const { errors } = validateRules({
    byAccount: {
      "main ig": [
        { id: "dup", keyword: "a", dm: "1" },
        { id: "dup", keyword: "b", dm: "2" },
      ],
    },
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.section, "main ig");
  assert.match(errors[0]!.message, /within a section/i);
});

test("a rule under an account must not also name accounts itself", () => {
  const { rules, errors } = validateRules({
    byAccount: { "main ig": [{ keyword: "x", dm: "1", accounts: ["shop page"] }] },
  });
  assert.deepEqual(rules, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /already under "main ig"/);
});

test("empty and missing sections are harmless", () => {
  assert.deepEqual(validateRules({}), { rules: [], errors: [] });
  assert.deepEqual(validateRules({ byAccount: {}, shared: [] }), { rules: [], errors: [] });
  assert.deepEqual(validateRules({ byAccount: { "main ig": [] } }), { rules: [], errors: [] });
  // A malformed section value must not throw.
  assert.deepEqual(validateRules({ byAccount: { "main ig": null } } as never), {
    rules: [],
    errors: [],
  });
});

test("byAccount and a legacy rules array can coexist during a migration", () => {
  const rules = resolve({
    byAccount: { "main ig": [{ id: "own", keyword: "a", dm: "1" }] },
    rules: [{ id: "legacy", keyword: "b", dm: "2" }],
  });
  assert.deepEqual(
    rules.map((r) => [r.id, r.accounts]),
    [
      ["own", ["main ig"]],
      ["legacy", []],
    ],
  );
});

test("the shipped rules.json has no validation errors", async () => {
  const cfg = (await import("../rules.json", { with: { type: "json" } })).default;
  const { errors } = validateRules(cfg as never);
  assert.deepEqual(errors, []);
});
