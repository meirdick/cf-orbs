// cf-orbs init [dir]: zero to a live provider. plan() is pure (options + probes → steps); runInit() executes.
// Re-runnable: reuses the control token, keeps the Amp token secret when none is given, keeps user files.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { type ApiClient, expectOk, makeApi, providerInfo } from "../api.js";
import { flagBool, flagString } from "../args.js";
import {
  type CfOrbsConfig,
  CONFIG_FILE,
  findTopLevelValue,
  type InstanceSpec,
  instanceForVcpu,
  loadConfig,
  type ProviderHostMode,
  setTopLevelJsonc,
} from "../config.js";
import type { Ctx } from "../context.js";
import { CliError, registerSecret } from "../errors.js";
import { dockerOk, nodeMajor, whoami } from "../probes.js";
import {
  generateToken,
  materialize,
  readControlToken,
  readState,
  type State,
  writeControlToken,
  writeState,
} from "../project.js";
import { checkSubdomain, registerSubdomain, suggestSubdomain, wranglerBearer } from "../subdomain.js";
import { ask, askHidden } from "../ui.js";
import { type Account, makeWrangler, type WhoAmI } from "../wrangler.js";
import { deployProject, startPrewarm } from "./deploy.js";

export interface InitOptions {
  mode: ProviderHostMode;
  nonInteractive: boolean;
  tokenFile?: string;
  accountId?: string;
  providerName: string;
  /** --provider-name, AMP_ORB_PROVIDER_NAME or a saved name was given (else interactive init asks) */
  providerNameExplicit?: boolean;
  /** --subdomain / CF_ORBS_SUBDOMAIN: workers.dev subdomain to register if the account has none */
  subdomain?: string;
  /** --vcpu 1-4: write instance {vcpu N, memoryMib N*3072, diskMb 20000}. Not given: keep the config (default 4). */
  vcpu?: number;
}

export interface InitProbes {
  nodeVersion: string;
  docker: boolean;
  whoami: WhoAmI;
  /** a previous init wrote .cf-orbs/control-token */
  hasControlToken: boolean;
  /** a previous init deployed (state.json has a URL) */
  deployed: boolean;
  /** provider host mode of the previous init or deploy (state.json) */
  prevMode?: ProviderHostMode;
  /** AMP_ORB_PROVIDER_TOKEN is set */
  envToken: boolean;
  /** stdin is a TTY */
  tty: boolean;
}

export type InitStep =
  | { kind: "fail"; error: CliError }
  | { kind: "pick-account"; accounts: Account[] }
  | { kind: "use-account"; accountId: string; accountName?: string }
  | { kind: "subdomain" }
  | { kind: "scaffold"; mode: ProviderHostMode }
  | { kind: "control-token"; action: "generate" | "reuse" }
  | { kind: "amp-token"; source: "env" | "file" | "prompt" | "keep" }
  | { kind: "deploy"; secrets: string[] }
  | { kind: "health" }
  | { kind: "status" }
  | { kind: "start-provider" }
  | { kind: "wait-provider"; timeoutMs: number }
  | { kind: "print-external-env" }
  | { kind: "done"; command: string };

export const PROVIDER_WAIT_MS = 90_000;
/** Provider must stay up this long with no reject, no second-provider line and no restart. */
export const PROVIDER_STABLE_MS = 15_000;
const CRON_PERIOD_MS = 5 * 60_000;

export function helloCommand(providerName: string): string {
  return `amp -ox "hello from cf-orbs" --orb-provider ${providerName}`;
}

