// cf-orbs doctor: PASS/FAIL per check with a one-line fix, plus INFO hints and WARN lines that never fail.
// Read-only: never starts a provider or an orb.

import { existsSync } from "node:fs";
import { collectImageKeys, expectOk, providerInfo } from "../api.js";
import { type CfOrbsConfig, CONFIG_FILE, loadConfig, orbImageKeys } from "../config.js";
import { connect } from "../connect.js";
import type { Ctx } from "../context.js";
import { CliError, toFailedLine } from "../errors.js";
import { fileChecks } from "../file-checks.js";
import { fileMode, readState } from "../project.js";
import { classifyDeployFailure, lastErrorLine, makeWrangler } from "../wrangler.js";
import { AMP_CACHE_HINT } from "./snapshots.js";

export type CheckStatus = "PASS" | "FAIL" | "SKIP" | "INFO" | "WARN";
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

const pass = (name: string, detail: string): Check => ({ name, status: "PASS", detail });
const failed = (name: string, e: unknown): Check => ({ name, status: "FAIL", detail: toFailedLine(e) });
const skip = (name: string, detail: string): Check => ({ name, status: "SKIP", detail });
const info = (name: string, detail: string): Check => ({ name, status: "INFO", detail });

/**
 * INFO, never FAIL: Amp keeps one prepared snapshot per provider for 72 h and cf-orbs cannot see or delete it.
 * After an image or bootstrap change, a stale cache entry makes new threads skip setup on the old disk.
 */
export function ampCacheCheck(status?: unknown): Check {
  const reg = status && typeof status === "object" ? (status as Record<string, unknown>).registry : undefined;
  const n = reg && typeof reg === "object" ? (reg as Record<string, unknown>).projectSnapshots : undefined;
  const held = typeof n === "number" ? `cf-orbs holds ${n} project snapshot mapping(s). ` : "";
  return info("Amp snapshot cache", `${held}${AMP_CACHE_HINT}`);
}

export function describeInstance(c: CfOrbsConfig): string {
  const i = c.instance;
  return typeof i === "string" ? i : `${i.vcpu} vCPU, ${i.memoryMib} MiB, ${i.diskMb} MB disk`;
}

/**
 * Checks that need only /v1/status and the config. Pure.
 * tokenSecret: whether the Worker has AMP_ORB_PROVIDER_TOKEN (from wrangler secret list), if known.
 */
export function statusChecks(
  status: unknown,
  config: CfOrbsConfig,
  opts: { tokenSecret?: boolean; wranglerPath?: string } = {},
): Check[] {
  const out: Check[] = [];
  const p = providerInfo(status);
  const last = `${p.lastError ? `; last error: ${p.lastError}` : ""}${p.lastLogLine ? `; last log: ${p.lastLogLine}` : ""}`;
  if (config.providerHost === "cloudflare") {
    if (opts.tokenSecret === false) {
      out.push(
        failed(
          "provider",
          new CliError(
            "the Worker has no AMP_ORB_PROVIDER_TOKEN secret, so it runs no provider",
            "rerun cf-orbs init with AMP_ORB_PROVIDER_TOKEN set (or --token-file <file>)",
          ),
        ),
      );
    } else if (p.running === true) out.push(pass("provider", `running${last}`));
    else {
      out.push(
        failed(
          "provider",
          new CliError(
            `provider is ${p.running === false ? "not running" : "not reported"}${last}`,
            "wait for the 5-min cron to restart it, check cf-orbs logs --provider, or rerun cf-orbs init",
          ),
        ),
      );
    }
  } else if (p.running === true) {
    out.push(
      failed(
        "provider",
        new CliError(
          "providerHost is external but the Worker's own provider is running too (two providers on one token)",
          `npx wrangler secret delete AMP_ORB_PROVIDER_TOKEN --config ${opts.wranglerPath ?? ".cf-orbs/wrangler.jsonc"}`,
        ),
      ),
    );
  } else
    out.push(skip("provider", "providerHost is external; check the amp orb provider service on your host"));
  const known = new Set(orbImageKeys(config));
  const used = [...collectImageKeys(status)];
  const stale = used.filter((k) => !known.has(k));
  if (stale.length === 0)
    out.push(pass("image keys", `${used.length} key(s) in use, all built (${[...known].join(", ")})`));
  else {
    out.push(
      failed(
        "image keys",
        new CliError(
          `snapshots or orbs use image keys not in ${CONFIG_FILE}: ${stale.join(", ")}`,
          `add them back to images in ${CONFIG_FILE} with their image/<key>.Dockerfile, then cf-orbs deploy`,
        ),
      ),
    );
  }
  return out;
}

