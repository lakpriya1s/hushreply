#!/usr/bin/env node
/**
 * Local-only dashboard for editing rules.json, managing account credentials, and
 * deploying the Worker.
 *
 * Bound to 127.0.0.1 on purpose: nothing on the network can reach it, which is why
 * there's no login. Do not put this behind a tunnel or a reverse proxy — it can
 * write files, read and write live tokens, and run deploys.
 *
 * Credentials are never written to disk here. The accounts list lives in the
 * Worker's KV namespace and is read/written by shelling out to `wrangler kv key`,
 * which is why the Worker itself needs no admin route and no auth.
 *
 *   npm run dashboard
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Imported straight from the Worker's source, so validation and the match preview
// use the exact same code the Worker runs — no parallel implementation to drift.
import { validateAccounts } from "../src/accounts.ts";
import { findRule, pickVariant, validateRules } from "../src/rules.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RULES_PATH = join(ROOT, "rules.json");
const PORT = Number(process.env.PORT ?? 8790);

const KV_BINDING = "STATE";
const ACCOUNTS_KEY = "accounts";

/**
 * Worker-level secrets the dashboard is allowed to set. An allowlist, not free
 * text: `wrangler secret put` takes an arbitrary name, and a typo would create a
 * junk secret that the Worker silently ignores.
 */
const SECRET_NAMES = ["META_APP_SECRET", "IG_APP_SECRET", "VERIFY_TOKEN"];

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
};

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function loadConfig() {
  return JSON.parse(await readFile(RULES_PATH, "utf8"));
}