/** Pure planner. If a precondition fails, the plan is only the failure steps. */
export function plan(o: InitOptions, p: InitProbes): InitStep[] {
  const fails: InitStep[] = [];
  const interactive = p.tty && !o.nonInteractive;
  if (nodeMajor(p.nodeVersion) < 22) {
    fails.push({
      kind: "fail",
      error: new CliError(
        `Node ${p.nodeVersion} is too old; cf-orbs needs Node 22 or later`,
        "install Node 22+ (https://nodejs.org) and rerun",
      ),
    });
  }
  if (!p.docker) {
    fails.push({
      kind: "fail",
      error: new CliError(
        "Docker is not running (wrangler builds the orb image locally)",
        "start Docker Desktop or the docker daemon, check `docker info`, then rerun",
      ),
    });
  }
  if (!p.whoami.loggedIn) {
    fails.push({
      kind: "fail",
      error: new CliError(
        "wrangler is not logged in to Cloudflare",
        "run npx wrangler login, then rerun cf-orbs init",
      ),
    });
  }
  let account: InitStep | undefined;
  if (p.whoami.loggedIn) {
    const accounts = p.whoami.accounts;
    if (o.accountId) {
      if (accounts.length > 0 && !accounts.some((a) => a.id === o.accountId)) {
        fails.push({
          kind: "fail",
          error: new CliError(
            `account ${o.accountId} is not in wrangler whoami`,
            "pass an account id that npx wrangler whoami lists",
          ),
        });
      } else
        account = {
          kind: "use-account",
          accountId: o.accountId,
          accountName: accounts.find((a) => a.id === o.accountId)?.name,
        };
    } else if (accounts.length === 1)
      account = {
        kind: "use-account",
        accountId: (accounts[0] as Account).id,
        accountName: (accounts[0] as Account).name,
      };
    else if (accounts.length === 0) {
      fails.push({
        kind: "fail",
        error: new CliError(
          "wrangler whoami lists no accounts",
          "run npx wrangler login with an account that has Workers Paid",
        ),
      });
    } else if (interactive) account = { kind: "pick-account", accounts };
    else {
      fails.push({
        kind: "fail",
        error: new CliError(
          `this login has ${accounts.length} Cloudflare accounts`,
          "pass --account-id <id> or set CLOUDFLARE_ACCOUNT_ID",
        ),
      });
    }
  }
  let ampSource: "env" | "file" | "prompt" | "keep" | undefined;
  if (o.mode === "cloudflare") {
    if (o.tokenFile) ampSource = "file";
    else if (p.envToken) ampSource = "env";
    else if (interactive) ampSource = "prompt";
    // Keep only a secret that exists: external mode deletes it from the Worker.
    else if (p.deployed && p.prevMode === "cloudflare") ampSource = "keep";
    else if (p.deployed) {
      fails.push({
        kind: "fail",
        error: new CliError(
          "no Amp provider token (the Worker has none after external mode)",
          "set AMP_ORB_PROVIDER_TOKEN or pass --token-file <file>",
        ),
      });
    } else {
      fails.push({
        kind: "fail",
        error: new CliError(
          "no Amp provider token given",
          "set AMP_ORB_PROVIDER_TOKEN or pass --token-file <file> (create the token in Amp Settings → Orbs → Add Provider)",
        ),
      });
    }
  }
  if (fails.length > 0) return fails;

  const steps: InitStep[] = [account as InitStep, { kind: "scaffold", mode: o.mode }];
  steps.push({ kind: "control-token", action: p.hasControlToken ? "reuse" : "generate" });
  if (ampSource) steps.push({ kind: "amp-token", source: ampSource });
  const secrets = ["CONTROL_TOKEN"];
  // "prompt" may still end as keep (Enter on a re-run); the executor drops the secret then.
  if (ampSource && ampSource !== "keep") secrets.push("AMP_ORB_PROVIDER_TOKEN");
  steps.push({ kind: "subdomain" }, { kind: "deploy", secrets }, { kind: "health" }, { kind: "status" });
  if (o.mode === "cloudflare") {
    steps.push({ kind: "start-provider" }, { kind: "wait-provider", timeoutMs: PROVIDER_WAIT_MS });
  } else steps.push({ kind: "print-external-env" });
  steps.push({ kind: "done", command: helloCommand(o.providerName) });
  return steps;
}

