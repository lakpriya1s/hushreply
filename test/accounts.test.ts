import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountToken,
  envAccounts,
  findAccount,
  igLoginMode,
  loadAccounts,
  signingSecrets,
  validateAccounts,
} from "../src/accounts.ts";
import type { Account, Env } from "../src/types.ts";

/** Minimal in-memory stand-in for the KV binding. */
function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(key: string, opts?: unknown) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      const type = typeof opts === "string" ? opts : (opts as { type?: string } | undefined)?.type;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

function env(over: Partial<Env> = {}, kv = fakeKv()): Env {
  return {
    STATE: kv as never,
    IG_LOGIN_MODE: "instagram",
    GRAPH_VERSION: "v26.0",
    DRY_RUN: "false",
    APP_NAME: "test",
    CONTACT_EMAIL: "a@b.c",
    LEGAL_NAME: "",
    META_APP_SECRET: "fb_secret",
    VERIFY_TOKEN: "vt",
    ...over,
  } as Env;
}

const ig: Account = { id: "1001", platform: "instagram", label: "main ig", token: "t_ig" };
const fb: Account = { id: "2001", platform: "facebook", label: "shop page", token: "t_fb" };

test("validateAccounts keeps good rows and explains bad ones", () => {
  const { accounts, errors } = validateAccounts([
    { id: "1001", platform: "instagram", label: "main ig", token: "t1" },
    { platform: "instagram", token: "t2" },
    { id: "4001", platform: "twitter", token: "t3" },
    { id: "4002", platform: "facebook" },
    { id: "1001", platform: "instagram", token: "t4" },
    { id: "4003", platform: "facebook", token: "t5", igLoginMode: "nonsense" },
  ]);

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]!.label, "main ig");
  assert.deepEqual(
    errors.map((e) => e.index),
    [1, 2, 3, 4, 5],
  );
  assert.match(errors[0]!.message, /needs an id/);
  assert.match(errors[1]!.message, /platform must be/);
  assert.match(errors[2]!.message, /needs an access token/);
  // A duplicate id would make webhook routing ambiguous.
  assert.match(errors[3]!.message, /duplicate/);
  assert.match(errors[4]!.message, /igLoginMode/);
});

test("validateAccounts falls back to the id for a missing label, and trims", () => {
  const { accounts } = validateAccounts([{ id: " 919 ", platform: "instagram", token: " tok " }]);
  assert.deepEqual(accounts[0], { id: "919", platform: "instagram", label: "919", token: "tok" });
});

test("a non-numeric id is rejected — it would route to no account at all", () => {
  // A real failure: a trailing dot survived a paste and every webhook missed.
  const { accounts, errors } = validateAccounts([
    { id: "100000000000123.", platform: "facebook", label: "page", token: "EAAlongtokenvalue" },
  ]);
  assert.deepEqual(accounts, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /digits only/);
  // Meta ids are numeric, so a username is caught by the same check.
  assert.match(validateAccounts([{ id: "some_username", platform: "instagram", token: "t" }]).errors[0]!.message, /digits only/);
});

