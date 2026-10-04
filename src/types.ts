export interface Env {
  STATE: KVNamespace;

  // vars
  /** Default login mode for Instagram accounts that don't set their own. */
  IG_LOGIN_MODE: "instagram" | "facebook";
  GRAPH_VERSION: string;
  DRY_RUN: string;
  /** Testing-only escape hatches — "true" disables the check. Keep unset/"false" in real use. */
  DISABLE_SELF_COMMENT_GUARD?: string;
  DISABLE_COOLDOWN?: string;
  /** Shown on the public privacy/terms/data-deletion pages. */
  APP_NAME: string;
  CONTACT_EMAIL: string;
  LEGAL_NAME: string;

  // secrets
  /** App secret for the Facebook app. Also the default webhook-signing secret. */
  META_APP_SECRET: string;
  /** Separate secret Instagram uses to sign webhooks when IG_LOGIN_MODE="instagram". */
  IG_APP_SECRET?: string;
  VERIFY_TOKEN: string;

  // Single-account fallback, used only when the KV `accounts` list is absent or
  // empty. Kept so an existing deployment keeps working untouched, and so
  // `npm run dev` needs nothing but .dev.vars.
  IG_ACCESS_TOKEN?: string;
  IG_USER_ID?: string;
  FB_PAGE_TOKEN?: string;
  FB_PAGE_ID?: string;
}

export type Platform = "instagram" | "facebook";

/**
 * One Instagram professional account or one Facebook Page, with the credentials
 * needed to act on its behalf. Stored as a JSON array in KV under `accounts` and
 * edited from the local dashboard — never in git, since it holds live tokens.
 */
export interface Account {
  /** IG user id or FB Page id. This is what Meta puts in the webhook's `entry.id`. */
  id: string;
  platform: Platform;
  /** Human label used in logs, the dashboard, and rule scoping. */
  label: string;
  /** IG long-lived token, or a Page access token. */
  token: string;
  /**
   * Webhook-signing secret for the Meta app this account belongs to. Only needed
   * when the account lives under a different app than META_APP_SECRET/IG_APP_SECRET.
   */
  appSecret?: string;
  /** Overrides Env.IG_LOGIN_MODE for this account. Instagram only. */
  igLoginMode?: "instagram" | "facebook";
  enabled?: boolean;
}

export interface AccountError {
  /** Index into the input array, so the dashboard can point at the right row. */
  index: number;
  id: string;
  message: string;
}

/** "any" matches every comment — for catch-all auto-reply rules. */
export type MatchMode = "contains" | "exact" | "word" | "starts" | "regex" | "any";

export interface RuleDefaults {
  match?: MatchMode;
  caseSensitive?: boolean;
  platforms?: Platform[];
  /** Per-commenter cooldown before this rule fires for them again. 0 disables. */
  cooldownHours?: number;
  /** Public reply text. An array is rotated so replies don't read as canned. */
  publicReply?: string | string[];
  /**
   * Like the comment as the Page. **Facebook only** — Instagram has no API for it
   * (verified live 2026-08-12, see docs/meta-research.md §12). Meta only supports a
   * plain like; LOVE/HAHA and the other reaction types are not settable by an app.
   */
  like?: boolean;
  /** Skip the rule if the comment contains any of these (case-insensitive). */
  exclude?: string[];
  /** Whether the rule may fire on replies to other comments. Defaults to true. */
  includeReplies?: boolean;
}

export interface Rule extends RuleDefaults {
  /** Stable id used for cooldown bookkeeping. Defaults to the keyword. */
  id?: string;
  /** Omit (or set match:"any") to match every comment. */
  keyword?: string;
  /** DM body. Optional — omit for a reply-only rule. */
  dm?: string;
  /** Only fire on these post/media ids. Empty or absent = any post. */
  mediaIds?: string[];
  enabled?: boolean;
  /**
   * Account ids or labels this rule applies to. Only for rules in the flat
   * `rules` list — a rule under `byAccount` is already scoped by its section.
   */
  accounts?: string[];
}

export interface RuleConfig {
  defaults?: RuleDefaults;
  /**
   * Rules for one account each, keyed by that account's label or id. Every
   * account gets its own independently ordered list, so two accounts can both
   * have a rule called "welcome" without clashing.
   */
  byAccount?: Record<string, Rule[]>;
  /**
   * Rules that apply to every account. Checked *after* an account's own rules,
   * so an account can override a shared rule by reusing its id.
   */
  shared?: Rule[];
  /**
   * The original flat list, from before rules were split per account. Still
   * honoured (as `shared`, with each rule's own `accounts` scope) so an older
   * rules.json keeps working. The dashboard writes the newer shape.
   */
  rules?: Rule[];
}

/** Everything downstream code needs, normalised across the two platforms. */
export interface CommentEvent {
  platform: Platform;
  commentId: string;
  /** Post (Facebook) or media (Instagram) id. */
  mediaId?: string;
  text: string;
  authorId?: string;
  authorName?: string;
  /**
   * The account that received this webhook — Meta's `entry.id`. Selects which
   * account's token sends the DM, and is used to ignore our own comments.
   */
  accountId?: string;
  /** Filled in by `handleComment` once the account is resolved. For rule scoping. */
  accountLabel?: string;
  /** @deprecated Same value as accountId. Kept for existing callers. */
  ownerId?: string;
  isReply: boolean;
}