export async function gatherProbes(ctx: Ctx): Promise<InitProbes> {
  const [docker, who, ct, state] = await Promise.all([
    dockerOk(ctx.run),
    whoami(ctx.run),
    readControlToken(ctx.paths),
    readState(ctx.paths),
  ]);
  return {
    nodeVersion: process.versions.node,
    docker,
    whoami: who,
    hasControlToken: ct !== undefined,
    deployed: Boolean(state.url),
    prevMode: state.mode,
    envToken: Boolean(ctx.env.AMP_ORB_PROVIDER_TOKEN?.trim()),
    tty: Boolean(process.stdin.isTTY),
  };
}

function checkAmpToken(ctx: Ctx, t: string): string {
  if (!t)
    throw new CliError(
      "the Amp provider token is empty",
      "copy it from Amp Settings → Orbs → your provider, then rerun",
    );
  if (/\s/.test(t))
    throw new CliError("the Amp provider token contains spaces or newlines", "paste only the token value");
  if (!t.startsWith("aop_live_"))
    ctx.ui.warn("token does not start with aop_live_; Amp provider tokens usually do");
  registerSecret(t);
  return t;
}

export async function runInit(
  ctx: Ctx,
  o: InitOptions,
  steps: InitStep[],
): Promise<{ url?: string; command?: string; providerName?: string }> {
  const { ui, paths } = ctx;
  let state: State = await readState(paths);
  const prevMode = state.mode;
  let accountId = state.accountId;
  let controlToken: string | undefined;
  let ampToken: string | undefined;
  let config: CfOrbsConfig | undefined;
  let api: ApiClient | undefined;
  let url = state.url;
  let lastStatus: unknown;
  let command: string | undefined;
  let providerStartedByCron = false;
  let accountName: string | undefined;
  let providerName = o.providerName;

  // Show every failed precondition in one run, not one per rerun.
  const fails = steps.filter((s): s is Extract<InitStep, { kind: "fail" }> => s.kind === "fail");
  for (const f of fails.slice(0, -1)) ui.warn(f.error.message);

  for (const s of steps) {
    switch (s.kind) {
      case "fail":
        throw s.error;
      case "use-account":
        accountId = s.accountId;
        accountName = s.accountName;
        ui.step(`account: ${accountId}`);
        break;
      case "pick-account": {
        for (const [i, a] of s.accounts.entries()) ui.step(`  ${i + 1}) ${a.name} (${a.id})`);
        const ans = await ask(`Cloudflare account [1-${s.accounts.length}]: `);
        const pick = s.accounts[Number.parseInt(ans, 10) - 1];
        if (!pick)
          throw new CliError(
            `no account number ${JSON.stringify(ans)}`,
            "rerun and type a number from the list, or pass --account-id",
          );
        accountId = pick.id;
        accountName = pick.name;
        break;
      }
      case "subdomain": {
        if (!accountId) break;
        const bearer = await wranglerBearer(makeWrangler(ctx.run, { accountId }));
        if (!bearer) break; // unknown auth type: wrangler deploy reports a missing subdomain itself
        const c = await checkSubdomain(ctx.fetch, accountId, bearer);
        if (c.kind === "has") {
          ui.step(`workers.dev subdomain: ${c.subdomain}`);
          break;
        }
        if (c.kind === "unknown") break;
        let name = o.subdomain;
        if (!name) {
          if (o.nonInteractive || !process.stdin.isTTY) {
            throw new CliError(
              "this account has no workers.dev subdomain yet",
              `rerun with --subdomain <name>, or open https://dash.cloudflare.com/${accountId}/workers/onboarding`,
            );
          }
          const def = suggestSubdomain(accountName);
          name = (await ask(`This account has no workers.dev subdomain. Name for it [${def}]: `)) || def;
        }
        await registerSubdomain(ctx.fetch, accountId, bearer, name);
        ui.step(`workers.dev subdomain: registered ${name}.workers.dev`);
        break;
      }
      case "scaffold": {
        const r = await materialize(paths, {
          templates: ctx.templates,
          configOverrides: { providerHost: s.mode },
        });
        if (r.wroteConfig) ui.step(`scaffold: wrote ${CONFIG_FILE}`);
        if (r.wroteDockerfile) ui.step("scaffold: wrote image/Dockerfile (pinned Amp orb image)");
        // a re-run with another --provider flips providerHost in the existing config
        const text = await readFile(paths.config, "utf8");
        config = await loadConfig(paths.config);
        if (config.providerHost !== s.mode) {
          await writeFile(paths.config, setTopLevelJsonc(text, "providerHost", s.mode));
          config = await loadConfig(paths.config);
          ui.step(`scaffold: providerHost set to ${s.mode}`);
        }
        // --vcpu overwrites "instance"; without it a re-run keeps what the config has
        if (o.vcpu !== undefined && !sameInstance(config.instance, instanceForVcpu(o.vcpu))) {
          const t = await readFile(paths.config, "utf8");
          await writeFile(paths.config, setInstanceJsonc(t, instanceForVcpu(o.vcpu)));
          config = await loadConfig(paths.config);
          ui.step(`scaffold: instance set to ${o.vcpu} vCPU, ${o.vcpu * 3} GiB, 20 GB disk`);
        }
        state = { ...state, accountId, providerName: o.providerName, mode: s.mode, workerName: config.name };
        await writeState(paths, state);
        break;
      }
      case "control-token":
        controlToken = s.action === "reuse" ? await readControlToken(paths) : undefined;
        if (!controlToken) {
          controlToken = generateToken();
          await writeControlToken(paths, controlToken);
          ui.step("control token: generated .cf-orbs/control-token (0600, gitignored)");
        } else ui.step("control token: reusing .cf-orbs/control-token");
        break;
      case "amp-token":
        if (s.source === "env") ampToken = checkAmpToken(ctx, (ctx.env.AMP_ORB_PROVIDER_TOKEN ?? "").trim());
        else if (s.source === "file") {
          const f = o.tokenFile as string;
          if (!existsSync(f))
            throw new CliError(
              `token file ${f} not found`,
              "pass --token-file <path to a file holding the aop_live_ token>",
            );
          ampToken = checkAmpToken(ctx, (await readFile(f, "utf8")).trim());
        } else if (s.source === "prompt") {
          // Keep only a secret that exists: external mode deleted it from the Worker.
          const keep = Boolean(state.url) && prevMode === "cloudflare";
          const t = await askHidden(
            `Amp provider token (aop_live_…, not shown)${keep ? "; Enter keeps the current one" : ""}: `,
          );
          if (t === "" && keep) ui.step("amp token: keeping the current Worker secret");
          else ampToken = checkAmpToken(ctx, t);
          if (!o.providerNameExplicit) {
            const n = (
              await ask(`Amp provider name, as typed in Amp Settings → Orbs [${providerName}]: `)
            ).trim();
            if (n) providerName = n;
            state = { ...state, providerName };
            await writeState(paths, state);
          }
        } else ui.step("amp token: keeping the current Worker secret");
        break;
      case "deploy": {
        if (!config || !controlToken) throw new Error("init plan bug: deploy before scaffold/control-token");
        const secrets: Record<string, string> = { CONTROL_TOKEN: controlToken };
        if (ampToken && s.secrets.includes("AMP_ORB_PROVIDER_TOKEN"))
          secrets.AMP_ORB_PROVIDER_TOKEN = ampToken;
        // In external mode deployProject also deletes AMP_ORB_PROVIDER_TOKEN, so the Worker runs no provider.
        const r = await deployProject(ctx, { config, state: { ...state, accountId }, secrets });
        url = r.url;
        state = await readState(paths);
        api = makeApi(url, controlToken, ctx.fetch);
        break;
      }
      case "health": {
        if (!api) throw new Error("init plan bug: health before deploy");
        // a new workers.dev route can take a few seconds to answer
        const until = ctx.now() + 60_000;
        for (;;) {
          let last: string;
          try {
            const r = await api.get("/v1/health");
            if (r.status === 200) break;
            last = `HTTP ${r.status}`;
          } catch (e) {
            last = (e as Error).message;
          }
          if (ctx.now() >= until)
            throw new CliError(`health check failed after 60 s (${last})`, "run cf-orbs doctor");
          await ctx.sleep(3_000);
        }
        ui.step("health: /v1/health ok");
        break;
      }
      case "status":
        lastStatus = expectOk(await (api as ApiClient).get("/v1/status"), "status check");
        ui.step("health: /v1/status ok (control token accepted)");
        if (config) await startPrewarm(ctx, api as ApiClient, config);
        break;
      case "start-provider": {
        const r = await (api as ApiClient).post("/v1/provider/start");
        if (r.status === 404 || r.status === 405) {
          providerStartedByCron = true;
          ui.step("provider: this Worker starts it on its 5-min cron; waiting for the next tick");
        } else expectOk(r, "provider start");
        break;
      }
      case "wait-provider": {
        // no start route: the cron starts it within 5 min, then it needs the normal start time
        const waitMs = s.timeoutMs + (providerStartedByCron ? CRON_PERIOD_MS : 0);
        const until = ctx.now() + waitMs;
        ui.step(`provider: waiting up to ${waitMs / 1000} s for it to run`);
        // "running" is only the container state; entry.sh keeps it up even when Amp rejects the token.
        let upSince: number | undefined;
        let upExits = 0;
        for (;;) {
          const info = providerInfo(lastStatus);
          const v = judgeProviderLog(info.logTail);
          if (v.kind === "fail") throw v.error;
          if (info.running === true) {
            if (upSince === undefined || v.exits > upExits) {
              upSince = ctx.now();
              upExits = v.exits;
            }
            if (ctx.now() - upSince >= PROVIDER_STABLE_MS) {
              ui.step(`provider: running${info.lastLogLine ? ` — ${info.lastLogLine}` : ""}`);
              break;
            }
          } else upSince = undefined;
          if (ctx.now() >= until) {
            throw new CliError(
              `provider did not report running within ${waitMs / 1000} s`,
              "run cf-orbs doctor in a few minutes; the 5-min cron retries the start",
            );
          }
          await ctx.sleep(5_000);
          lastStatus = expectOk(await (api as ApiClient).get("/v1/status"), "status check");
        }
        break;
      }
      case "print-external-env":
        ui.out("External provider mode. On an always-on host with the amp CLI, run:");
        ui.out("  export AMP_ORB_PROVIDER_TOKEN=<your aop_live_ token>");
        ui.out(`  export CF_ORBS_URL=${url}`);
        ui.out(`  export CF_ORBS_CONTROL_TOKEN_FILE=${paths.controlToken}`);
        ui.out(`  amp orb provider ${paths.stateDir}/dispatch/dispatch.sh`);
        ui.out("Copy the token file with its 0600 mode if the host is another machine.");
        break;
      case "done":
        command = s.command === helloCommand(o.providerName) ? helloCommand(providerName) : s.command;
        ui.step(`provider name ${providerName} must match the name in Amp Settings → Orbs`);
        break;
    }
  }
  return { url, command, providerName };
}

