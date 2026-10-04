import { igLoginMode, loadAccounts, signingSecrets } from "./accounts";
import { RULES } from "./config";
import { GraphError, refreshInstagramToken } from "./graph";
import { handleComment } from "./handle";
import { dataDeletionPage, privacyPage, termsPage, type SiteConfig } from "./pages";
import { parseComments } from "./parse";
import type { Env } from "./types";
import { handleVerification, verifySignature } from "./verify";

function siteConfig(env: Env, url: URL): SiteConfig {
  return {
    appName: env.APP_NAME || "Comment Automation",
    contactEmail: env.CONTACT_EMAIL || "privacy@example.com",
    origin: url.origin,
    legalName: env.LEGAL_NAME || undefined,
  };
}

function html(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Meta re-crawls these; a short cache keeps them fresh without hammering us.
      "cache-control": "public, max-age=3600",
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET") {
      switch (url.pathname) {
        case "/privacy":
          return html(privacyPage(siteConfig(env, url)));
        case "/terms":
          return html(termsPage(siteConfig(env, url)));
        case "/data-deletion":
          return html(dataDeletionPage(siteConfig(env, url)));
      }
    }

    if (url.pathname === "/health") {
      // Deliberately does not list rules, keywords, account ids or labels — this
      // endpoint is public. Counts are enough to confirm a deploy landed.
      const accounts = await loadAccounts(env);
      return Response.json({
        ok: true,
        dryRun: env.DRY_RUN === "true",
        instagram: accounts.some((a) => a.platform === "instagram"),
        facebook: accounts.some((a) => a.platform === "facebook"),
        accountCount: accounts.length,
        ruleCount: RULES.length,
      });
    }

    if (url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "GET") {
      return handleVerification(url, env.VERIFY_TOKEN);
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const raw = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    const accounts = await loadAccounts(env);
    // Facebook (page/feed) signs with the app's main secret. Instagram, when using
    // Instagram Login, signs with its own separate Instagram app secret — a distinct
    // value under the Instagram API's "API setup with Instagram login" page, not App
    // Settings -> Basic. Accounts belonging to a *different* Meta app carry their own
    // appSecret, so every known secret is a candidate.
    const candidateSecrets = signingSecrets(env, accounts);
    const signatureOk = (
      await Promise.all(candidateSecrets.map((secret) => verifySignature(raw, signature, secret)))
    ).some(Boolean);
    if (!signatureOk) {
      console.log("rejected: bad signature");
      return new Response("Invalid signature", { status: 401 });
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    const events = parseComments(body);

    // Meta expects a 200 within a few seconds and retries otherwise. Ack now,
    // finish the API calls in the background.
    ctx.waitUntil(
      Promise.all(
        events.map((event) =>
          handleComment(env, event, accounts).catch((err) => {
            const detail = err instanceof GraphError ? err.detail : (err as Error).message;
            console.error(`handle ${event.platform}:${event.commentId} failed: ${detail}`);
          }),
        ),
      ),
    );

    return new Response("EVENT_RECEIVED", { status: 200 });
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const accounts = await loadAccounts(env);
    // Only Instagram-Login accounts have expiring tokens. Page tokens don't expire,
    // so those accounts are skipped rather than failing loudly once a day.
    const refreshable = accounts.filter(
      (a) => a.platform === "instagram" && igLoginMode(env, a) === "instagram",
    );
    if (!refreshable.length) return;

    // One failure must not stop the others — an expired token on one account would
    // otherwise take every other account's refresh down with it.
    const results = await Promise.allSettled(
      refreshable.map(async (account) => {
        await refreshInstagramToken(env, account);
        console.log(`instagram token refreshed for ${account.label}`);
      }),
    );
    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        console.error(
          `instagram token refresh failed for ${refreshable[i]!.label}:`,
          result.reason,
        );
      }
    }
  },
};