/** Pretty-print the way a human would hand-write it, so git diffs stay readable. */
async function saveConfig(cfg) {
  await writeFile(RULES_PATH, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

/** True when this checkout pushes somewhere, e.g. the repo the Deploy button made. */
async function hasGitRemote() {
  try {
    return /^\[remote "/m.test(await readFile(join(ROOT, ".git", "config"), "utf8"));
  } catch {
    return false;
  }
}

function summarise(rule) {
  return {
    id: rule.id,
    keyword: rule.keyword,
    match: rule.match,
    platforms: rule.platforms,
    accounts: rule.accounts,
    like: rule.like,
    actions: [
      rule.dm ? "dm" : null,
      rule.publicReply.length ? "reply" : null,
      rule.like ? "like" : null,
    ].filter(Boolean),
  };
}

/** Wrangler colours its output; raw escape codes in a JSON error are unreadable. */
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

function spawnWrangler(args, { stdin } = {}) {
  return new Promise((resolve) => {
    const child = spawn("npx", ["wrangler", ...args], { cwd: ROOT, env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: -1, out, err: `${err}\n${e.message}` }));
    child.on("close", (code) => resolve({ code, out, err }));
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Wrangler's OAuth access token is short-lived. When it expires, the invocation
 * that discovers this fails with a bare `401: Unauthorized` from the Cloudflare
 * API and only refreshes for *next* time — so one retry turns a scary stack trace
 * into a hiccup. Every call here is idempotent, so retrying is safe.
 */
const AUTH_FAILURE = /401|unauthori[sz]ed|invalid access token|10000|9109/i;

async function wrangler(args, opts = {}) {
  const first = await spawnWrangler(args, opts);
  if (first.code === 0) return first;
  if (!AUTH_FAILURE.test(`${first.out}${first.err}`)) return first;

  await new Promise((r) => setTimeout(r, 700));
  const second = await spawnWrangler(args, opts);
  if (second.code === 0) {
    console.log(`  (wrangler auth expired; retried "${args.slice(0, 3).join(" ")}" — ok)`);
    return second;
  }
  // Still failing: make the actionable next step obvious rather than dumping a trace.
  return {
    ...second,
    err: `${second.err}\n\nStill unauthorized after a retry — run "npx wrangler login" in a terminal.`,
  };
}

/**
 * wrangler.toml ships with no KV `id`: the Deploy button and `wrangler deploy`
 * create the namespace on first deploy, so `--binding STATE` has nothing to
 * resolve against remotely. Find the namespace id ourselves, in order:
 *   1. an `id` under [[kv_namespaces]] in wrangler.toml, if someone pinned one;
 *   2. the namespace wrangler auto-provisions, titled `<worker name>-state`;
 *   3. the only namespace whose title starts with `<worker name>-`.
 * Local mode never needs this — miniflare keys local KV by binding name.
 */
let namespaceId;

async function resolveNamespaceId() {
  if (namespaceId) return namespaceId;

  const toml = await readFile(join(ROOT, "wrangler.toml"), "utf8");
  // STATE is the only KV binding, so any uncommented `id` in that table is its id.
  const pinned = toml.match(/^\[\[kv_namespaces\]\][^[]*?^\s*id\s*=\s*"([^"]+)"/m);
  if (pinned) return (namespaceId = pinned[1]);

  const worker = toml.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  if (!worker) throw new Error('wrangler.toml has no `name = "..."` line');

  const res = await wrangler(["kv", "namespace", "list"]);
  if (res.code !== 0) {
    throw new Error(`could not list KV namespaces: ${stripAnsi(res.err || res.out).trim()}`);
  }
  let namespaces;
  try {
    namespaces = JSON.parse(res.out.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
  } catch {
    throw new Error("could not parse `wrangler kv namespace list` output");
  }

  const exact = namespaces.find((n) => n.title === `${worker}-state`);
  const prefixed = namespaces.filter((n) => n.title.startsWith(`${worker}-`));
  const found = exact ?? (prefixed.length === 1 ? prefixed[0] : undefined);
  if (found) return (namespaceId = found.id);

  const titles = namespaces.map((n) => `"${n.title}"`).join(", ") || "none";
  throw new Error(
    `couldn't tell which KV namespace belongs to the "${worker}" Worker (found: ${titles}). ` +
      "Deploy it once, or copy the namespace id from the Cloudflare dashboard " +
      '(Storage & Databases → KV) into wrangler.toml as `id = "..."` under [[kv_namespaces]].',
  );
}

/** Where a `wrangler kv key` call should point: the live namespace, or local KV. */
async function kvTarget(remote) {
  return remote
    ? ["--namespace-id", await resolveNamespaceId(), "--remote"]
    : ["--binding", KV_BINDING, "--local"];
}

/**
 * A missing key is not an error worth surfacing — it's just the state before the
 * first save. Wrangler reports it inconsistently: remote exits non-zero with a
 * "404: Not Found" API error, local exits *zero* and prints "Value not found".
 */
const NOT_FOUND = /value not found|not found|does not exist|no value|404/i;

async function readAccounts(remote) {
  const res = await wrangler([
    "kv", "key", "get", ACCOUNTS_KEY, "--text", ...(await kvTarget(remote)),
  ]);
  const text = res.out.trim();

  if (res.code !== 0) {
    if (NOT_FOUND.test(`${res.out}${res.err}`)) return { accounts: [], missing: true };
    throw new Error(`could not read accounts: ${stripAnsi(res.err || res.out).trim()}`);
  }
  if (!text || NOT_FOUND.test(text)) return { accounts: [], missing: true };

  try {
    return { accounts: JSON.parse(text), missing: false };
  } catch {
    throw new Error(`KV key "${ACCOUNTS_KEY}" is not valid JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Tokens go via a temp file rather than argv — anything on a command line is
 * visible to `ps` for every user on the machine.
 */
async function writeAccounts(accounts, remote) {
  const dir = await mkdtemp(join(tmpdir(), "hushreply-"));
  const file = join(dir, "accounts.json");
  try {
    await writeFile(file, JSON.stringify(accounts), { mode: 0o600 });
    const res = await wrangler([
      "kv", "key", "put", ACCOUNTS_KEY, "--path", file, ...(await kvTarget(remote)),
    ]);
    if (res.code !== 0) {
      throw new Error(`could not save accounts: ${stripAnsi(res.err || res.out).trim()}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Only the last few characters, so a token can be identified but not read off screen. */
function maskToken(token) {
  const t = String(token ?? "");
  if (t.length <= 8) return t ? "•".repeat(t.length) : "";
  return `${"•".repeat(12)}${t.slice(-6)}`;
}

function forDisplay(accounts) {
  return accounts.map((a) => ({
    ...a,
    token: maskToken(a.token),
    tokenSet: Boolean(a.token),
    appSecret: maskToken(a.appSecret),
    appSecretSet: Boolean(a.appSecret),
  }));
}

/**
 * The browser sends back masked values for fields the user didn't touch, so any
 * value that is still a mask means "keep what's already stored".
 */
const isMask = (v) => typeof v === "string" && v.startsWith("••");

function mergeSecrets(incoming, existing) {
  const before = new Map(existing.map((a) => [`${a.platform}:${a.id}`, a]));
  return incoming.map((a) => {
    const prev = before.get(`${a.platform}:${a.id}`) ?? {};
    const merged = { ...a };
    if (isMask(a.token) || a.token === undefined) merged.token = prev.token ?? "";
    if (isMask(a.appSecret)) merged.appSecret = prev.appSecret;
    if (!merged.appSecret) delete merged.appSecret;
    delete merged.tokenSet;
    delete merged.appSecretSet;
    return merged;
  });
}

/**
 * Runs commands one after another, streaming their output to the browser as it's
 * produced, and stops at the first failure. `ok` lists output patterns that make a
 * non-zero exit harmless — `git commit` exits 1 when there is nothing to commit.
 */
function runSteps(res, steps) {
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    // Stream output as it's produced rather than buffering to the end.
    "x-content-type-options": "nosniff",
  });

  const next = (i) => {
    if (i === steps.length) {
      res.write("\n--- exited with code 0 ---\n");
      return res.end();
    }
    const { cmd, args, ok } = steps[i];
    res.write(`$ ${cmd} ${args.join(" ")}\n`);
    let out = "";
    const child = spawn(cmd, args, { cwd: ROOT, env: process.env });
    const pipe = (d) => {
      out += d;
      res.write(d);
    };
    child.stdout.on("data", pipe);
    child.stderr.on("data", pipe);
    child.on("error", (err) => res.end(`\nfailed to start ${cmd}: ${err.message}\n`));
    child.on("close", (code) => {
      if (code === 0 || ok?.test(out)) return next(i + 1);
      res.write(`\n--- ${cmd} exited with code ${code} ---\n`);
      res.end();
    });
  };
  next(0);
}

const runDeploy = (res) => runSteps(res, [{ cmd: "npx", args: ["wrangler", "deploy"] }]);

/**
 * For a Worker deployed with the Deploy button: Workers Builds redeploys on every
 * push, so publishing a rule change means committing rules.json and pushing it.
 * Only rules.json is ever committed, whatever else is lying around in the tree.
 */
const runPublish = (res) =>
  runSteps(res, [
    { cmd: "git", args: ["add", "rules.json"] },
    {
      cmd: "git",
      args: ["commit", "-m", "Update rules from the HushReply dashboard", "--", "rules.json"],
      ok: /nothing to commit|no changes added/i,
    },
    { cmd: "git", args: ["push"] },
  ]);

const server = createServer(async (req, res) => {
  try {
    // Defence against DNS rebinding: only accept loopback Host headers even though
    // we're bound to loopback.
    const host = (req.headers.host ?? "").split(":")[0];
    if (host && !["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
      return json(res, 403, { error: `unexpected Host header: ${host}` });
    }

    const url = new URL(req.url, "http://127.0.0.1");
    const remote = url.searchParams.get("local") !== "1";

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const page = await readFile(join(HERE, "index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(page);
    }

    if (req.method === "GET" && url.pathname === "/api/rules") {
      const cfg = await loadConfig();
      const { errors } = validateRules(cfg);
      return json(res, 200, { config: cfg, errors, gitRemote: await hasGitRemote() });
    }

    if (req.method === "PUT" && url.pathname === "/api/rules") {
      let cfg;
      try {
        cfg = JSON.parse(await readBody(req));
      } catch (err) {
        return json(res, 400, { error: `invalid JSON: ${err.message}` });
      }
      if (!cfg || typeof cfg !== "object") {
        return json(res, 400, { error: "expected a config object" });
      }
      const hasSections =
        (cfg.byAccount && typeof cfg.byAccount === "object") || Array.isArray(cfg.shared);
      if (!hasSections && !Array.isArray(cfg.rules)) {
        return json(res, 400, { error: "expected `byAccount`/`shared`, or a legacy `rules` array" });
      }
      const { rules, errors } = validateRules(cfg);
      // Refuse to write a config the Worker would silently drop rules from.
      if (errors.length) return json(res, 422, { errors });
      await saveConfig(cfg);
      return json(res, 200, { saved: true, ruleCount: rules.length, gitRemote: await hasGitRemote() });
    }

    if (req.method === "GET" && url.pathname === "/api/accounts") {
      const { accounts, missing } = await readAccounts(remote);
      const { accounts: valid, errors } = validateAccounts(accounts);
      return json(res, 200, {
        accounts: forDisplay(Array.isArray(accounts) ? accounts : []),
        errors,
        activeCount: valid.filter((a) => a.enabled !== false).length,
        missing,
        remote,
      });
    }

    if (req.method === "PUT" && url.pathname === "/api/accounts") {
      let incoming;
      try {
        incoming = JSON.parse(await readBody(req));
      } catch (err) {
        return json(res, 400, { error: `invalid JSON: ${err.message}` });
      }
      if (!Array.isArray(incoming)) return json(res, 400, { error: "expected an array" });

      // Masked fields mean "unchanged", so the stored copy has to be read first.
      const { accounts: existing } = await readAccounts(remote);
      const merged = mergeSecrets(incoming, Array.isArray(existing) ? existing : []);

      const { accounts, errors } = validateAccounts(merged);
      if (errors.length) return json(res, 422, { errors });

      await writeAccounts(accounts, remote);
      return json(res, 200, {
        saved: true,
        accountCount: accounts.filter((a) => a.enabled !== false).length,
        remote,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/secrets") {
      const res2 = await wrangler(["secret", "list"]);
      let set = [];
      if (res2.code === 0) {
        try {
          // Wrangler prints a JSON array; older versions wrap it in log noise.
          const match = res2.out.match(/\[[\s\S]*\]/);
          if (match) set = JSON.parse(match[0]).map((s) => s.name);
        } catch {
          /* fall through to an empty list — the names are informational */
        }
      }
      return json(res, 200, {
        names: SECRET_NAMES.map((name) => ({ name, set: set.includes(name) })),
      });
    }

    if (req.method === "PUT" && url.pathname === "/api/secrets") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (err) {
        return json(res, 400, { error: `invalid JSON: ${err.message}` });
      }
      const { name, value } = payload ?? {};
      if (!SECRET_NAMES.includes(name)) {
        return json(res, 400, { error: `not a settable secret: ${name}` });
      }
      if (typeof value !== "string" || !value.trim()) {
        return json(res, 400, { error: "value is required" });
      }
      // Piped on stdin, not argv, so the secret never shows up in `ps`.
      const out = await wrangler(["secret", "put", name], { stdin: value.trim() });
      if (out.code !== 0) {
        return json(res, 500, {
          error: stripAnsi(out.err || out.out).trim() || `could not set ${name}`,
        });
      }
      return json(res, 200, { saved: true, name });
    }

    if (req.method === "POST" && url.pathname === "/api/test") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (err) {
        return json(res, 400, { error: `invalid JSON: ${err.message}` });
      }
      const {
        text = "",
        platform = "instagram",
        isReply = false,
        accountId,
        accountLabel,
      } = payload ?? {};
      // Test against the unsaved editor state when provided, so you can check a
      // change before committing it to disk.
      const cfg = payload?.config ?? (await loadConfig());
      const { rules, errors } = validateRules(cfg);
      if (errors.length) return json(res, 422, { errors });

      const commentId = payload?.commentId ?? "preview_comment";
      const rule = findRule(
        { platform, commentId, text, isReply, authorId: "preview_user", accountId, accountLabel },
        rules,
      );
      if (!rule) return json(res, 200, { matched: false });

      return json(res, 200, {
        matched: true,
        rule: summarise(rule),
        dm: rule.dm ?? null,
        publicReply: pickVariant(rule.publicReply, commentId) ?? null,
        cooldownHours: rule.cooldownHours,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/deploy") {
      return runDeploy(res);
    }

    if (req.method === "POST" && url.pathname === "/api/publish") {
      if (!(await hasGitRemote())) return json(res, 400, { error: "this folder has no git remote to push to" });
      return runPublish(res);
    }

    return json(res, 404, { error: "not found" });
  } catch (err) {
    // Operational failures (expired wrangler auth, a KV hiccup) are normal here and
    // the message already says what to do — a stack trace just buries it.
    console.error(`  ! ${err.message.split("\n")[0]}`);
    if (!res.headersSent) return json(res, 500, { error: err.message });
    res.end();
  }
});

/**
 * A dashboard left running from an earlier session is the normal cause of this, and
 * node's default is an unhandled 'error' event with a stack trace that says nothing
 * useful. Say what happened and how to fix it instead.
 *
 * Note the `-sTCP:LISTEN`: without it, `lsof -ti:PORT` also lists *clients* with an
 * open connection to the port, so a browser tab pointed at the dashboard gets caught
 * up in the kill.
 */
server.on("error", (err) => {
  if (err.code !== "EADDRINUSE") throw err;
  console.error(`\n  Port ${PORT} is already in use.\n`);
  console.error(`  Most likely a dashboard is already running — try opening it first:`);
  console.error(`      http://127.0.0.1:${PORT}\n`);
  console.error(`  If it's stale (serving older code than you have on disk), stop it with:`);
  console.error(`      lsof -tiTCP:${PORT} -sTCP:LISTEN | xargs kill\n`);
  console.error(`  Or run this one somewhere else:`);
  console.error(`      PORT=8791 npm run dashboard\n`);
  process.exit(1);
});

/** Opens the dashboard in the default browser. Set NO_OPEN=1 to skip. */
function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  HushReply dashboard → http://127.0.0.1:${PORT}\n`);
  openBrowser(`http://127.0.0.1:${PORT}`);
  console.log(`  rules      ${RULES_PATH}`);
  console.log(`  accounts   KV "${ACCOUNTS_KEY}" via wrangler (tokens never written to disk)`);
  console.log("  local only — not reachable from the network\n");
});