/**
 * Read the provider log tail from /v1/status. Only lines since the last container start count.
 * Fails on a rejected token or a second provider on the same token; counts restarts.
 */
export function judgeProviderLog(
  tail: string[],
): { kind: "ok"; exits: number } | { kind: "fail"; error: CliError } {
  let start = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (/\bstarting; amp /.test(tail[i] as string)) {
      start = i;
      break;
    }
  }
  const lines = tail.slice(start);
  if (lines.some((l) => /rejected the orb provider token/i.test(l)))
    return {
      kind: "fail",
      error: new CliError(
        "Amp rejected the provider token (wrong or revoked)",
        "create a token in Amp Settings → Orbs → your provider, then cf-orbs init --token-file <file>",
      ),
    };
  if (lines.some((l) => /Another amp orb provider is connected/i.test(l)))
    return {
      kind: "fail",
      error: new CliError(
        "another amp orb provider already uses this token, so this one takes no jobs",
        "stop the other provider (or use a separate token), then rerun cf-orbs init",
      ),
    };
  return { kind: "ok", exits: lines.filter((l) => /amp orb provider exited with code/.test(l)).length };
}

function sameInstance(a: InstanceSpec, b: { vcpu: number; memoryMib: number; diskMb: number }): boolean {
  return typeof a === "object" && a.vcpu === b.vcpu && a.memoryMib === b.memoryMib && a.diskMb === b.diskMb;
}

