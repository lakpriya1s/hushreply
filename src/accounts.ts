import type { Account, AccountError, Env, Platform } from "./types";

/** KV key holding the JSON array of accounts. Written by the local dashboard. */
export const ACCOUNTS_KEY = "accounts";

/**
 * Refreshed Instagram tokens are cached per account, so the cron never has to
 * rewrite the shared `accounts` blob (which the dashboard also writes).
 */
export function tokenKey(accountId: string): string {
  return `igtok:${accountId}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

/**
 * Turns whatever is in KV into accounts, reporting why any were dropped. Pure —
 * the dashboard imports this to block a bad save, the Worker just takes
 * `.accounts` and logs the rest.
 */
export function validateAccounts(raw: unknown): { accounts: Account[]; errors: AccountError[] } {
  const accounts: Account[] = [];
  const errors: AccountError[] = [];
  const seen = new Set<string>();

  const input = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { accounts?: unknown } | null)?.accounts)
      ? ((raw as { accounts: unknown[] }).accounts)
      : [];

  for (let index = 0; index < input.length; index++) {
    const a = (typeof input[index] === "object" && input[index] !== null ? input[index] : {}) as
      Record<string, unknown>;
    const id = str(a.id);
    const platform = str(a.platform);
    const label = str(a.label) || id || `#${index + 1}`;

    if (!id) {
      errors.push({ index, id: label, message: "needs an id (IG user id or FB Page id)" });
      continue;
    }
    // Meta object ids are always digits. Catching this here matters because a
    // stray pasted character produces a webhook that routes to no account at all.
    if (!/^\d+$/.test(id)) {
      errors.push({
        index,
        id: label,
        message: `id "${id}" must be digits only — check for a stray character on the end`,
      });
      continue;
    }
    if (platform !== "instagram" && platform !== "facebook") {
      errors.push({ index, id: label, message: `platform must be "instagram" or "facebook"` });
      continue;
    }
    const token = str(a.token);
    if (!token) {
      errors.push({ index, id: label, message: "needs an access token" });
      continue;
    }
    // An app secret is exactly 32 hex characters; access tokens are far longer.
    // The two sit next to each other on Meta's Instagram setup page, and pasting
    // the wrong one fails with an unhelpful "Cannot parse access token".
    if (/^[0-9a-f]{32}$/i.test(token)) {
      errors.push({
        index,
        id: label,
        message:
          "that looks like a 32-character app secret, not an access token — " +
          "app secrets go on the App keys tab (or the account's own App secret field)",
      });
      continue;
    }
    // Two accounts sharing an id would make webhook routing ambiguous, and the
    // second would silently never fire.
    const dupeKey = `${platform}:${id}`;
    if (seen.has(dupeKey)) {
      errors.push({ index, id: label, message: `duplicate ${platform} id "${id}"` });
      continue;
    }
    seen.add(dupeKey);

    const igLoginMode = str(a.igLoginMode);
    if (igLoginMode && igLoginMode !== "instagram" && igLoginMode !== "facebook") {
      errors.push({ index, id: label, message: `igLoginMode must be "instagram" or "facebook"` });
      continue;
    }

    accounts.push({
      id,
      platform,
      label,
      token,
      ...(str(a.appSecret) ? { appSecret: str(a.appSecret) } : {}),
      ...(igLoginMode ? { igLoginMode: igLoginMode as "instagram" | "facebook" } : {}),
      ...(a.enabled === false ? { enabled: false } : {}),
    });
  }

  return { accounts, errors };
}

/**
 * The pre-multi-account shape: one Instagram account and one Page from env vars.
 * Used only when KV holds no accounts, so an existing deployment (and
 * `npm run dev`, which has no KV data) keeps working with no migration.
 */
export function envAccounts(env: Env): Account[] {
  const out: Account[] = [];
  if (env.IG_USER_ID && env.IG_ACCESS_TOKEN) {
    out.push({
      id: env.IG_USER_ID,
      platform: "instagram",
      label: "instagram (env)",
      token: env.IG_ACCESS_TOKEN,
      igLoginMode: env.IG_LOGIN_MODE,
    });
  }
  if (env.FB_PAGE_ID && env.FB_PAGE_TOKEN) {
    out.push({
      id: env.FB_PAGE_ID,
      platform: "facebook",
      label: "facebook page (env)",
      token: env.FB_PAGE_TOKEN,
    });
  }
  return out;
}

/**
 * Every enabled account, from KV if any are configured there, otherwise from env.
 * `cacheTtl` keeps this off the hot path — a dashboard edit takes up to a minute
 * to be picked up, which is fine for credential changes.
 */
export async function loadAccounts(env: Env): Promise<Account[]> {
  let stored: unknown;
  try {
    stored = await env.STATE.get(ACCOUNTS_KEY, { type: "json", cacheTtl: 60 });
  } catch (err) {
    console.error(`could not read accounts from KV: ${(err as Error).message}`);
  }

  if (stored !== undefined && stored !== null) {
    const { accounts, errors } = validateAccounts(stored);
    for (const e of errors) console.warn(`account "${e.id}" (#${e.index}) skipped: ${e.message}`);
    const live = accounts.filter((a) => a.enabled !== false);
    if (live.length) return live;
    console.warn("KV `accounts` has no usable entries — falling back to env vars");
  }

  return envAccounts(env);
}

/**
 * Which account a webhook belongs to. Meta's `entry.id` is the IG user id or the
 * Page id, so it maps straight onto `Account.id`.
 */
export function findAccount(
  accounts: Account[],
  platform: Platform,
  accountId: string | undefined,
): Account | undefined {
  const forPlatform = accounts.filter((a) => a.platform === platform);
  const exact = accountId ? forPlatform.find((a) => a.id === accountId) : undefined;
  if (exact) return exact;

  // Single-account setups are the common case, and an id mismatch there is almost
  // always a copy-paste error in config rather than a genuinely foreign account.
  // Using it anyway keeps such a setup working, loudly.
  if (forPlatform.length === 1) {
    if (accountId && accountId !== forPlatform[0]!.id) {
      console.warn(
        `webhook for ${platform}:${accountId} does not match the only configured ` +
          `${platform} account (${forPlatform[0]!.id}) — using it anyway. Fix the id.`,
      );
    }
    return forPlatform[0];
  }
  return undefined;
}

export function igLoginMode(env: Env, account: Account): "instagram" | "facebook" {
  return account.igLoginMode ?? env.IG_LOGIN_MODE ?? "instagram";
}

/**
 * The token to use right now: the cron's refreshed copy if there is one, else the
 * one stored with the account.
 */
export async function accountToken(env: Env, account: Account): Promise<string> {
  if (account.platform === "instagram") {
    const cached = await env.STATE.get(tokenKey(account.id));
    if (cached) return cached;
    // Before accounts were per-id, the cron cached the refreshed token under a
    // single global key. Honour it for the account that owned it, so upgrading
    // doesn't fall back to a possibly-stale IG_ACCESS_TOKEN secret.
    if (account.id === env.IG_USER_ID) {
      const legacy = await env.STATE.get("ig_access_token");
      if (legacy) return legacy;
    }
  }
  if (!account.token) throw new Error(`No token for account ${account.label} (${account.id})`);
  return account.token;
}

/** All secrets a webhook signature could legitimately have been signed with. */
export function signingSecrets(env: Env, accounts: Account[]): string[] {
  const secrets = [env.META_APP_SECRET, env.IG_APP_SECRET, ...accounts.map((a) => a.appSecret)];
  return [...new Set(secrets.filter((s): s is string => Boolean(s)))];
}
