import type { CommentEvent, MatchMode, Rule, RuleConfig } from "./types";

export interface ResolvedRule {
  id: string;
  /** Empty string when the rule matches every comment. */
  keyword: string;
  dm?: string;
  /** Zero or more variants; one is picked per comment. */
  publicReply: string[];
  /** Like the comment as the Page. Facebook only — no-op on Instagram. */
  like: boolean;
  match: MatchMode;
  caseSensitive: boolean;
  platforms: string[];
  /** Account ids or labels. Empty means every configured account. */
  accounts: string[];
  cooldownHours: number;
  mediaIds?: string[];
  exclude: string[];
  includeReplies: boolean;
}

function asArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).filter((s) => s.trim().length > 0);
}

export interface RuleError {
  /** The account label/id this rule sits under, or "" for the shared list. */
  section: string;
  /** Index within that section, so a UI can point at the right row. */
  index: number;
  id: string;
  message: string;
}

/** The shared list is identified by an empty section key everywhere. */
export const SHARED = "";

interface Section {
  key: string;
  rules: Rule[];
}

/**
 * Flattens the config into ordered sections. Every account's own rules come
 * first, then the shared ones — so for any given comment the account's rule wins
 * a tie, and a shared rule acts as the fallback. Rules scoped to a *different*
 * account can't match, so interleaving accounts here is harmless.
 */
function sections(cfg: RuleConfig): Section[] {
  const out: Section[] = [];
  for (const [key, rules] of Object.entries(cfg.byAccount ?? {})) {
    if (Array.isArray(rules) && key !== SHARED) out.push({ key, rules });
  }
  out.push({ key: SHARED, rules: [...(cfg.shared ?? []), ...(cfg.rules ?? [])] });
  return out;
}

/**
 * Resolves rules and reports why any were dropped. The dashboard uses the errors
 * to block a save; the Worker just takes `.rules`.
 */
export function validateRules(cfg: RuleConfig): { rules: ResolvedRule[]; errors: RuleError[] } {
  const d = cfg.defaults ?? {};
  const out: ResolvedRule[] = [];
  const errors: RuleError[] = [];

  for (const section of sections(cfg)) {
    // Ids only have to be unique within a section: the cooldown key includes the
    // account id, so two accounts can each have a rule called "welcome".
    const seenIds = new Set<string>();

    for (let index = 0; index < section.rules.length; index++) {
      const r = section.rules[index]!;
      const fail = (id: string, message: string) =>
        errors.push({ section: section.key, index, id, message });
      if (r.enabled === false) continue;

      const keyword = r.keyword ?? "";
      // No keyword only makes sense as a catch-all, and "any" ignores the keyword.
      const match: MatchMode = r.match ?? (keyword === "" ? "any" : (d.match ?? "word"));
      const publicReply = asArray(r.publicReply ?? d.publicReply);
      const like = r.like ?? d.like ?? false;
      const platforms = r.platforms ?? d.platforms ?? ["instagram", "facebook"];

      const id = r.id ?? (keyword === "" ? "catch-all" : keyword.toLowerCase());

      if (!r.dm && publicReply.length === 0 && !like) {
        fail(id, "needs a DM, a public reply, a like, or a combination");
        continue;
      }
      // Instagram has no like-a-comment API, so a like-only Instagram rule can
      // never do anything. Mixed platforms are fine — the like just applies to
      // Facebook, which is the behaviour `handleComment` implements.
      if (like && !platforms.includes("facebook")) {
        fail(id, "like only works on Facebook — Instagram has no API for it");
        continue;
      }
      if (match !== "any" && keyword === "") {
        fail(id, `match "${match}" needs a keyword`);
        continue;
      }
      if (match === "regex") {
        try {
          new RegExp(keyword, "u");
        } catch (err) {
          fail(id, `invalid regex: ${(err as Error).message}`);
          continue;
        }
      }
      // Being under an account *and* naming accounts is contradictory; silently
      // picking one would hide a rule that looks like it should fire.
      if (section.key !== SHARED && r.accounts?.length) {
        fail(id, `remove "accounts" — this rule is already under "${section.key}"`);
        continue;
      }
      // Duplicates within a section would share cooldown state, silently
      // throttling each other.
      if (seenIds.has(id)) {
        fail(id, `duplicate id "${id}" — ids must be unique within a section`);
        continue;
      }
      seenIds.add(id);

      out.push({
        id,
        keyword,
        dm: r.dm,
        publicReply,
        like,
        match,
        caseSensitive: r.caseSensitive ?? d.caseSensitive ?? false,
        platforms,
        accounts: section.key === SHARED ? asArray(r.accounts) : [section.key],
        cooldownHours: r.cooldownHours ?? d.cooldownHours ?? 0,
        mediaIds: r.mediaIds,
        exclude: asArray(r.exclude ?? d.exclude),
        includeReplies: r.includeReplies ?? d.includeReplies ?? true,
      });
    }
  }

  return { rules: out, errors };
}