/** Set "instance" on one line, as the example config has it. */
function setInstanceJsonc(text: string, i: { vcpu: number; memoryMib: number; diskMb: number }): string {
  const span = findTopLevelValue(text, "instance");
  if (!span) return setTopLevelJsonc(text, "instance", i);
  const one = `{ "vcpu": ${i.vcpu}, "memoryMib": ${i.memoryMib}, "diskMb": ${i.diskMb} }`;
  return text.slice(0, span.start) + one + text.slice(span.end);
}

/** --vcpu value → 1..4, or undefined when the flag is not given. */
export function parseVcpuFlag(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!/^[1-4]$/.test(v))
    throw new CliError(
      `--vcpu must be 1, 2, 3 or 4, got ${JSON.stringify(v)}`,
      "pass --vcpu 4 (default, 12 GiB) or --vcpu 2 (6 GiB, about half the cost)",
    );
  return Number(v);
}

export function initOptions(
  ctx: Ctx,
  existing?: { providerHost?: ProviderHostMode; name?: string; providerName?: string },
): InitOptions {
  const modeFlag = flagString(ctx.args, "provider");
  if (modeFlag !== undefined && modeFlag !== "cloudflare" && modeFlag !== "external") {
    throw new CliError(
      `--provider must be cloudflare or external, got ${modeFlag}`,
      "pass --provider cloudflare (default) or --provider external",
    );
  }
  const explicitName =
    flagString(ctx.args, "provider-name") ?? ctx.env.AMP_ORB_PROVIDER_NAME ?? existing?.providerName;
  return {
    providerNameExplicit: explicitName !== undefined,
    subdomain: flagString(ctx.args, "subdomain") ?? ctx.env.CF_ORBS_SUBDOMAIN ?? undefined,
    vcpu: parseVcpuFlag(flagString(ctx.args, "vcpu")),
    mode: (modeFlag as ProviderHostMode | undefined) ?? existing?.providerHost ?? "cloudflare",
    nonInteractive: flagBool(ctx.args, "non-interactive") || Boolean(ctx.env.CI),
    tokenFile: flagString(ctx.args, "token-file"),
    accountId: flagString(ctx.args, "account-id") ?? ctx.env.CLOUDFLARE_ACCOUNT_ID ?? undefined,
    providerName:
      flagString(ctx.args, "provider-name") ??
      ctx.env.AMP_ORB_PROVIDER_NAME ??
      existing?.providerName ??
      existing?.name ??
      "cf-orbs",
  };
}

export async function initCommand(ctx: Ctx): Promise<number> {
  const { ui, paths } = ctx;
  let existing: { providerHost?: ProviderHostMode; name?: string; providerName?: string } = {};
  if (existsSync(paths.config)) {
    const c = await loadConfig(paths.config);
    existing = { providerHost: c.providerHost, name: c.name };
  }
  existing.providerName = (await readState(paths)).providerName;
  const o = initOptions(ctx, existing);
  ui.step(`cf-orbs init in ${paths.dir} (provider host: ${o.mode})`);
  const probes = await gatherProbes(ctx);
  const steps = plan(o, probes);
  const r = await runInit(ctx, o, steps);
  ui.result({ ok: true, url: r.url, mode: o.mode, providerName: r.providerName, next: r.command });
  if (r.command) ui.out(r.command);
  return 0;
}