export async function runDoctor(ctx: Ctx): Promise<Check[]> {
  const checks: Check[] = [];
  let config: CfOrbsConfig | undefined;
  try {
    config = await loadConfig(ctx.paths.config);
    checks.push(
      pass(
        "config",
        `${describeInstance(config)}; maxRunning ${config.maxRunning}; providerHost ${config.providerHost}`,
      ),
    );
  } catch (e) {
    checks.push(failed("config", e));
  }
  const state = await readState(ctx.paths);
  const mode = await fileMode(ctx.paths.controlToken);
  if (mode === undefined)
    checks.push(
      failed("control token", new CliError(`${ctx.paths.controlToken} missing`, "run cf-orbs init")),
    );
  else if (mode !== 0o600) {
    checks.push(
      failed(
        "control token",
        new CliError(
          `${ctx.paths.controlToken} has mode ${mode.toString(8)}`,
          `chmod 600 ${ctx.paths.controlToken}`,
        ),
      ),
    );
  } else checks.push(pass("control token", "present, mode 600"));
  checks.push(
    ...(await fileChecks(ctx.run, ctx.paths, config, {
      git: state.mode === "git",
      templates: ctx.templates,
    })),
  );

  const name = config?.name ?? state.workerName ?? "cf-orbs";
  const w = makeWrangler(ctx.run, { accountId: state.accountId });
  const d = await w.run(["deployments", "list", "--json", "--name", name], { timeoutMs: 60_000 });
  let deployments: { created_on?: string }[] = [];
  try {
    deployments = JSON.parse(d.stdout.slice(Math.max(0, d.stdout.indexOf("[")))) as { created_on?: string }[];
  } catch {}
  if (d.code === 0 && Array.isArray(deployments) && deployments.length > 0) {
    checks.push(pass("deployment", `Worker ${name} deployed; latest ${deployments[0]?.created_on ?? "?"}`));
  } else if (d.code !== 0 && !/not found|does not exist|10007/i.test(`${d.stdout}\n${d.stderr}`)) {
    // wrangler itself failed (logged out, expired token, network): do not send the user into a rebuild.
    const out = `${d.stdout}\n${d.stderr}`;
    checks.push(
      failed(
        "deployment",
        classifyDeployFailure(out) === "auth"
          ? new CliError("wrangler is not logged in or its token expired", "run npx wrangler login")
          : new CliError(
              `wrangler deployments list failed: ${lastErrorLine(out)}`,
              "check your network and npx wrangler whoami",
            ),
      ),
    );
  } else {
    checks.push(
      failed(
        "deployment",
        new CliError(`no deployment of Worker ${name} found`, "run cf-orbs deploy (or cf-orbs init)"),
      ),
    );
  }

  let api: Awaited<ReturnType<typeof connect>>["api"] | undefined;
  try {
    api = (await connect(ctx)).api;
  } catch (e) {
    checks.push(failed("health", e));
  }
  let status: unknown;
  // git mode: Workers Builds deploys, so the fix is the build, not cf-orbs deploy
  const apiFailed = (n: string, e: unknown): Check =>
    state.mode === "git" && e instanceof CliError
      ? failed(
          n,
          new CliError(
            e.cause_,
            `wait for the Workers Builds build to finish (Workers & Pages → ${name} → Deployments), or open its build log`,
          ),
        )
      : failed(n, e);
  if (api) {
    try {
      expectOk(await api.get("/v1/health"), "health");
      checks.push(pass("health", `${api.url}/v1/health ok`));
    } catch (e) {
      checks.push(apiFailed("health", e));
    }
    try {
      status = expectOk(await api.get("/v1/status"), "status");
      checks.push(pass("status", "/v1/status ok (control token accepted)"));
    } catch (e) {
      checks.push(apiFailed("status", e));
    }
  }
  // Names only: wrangler secret list never returns values.
  let tokenSecret: boolean | undefined;
  if (config?.providerHost === "cloudflare" && existsSync(ctx.paths.wrangler)) {
    const sl = await makeWrangler(ctx.run, {
      configPath: ctx.paths.wrangler,
      accountId: state.accountId,
    }).run(["secret", "list", "--format", "json"], { timeoutMs: 60_000 });
    if (sl.code === 0) {
      try {
        const list = JSON.parse(sl.stdout.slice(Math.max(0, sl.stdout.indexOf("[")))) as { name?: string }[];
        if (Array.isArray(list)) tokenSecret = list.some((x) => x.name === "AMP_ORB_PROVIDER_TOKEN");
      } catch {}
    }
  }
  if (status !== undefined && config)
    checks.push(...statusChecks(status, config, { tokenSecret, wranglerPath: ctx.paths.wrangler }));
  else {
    checks.push(skip("provider", "needs /v1/status and a valid config"));
    checks.push(skip("image keys", "needs /v1/status and a valid config"));
  }
  checks.push(ampCacheCheck(status));
  return checks;
}

export async function doctorCommand(ctx: Ctx): Promise<number> {
  const checks = await runDoctor(ctx);
  const bad = checks.filter((c) => c.status === "FAIL").length;
  ctx.ui.result({ ok: bad === 0, checks });
  const w = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) ctx.ui.out(`${c.status}  ${c.name.padEnd(w)}  ${c.detail}`);
  ctx.ui.out(bad === 0 ? "All checks passed." : `${bad} check(s) failed.`);
  return bad === 0 ? 0 : 1;
}
