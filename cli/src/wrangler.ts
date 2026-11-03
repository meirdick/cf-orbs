// Run wrangler (the CLI's own pinned dependency) and other tools as child processes. Parse their output.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CliError, oneLine } from "./errors.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** called with each output chunk (stdout and stderr) as it arrives */
  onOutput?: (chunk: string) => void;
  timeoutMs?: number;
}

export type Runner = (cmd: string, args: string[], o?: RunOptions) => Promise<RunResult>;

/** Spawn without a shell; stdin is closed so wrangler runs non-interactive (its confirms take the fallback). */
export const runProcess: Runner = (cmd, args, o = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (o.timeoutMs) timer = setTimeout(() => child.kill("SIGTERM"), o.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stdout += s;
      o.onOutput?.(s);
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stderr += s;
      o.onOutput?.(s);
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

/** The wrangler version the CLI depends on (cli/package.json). Git mode pins the same version in package.json. */
export const WRANGLER_PIN = "4.156.0";

/** [command, ...prefix args] that runs the pinned wrangler. Prefers the CLI's own dependency over npx. */
export function wranglerCommand(): [string, string[]] {
  try {
    const req = createRequire(import.meta.url);
    const bin = join(dirname(req.resolve("wrangler/package.json")), "bin", "wrangler.js");
    if (existsSync(bin)) return [process.execPath, [bin]];
  } catch {}
  return [process.platform === "win32" ? "npx.cmd" : "npx", ["--yes", `wrangler@${WRANGLER_PIN}`]];
}

export interface Wrangler {
  run(args: string[], o?: RunOptions): Promise<RunResult>;
}

export function makeWrangler(
  run: Runner = runProcess,
  base: { configPath?: string; accountId?: string } = {},
): Wrangler {
  const [cmd, prefix] = wranglerCommand();
  return {
    run(args, o = {}) {
      const full = [...prefix, ...args];
      if (base.configPath && !args.includes("--config")) full.push("--config", base.configPath);
      return run(cmd, full, {
        ...o,
        env: {
          WRANGLER_SEND_METRICS: "false",
          FORCE_COLOR: "0",
          ...(base.accountId ? { CLOUDFLARE_ACCOUNT_ID: base.accountId } : {}),
          ...o.env,
        },
      });
    },
  };
}

// ---------- parsing ----------

export interface Account {
  id: string;
  name: string;
}

export interface WhoAmI {
  loggedIn: boolean;
  email?: string;
  accounts: Account[];
}

/** Parse `wrangler whoami --json`. */
export function parseWhoami(stdout: string): WhoAmI {
  const start = stdout.indexOf("{");
  if (start === -1) return { loggedIn: false, accounts: [] };
  try {
    const j = JSON.parse(stdout.slice(start)) as {
      loggedIn?: boolean;
      email?: string;
      accounts?: { id: string; name: string }[];
    };
    return {
      loggedIn: j.loggedIn === true,
      email: j.email,
      accounts: (j.accounts ?? []).map((a) => ({ id: a.id, name: a.name })),
    };
  } catch {
    return { loggedIn: false, accounts: [] };
  }
}

/** Find the workers.dev URL in `wrangler deploy` output. Prefers https://<name>.<sub>.workers.dev. */
export function parseWorkerUrl(output: string, name?: string): string | undefined {
  const all = [...output.matchAll(/https:\/\/([a-z0-9-]+)\.([a-z0-9-]+)\.workers\.dev\b/gi)].map((m) => m[0]);
  if (name) {
    const hit = all.find((u) => u.toLowerCase().startsWith(`https://${name.toLowerCase()}.`));
    if (hit) return hit;
  }
  return all[0];
}

export type DeployFailure = "retry" | "paid" | "docker" | "auth" | "subdomain" | "other";

const PUSH_MARKERS =
  /Pushed|Layer already exists|already exists remotely|Preparing .* for Cloudflare Containers|registry\.cloudflare\.com/;

/**
 * Classify a failed deploy. "retry" covers the known registry flakes (M0, R12): the push PUT timing out
 * ("timeout awaiting response headers") and "Unauthorized" at the end of image preparation after a push.
 */
export function classifyDeployFailure(output: string): DeployFailure {
  if (/timeout awaiting response headers/i.test(output)) return "retry";
  if (/Unauthorized/.test(output) && PUSH_MARKERS.test(output)) return "retry";
  if (
    /workers paid|paid plan|upgrade your plan|not entitled|entitlement|containers? (?:is|are) not (?:enabled|available)/i.test(
      output,
    )
  ) {
    return "paid";
  }
  if (
    /Cannot connect to the Docker daemon|docker: command not found|The Docker CLI could not be launched|is docker running/i.test(
      output,
    )
  ) {
    return "docker";
  }
  if (/not logged in|wrangler login|Authentication error|code: 10000\b/i.test(output)) return "auth";
  if (/workers\.dev subdomain/i.test(output)) return "subdomain";
  return "other";
}

/** One-line error for a deploy failure. */
export function deployFailureError(kind: DeployFailure, output: string): CliError {
  switch (kind) {
    case "paid":
      return new CliError(
        "Containers need the Workers Paid plan on this account",
        "upgrade at https://dash.cloudflare.com/?to=/:account/workers/plans then rerun the same cf-orbs command",
      );
    case "docker":
      return new CliError(
        "Docker is not running (wrangler builds the orb image locally)",
        "start Docker, check `docker info`, then rerun",
      );
    case "auth":
      return new CliError(
        "wrangler is not logged in or the token lacks permissions",
        "run npx wrangler login, then rerun",
      );
    case "subdomain":
      return new CliError(
        "this account has no workers.dev subdomain yet",
        "rerun cf-orbs init in a terminal (it registers one) or with --subdomain <name>",
      );
    case "retry":
      return new CliError(
        "image push to registry.cloudflare.com kept failing (timeout or 401)",
        "rerun cf-orbs deploy; pushed layers are kept, so the next try is faster",
      );
    default:
      return new CliError(
        `wrangler deploy failed: ${lastErrorLine(output)}`,
        "fix the error above, then rerun cf-orbs deploy",
      );
  }
}

export type WorkerLookup = { kind: "found" } | { kind: "missing" } | { kind: "unknown"; reason: string };

/**
 * Does a Worker with this name exist in the account? Runs `wrangler deployments list --json --name <name>`.
 * Verified with wrangler 4.156.0: an existing Worker exits 0 and prints a JSON array. A missing one exits 1,
 * prints nothing on stdout and prints `This Worker does not exist on your account. [code: 10007]` on stderr.
 * Any other result (auth, network, bad account id, odd output) is "unknown".
 */
export async function lookupWorker(w: Wrangler, name: string): Promise<WorkerLookup> {
  const r = await w.run(["deployments", "list", "--json", "--name", name], { timeoutMs: 60_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.code === 0) {
    try {
      if (Array.isArray(JSON.parse(r.stdout.slice(Math.max(0, r.stdout.indexOf("["))))))
        return { kind: "found" };
    } catch {}
    return { kind: "unknown", reason: "unreadable wrangler output" };
  }
  if (/\[code: 10007\]|This Worker does not exist/.test(out)) return { kind: "missing" };
  return { kind: "unknown", reason: lastErrorLine(out) };
}

/** Last meaningful line of wrangler output, preferring the "✘ [ERROR]" line. */
export function lastErrorLine(output: string): string {
  const clean = output.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const err = [...lines].reverse().find((l) => /\[ERROR\]/.test(l));
  if (err) return oneLine(err.replace(/^.*\[ERROR\]\s*/, "")).slice(0, 300);
  const notLog = [...lines].reverse().find((l) => !/Logs were written|^real|^user|^sys/.test(l));
  return oneLine(notLog ?? "no output").slice(0, 300);
}

export interface DeployResult {
  url?: string;
  attempts: number;
  output: string;
}

/**
 * `wrangler deploy` with retries for the known registry flakes: up to `retries` extra attempts.
 * Maps the Workers Paid error (and Docker/auth) to a one-line CliError. Never retries those.
 */
export async function deployWithRetry(
  w: Wrangler,
  args: string[],
  o: {
    name?: string;
    retries?: number;
    onOutput?: (s: string) => void;
    onRetry?: (attempt: number, why: string) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<DeployResult> {
  const retries = o.retries ?? 3;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    const r = await w.run(["deploy", ...args], { onOutput: o.onOutput });
    const output = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0) return { url: parseWorkerUrl(output, o.name), attempts: attempt, output };
    const kind = classifyDeployFailure(output);
    if (kind === "retry" && attempt <= retries) {
      o.onRetry?.(
        attempt,
        /timeout awaiting/i.test(output) ? "registry push timed out" : "image preparation returned 401",
      );
      await sleep(5_000 * attempt);
      continue;
    }
    throw deployFailureError(kind, output);
  }
}