test("an app secret pasted into the token field is rejected", () => {
  // Also a real failure: the Instagram app secret and access token sit next to
  // each other on Meta's setup page. App secrets are exactly 32 hex chars.
  const { accounts, errors } = validateAccounts([
    { id: "17841400000000123", platform: "instagram", label: "ig", token: "0123456789abcdef0123456789abcdef" },
  ]);
  assert.deepEqual(accounts, []);
  assert.match(errors[0]!.message, /app secret, not an access token/);

  // A real token is longer, so it passes.
  const ok = validateAccounts([
    { id: "17841400000000123", platform: "instagram", token: "IGAAeyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9longenough" },
  ]);
  assert.deepEqual(ok.errors, []);
  // A 32-char value that isn't hex is a plausible short token, so it's allowed.
  assert.deepEqual(
    validateAccounts([{ id: "1", platform: "facebook", token: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" }]).errors,
    [],
  );
});

test("validateAccounts accepts either an array or a wrapper object", () => {
  const rows = [{ id: "3001", platform: "facebook", token: "t" }];
  assert.equal(validateAccounts(rows).accounts.length, 1);
  assert.equal(validateAccounts({ accounts: rows }).accounts.length, 1);
  assert.equal(validateAccounts(null).accounts.length, 0);
  assert.equal(validateAccounts("nope").accounts.length, 0);
});

test("loadAccounts prefers KV over the env-var fallback", async () => {
  const kv = fakeKv({
    accounts: JSON.stringify([{ id: "1002", platform: "instagram", label: "new", token: "t" }]),
  });
  const accounts = await loadAccounts(
    env({ IG_USER_ID: "1000", IG_ACCESS_TOKEN: "old" }, kv),
  );
  assert.deepEqual(
    accounts.map((a) => a.id),
    ["1002"],
  );
});

test("loadAccounts drops disabled accounts", async () => {
  const kv = fakeKv({
    accounts: JSON.stringify([
      { id: "3001", platform: "instagram", token: "t" },
      { id: "3002", platform: "instagram", token: "t", enabled: false },
    ]),
  });
  const accounts = await loadAccounts(env({}, kv));
  assert.deepEqual(
    accounts.map((a) => a.id),
    ["3001"],
  );
});

test("loadAccounts falls back to env vars when KV is empty or all-invalid", async () => {
  const fallback = { IG_USER_ID: "1001", IG_ACCESS_TOKEN: "t", FB_PAGE_ID: "2001", FB_PAGE_TOKEN: "p" };

  // Nothing stored at all — the pre-multi-account deployment.
  assert.equal((await loadAccounts(env(fallback))).length, 2);
  // Stored but empty, e.g. every row deleted in the dashboard.
  assert.equal((await loadAccounts(env(fallback, fakeKv({ accounts: "[]" })))).length, 2);
  // Stored but unusable — better to keep working than to go silent.
  const junk = fakeKv({ accounts: JSON.stringify([{ platform: "instagram" }]) });
  assert.equal((await loadAccounts(env(fallback, junk))).length, 2);
});

test("envAccounts needs both an id and a token to produce an account", () => {
  assert.equal(envAccounts(env({ IG_USER_ID: "1001" })).length, 0);
  assert.equal(envAccounts(env({ IG_ACCESS_TOKEN: "t" })).length, 0);
  assert.equal(envAccounts(env({ FB_PAGE_ID: "2001", FB_PAGE_TOKEN: "p" }))[0]!.platform, "facebook");
});

test("findAccount routes on the webhook's entry id", () => {
  const accounts = [ig, fb, { ...ig, id: "1002", label: "second ig" }];
  assert.equal(findAccount(accounts, "instagram", "1002")!.label, "second ig");
  assert.equal(findAccount(accounts, "facebook", "2001")!.label, "shop page");
  // Two candidates and no match: guessing could DM from the wrong account.
  assert.equal(findAccount(accounts, "instagram", "unknown"), undefined);
  assert.equal(findAccount(accounts, "instagram", undefined), undefined);
});

test("findAccount tolerates a wrong id when only one account could be meant", () => {
  assert.equal(findAccount([ig, fb], "instagram", "typo")!.id, "1001");
  assert.equal(findAccount([ig, fb], "instagram", undefined)!.id, "1001");
  // Still nothing to fall back on for a platform with no accounts.
  assert.equal(findAccount([ig], "facebook", "2001"), undefined);
});

test("igLoginMode: per-account setting wins over the env default", () => {
  assert.equal(igLoginMode(env(), ig), "instagram");
  assert.equal(igLoginMode(env({ IG_LOGIN_MODE: "facebook" }), ig), "facebook");
  assert.equal(
    igLoginMode(env({ IG_LOGIN_MODE: "facebook" }), { ...ig, igLoginMode: "instagram" }),
    "instagram",
  );
});

test("accountToken prefers the cron's refreshed copy", async () => {
  const kv = fakeKv({ "igtok:1001": "refreshed" });
  assert.equal(await accountToken(env({}, kv), ig), "refreshed");
  assert.equal(await accountToken(env({}, fakeKv()), ig), "t_ig");
  // Page tokens don't expire, so they're never cached or refreshed.
  assert.equal(await accountToken(env({}, fakeKv({ "igtok:2001": "x" })), fb), "t_fb");
});

test("accountToken honours the pre-upgrade global token key", async () => {
  const kv = fakeKv({ ig_access_token: "legacy_refreshed" });
  // Only for the account that owned that key — not for a newly added one.
  assert.equal(await accountToken(env({ IG_USER_ID: "1001" }, kv), ig), "legacy_refreshed");
  assert.equal(await accountToken(env({ IG_USER_ID: "other" }, kv), ig), "t_ig");
});

test("signingSecrets collects every secret a webhook could be signed with", () => {
  const e = env({ IG_APP_SECRET: "ig_secret" });
  assert.deepEqual(signingSecrets(e, [ig, fb]), ["fb_secret", "ig_secret"]);
  // A second Meta app brings its own signing secret.
  assert.deepEqual(signingSecrets(e, [{ ...ig, appSecret: "other_app" }]), [
    "fb_secret",
    "ig_secret",
    "other_app",
  ]);
  // Deduped, so a shared secret isn't checked twice per request.
  assert.deepEqual(signingSecrets(e, [{ ...ig, appSecret: "fb_secret" }]), [
    "fb_secret",
    "ig_secret",
  ]);
});