/** Worker-side entry point: rules only, with any problems logged. */
export function resolve(cfg: RuleConfig): ResolvedRule[] {
  const { rules, errors } = validateRules(cfg);
  for (const e of errors) {
    const where = e.section === SHARED ? "shared" : `"${e.section}"`;
    console.warn(`rule "${e.id}" (#${e.index} in ${where}) skipped: ${e.message}`);
  }
  return rules;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function textMatches(
  text: string,
  keyword: string,
  mode: MatchMode,
  caseSensitive: boolean,
): boolean {
  if (mode === "any") return true;

  const flags = caseSensitive ? "u" : "iu";
  switch (mode) {
    case "regex":
      return new RegExp(keyword, flags).test(text);
    case "word":
      // \b is ASCII-only, so hand-roll a boundary that tolerates emoji and
      // punctuation sitting right against the keyword.
      return new RegExp(
        `(?:^|[^\\p{L}\\p{N}_])${escapeRegex(keyword)}(?:$|[^\\p{L}\\p{N}_])`,
        flags,
      ).test(text);
    case "starts":
      return new RegExp(`^\\s*${escapeRegex(keyword)}`, flags).test(text);
    case "exact": {
      const a = text.trim();
      const b = keyword.trim();
      return caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase();
    }
    case "contains":
    default:
      return new RegExp(escapeRegex(keyword), flags).test(text);
  }
}

/**
 * An account-scoped rule is written with either the account's id or its label,
 * whichever the person editing found easier to type.
 */
function accountInScope(rule: ResolvedRule, event: CommentEvent): boolean {
  if (rule.accounts.length === 0) return true;
  return rule.accounts.some(
    (a) =>
      a === event.accountId ||
      (Boolean(event.accountLabel) && a.toLowerCase() === event.accountLabel!.toLowerCase()),
  );
}

/** First matching rule wins, so order rules.json most-specific first. */
export function findRule(
  event: CommentEvent,
  rules: ResolvedRule[],
): ResolvedRule | undefined {
  return rules.find((rule) => {
    if (!rule.platforms.includes(event.platform)) return false;
    if (!accountInScope(rule, event)) return false;
    if (event.isReply && !rule.includeReplies) return false;
    if (rule.mediaIds?.length && (!event.mediaId || !rule.mediaIds.includes(event.mediaId)))
      return false;
    if (rule.exclude.some((word) => textMatches(event.text, word, "contains", false))) return false;
    return textMatches(event.text, rule.keyword, rule.match, rule.caseSensitive);
  });
}

/**
 * Deterministic variant choice, seeded on the comment id: the same comment always
 * gets the same reply, so a retry can't post a different one, while different
 * commenters see different wording.
 */
export function pickVariant(variants: string[], seed: string): string | undefined {
  if (variants.length <= 1) return variants[0];
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return variants[h % variants.length];
}
