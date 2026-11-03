// cf-orbs init [dir]: zero to a live provider. plan() is pure (options + probes → steps); runInit() executes.
// Re-runnable: reuses the control token, keeps the Amp token secret when none is given, keeps user files.
// --no-deploy (git mode): no Docker, no deploy. Scaffold a repo for Workers Builds, create the Worker with its
// secrets, print the dashboard steps. Workers Builds then builds the images and deploys on each push.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ApiClient, expectOk, makeApi, providerInfo } from "../api.js";
import { flagBool, flagString } from "../args.js";
import {
  type CfOrbsConfig,
  CONFIG_FILE,
  findTopLevelValue,
  instanceForVcpu,
  loadConfig,
  type OrbInstanceSpec,
  type ProviderHostMode,
  setTopLevelJsonc,
} from "../config.js";
import type { Ctx } from "../context.js";
import { CliError, registerSecret } from "../errors.js";
import { filesWithSecrets, gitTrackedFiles } from "../file-checks.js";
import { dockerOk, nodeMajor, whoami } from "../probes.js";
import {
  cliVersion,
  GIT_DEPLOY_COMMAND,
  generateToken,
  gitPackageJson,
  materialize,
  missingDockerfiles,
  readControlToken,
  readState,
  type State,
  withSecretsFile,
  writeControlToken,
  writeState,
  writeWranglerConfig,
} from "../project.js";
import { checkSubdomain, registerSubdomain, suggestSubdomain, wranglerBearer } from "../subdomain.js";
import { ask, askHidden } from "../ui.js";
import {
  type Account,
  classifyDeployFailure,
  deployFailureError,
  lastErrorLine,
  makeWrangler,
  type WhoAmI,
  WRANGLER_PIN,
} from "../wrangler.js";
import { deployProject, startPrewarm } from "./deploy.js";

export interface InitOptions {
  mode: ProviderHostMode;
  nonInteractive: boolean;
  tokenFile?: string;
  accountId?: string;
  providerName: string;
  /** --provider-name, AMP_ORB_PROVIDER_NAME or a saved name was given (else interactive init asks) */
  providerNameExplicit?: boolean;
  /** Where providerName came from: flag or env are explicit; config and default were not given */
  providerNameSource: "flag" | "env" | "saved" | "config" | "default";
  /** --subdomain / CF_ORBS_SUBDOMAIN: workers.dev subdomain to register if the account has none */
  subdomain?: string;
  /** --vcpu 1-4: write instance {vcpu N, memoryMib N*3072, diskMb 20000}. Not given: keep the config (default 4). */
  vcpu?: number;
  /** --name: Worker name written to the config. Not given: keep the config (default cf-orbs). */
  name?: string;
  /** --no-deploy: git mode. No Docker, no deploy; Workers Builds deploys from a repo. */
  noDeploy?: boolean;
}

export interface InitProbes {
  nodeVersion: string;
  docker: boolean;
  whoami: WhoAmI;
  /** a previous init wrote .cf-orbs/control-token */
  hasControlToken: boolean;
  /** a previous init deployed (state.json has a URL) */
  deployed: boolean;
  /** provider host mode of the previous init or deploy, or "git" (state.json) */
  prevMode?: State["mode"];
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
  | { kind: "plan-check" }
  | { kind: "scaffold"; mode: ProviderHostMode; git: boolean }
  | { kind: "control-token"; action: "generate" | "reuse" }
  | { kind: "amp-token"; source: "env" | "file" | "prompt" | "keep" }
  | { kind: "deploy"; secrets: string[] }
  | { kind: "health" }
  | { kind: "status" }
  | { kind: "selftest" }
  | { kind: "start-provider" }
  | { kind: "wait-provider"; timeoutMs: number }
  | { kind: "print-external-env" }
  | { kind: "git-files" }
  | { kind: "git-secrets" }
  | { kind: "git-next" }
  | { kind: "done"; command: string };

export const PROVIDER_WAIT_MS = 90_000;
/** How long init waits for the prewarm instances (a first start on a cold host pulls the image). */
export const SELFTEST_WAIT_MS = 180_000;
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
  if (o.noDeploy && o.mode === "external") {
    fails.push({
      kind: "fail",
      error: new CliError(
        "--no-deploy supports only --provider cloudflare",
        "drop --provider external, or run cf-orbs init --provider external without --no-deploy",
      ),
    });
  }
  if (!p.docker && !o.noDeploy) {
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
  const hadProvider = p.prevMode === "cloudflare" || p.prevMode === "git";
  if (o.noDeploy) {
    // the Amp token is optional here: set it now or later, the Worker starts the provider once it has one
    if (o.tokenFile) ampSource = "file";
    else if (p.envToken) ampSource = "env";
    else if (interactive) ampSource = "prompt";
  } else if (o.mode === "cloudflare") {
    if (o.tokenFile) ampSource = "file";
    else if (p.envToken) ampSource = "env";
    else if (interactive) ampSource = "prompt";
    // Keep only a secret that exists: external mode deletes it from the Worker.
    else if (p.deployed && hadProvider) ampSource = "keep";
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

  const steps: InitStep[] = [
    account as InitStep,
    { kind: "plan-check" },
    { kind: "scaffold", mode: o.mode, git: Boolean(o.noDeploy) },
  ];
  steps.push({ kind: "control-token", action: p.hasControlToken ? "reuse" : "generate" });
  if (ampSource) steps.push({ kind: "amp-token", source: ampSource });
  if (o.noDeploy) {
    steps.push(
      { kind: "subdomain" },
      { kind: "git-files" },
      { kind: "git-secrets" },
      { kind: "selftest" },
      { kind: "git-next" },
    );
    steps.push({ kind: "done", command: helloCommand(o.providerName) });
    return steps;
  }
  const secrets = ["CONTROL_TOKEN"];
  // "prompt" may still end as keep (Enter on a re-run); the executor drops the secret then.
  if (ampSource && ampSource !== "keep") secrets.push("AMP_ORB_PROVIDER_TOKEN");
  steps.push(
    { kind: "subdomain" },
    { kind: "deploy", secrets },
    { kind: "health" },
    { kind: "status" },
    { kind: "selftest" },
  );
  if (o.mode === "cloudflare") {
    steps.push({ kind: "start-provider" }, { kind: "wait-provider", timeoutMs: PROVIDER_WAIT_MS });
  } else steps.push({ kind: "print-external-env" });
  steps.push({ kind: "done", command: helloCommand(o.providerName) });
  return steps;
}

/** noDeploy: git mode needs no Docker, so the probe is skipped. */
export async function gatherProbes(ctx: Ctx, o: { noDeploy?: boolean } = {}): Promise<InitProbes> {
  const [docker, who, ct, state] = await Promise.all([
    o.noDeploy ? false : dockerOk(ctx.run),
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

export interface InitResult {
  url?: string;
  command?: string;
  providerName?: string;
  /** git mode only */
  git?: GitNext;
}

function warmLast(body: unknown): Record<string, unknown> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return (b.last && typeof b.last === "object" ? b.last : {}) as Record<string, unknown>;
}

/** One finished prewarm run: ok > 0 passes, ok = 0 fails init. */
function reportSelftest(ui: Ctx["ui"], view: Record<string, unknown>): void {
  const count = Number(view.count) || 0;
  const ok = Number(view.ok) || 0;
  const ms = Array.isArray(view.msPerInstance) ? (view.msPerInstance as number[]) : [];
  if (ok === 0) {
    const jobs = Array.isArray(view.jobs) ? (view.jobs as Record<string, unknown>[]) : [];
    const why = jobs.find((j) => typeof j.error === "string")?.error;
    throw new CliError(
      `orb self-test failed: no instance started from the new image${why ? ` (${String(why)})` : ""}`,
      "run cf-orbs logs --provider and cf-orbs status, check the image build, then run cf-orbs deploy",
    );
  }
  const t = ms.length > 0 ? ` in ${ms.map((m) => `${(m / 1000).toFixed(0)} s`).join(" and ")}` : "";
  if (ok < count) ui.warn(`self-test: only ${ok} of ${count} instances started${t}`);
  else ui.step(`self-test: orb image starts (${ok} of ${count} ready${t})`);
}

/** --no-deploy: the last prewarm run of an already built Worker, or undefined. Never throws. */
async function lastPrewarm(
  url: string | undefined,
  token: string | undefined,
  ctx: Ctx,
): Promise<Record<string, unknown> | undefined> {
  if (!url || !token) return undefined;
  try {
    const r = await makeApi(url, token, ctx.fetch).get("/v1/warm");
    if (r.status !== 200) return undefined;
    const last = warmLast(r.body);
    return typeof last.at === "string" ? last : undefined;
  } catch {
    return undefined;
  }
}

export async function runInit(ctx: Ctx, o: InitOptions, steps: InitStep[]): Promise<InitResult> {
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
  let prewarmStarted = -1;
  let prewarmAt = 0;
  let subdomain: string | undefined;
  let repoExisted = false;
  let git: GitNext | undefined;

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
          subdomain = c.subdomain;
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
        subdomain = name;
        ui.step(`workers.dev subdomain: registered ${name}.workers.dev`);
        break;
      }
      case "scaffold": {
        const r = await materialize(paths, {
          templates: ctx.templates,
          configOverrides: { providerHost: s.mode },
          git: s.git,
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
        if (o.name !== undefined && config.name !== o.name) {
          await writeFile(
            paths.config,
            setTopLevelJsonc(await readFile(paths.config, "utf8"), "name", o.name),
          );
          config = await loadConfig(paths.config);
          ui.step(`scaffold: name set to ${o.name}`);
        }
        // --vcpu overwrites "instance"; without it a re-run keeps what the config has
        if (o.vcpu !== undefined && !sameInstance(config.instance, instanceForVcpu(o.vcpu))) {
          const t = await readFile(paths.config, "utf8");
          await writeFile(paths.config, setInstanceJsonc(t, instanceForVcpu(o.vcpu)));
          config = await loadConfig(paths.config);
          ui.step(`scaffold: instance set to ${o.vcpu} vCPU, ${o.vcpu * 3} GiB, 20 GB disk`);
        }
        state = {
          ...state,
          accountId,
          providerName: o.providerName,
          mode: s.git ? "git" : s.mode,
          workerName: config.name,
        };
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
        // No interactive name question here: say so if the name is a fallback, not given
        if (
          s.source !== "prompt" &&
          (o.providerNameSource === "config" || o.providerNameSource === "default")
        )
          ui.warn(
            `provider name ${providerName} was not given explicitly; it must match the name in Amp Settings → Orbs (pass --provider-name <name> if it differs)`,
          );
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
          const keep = Boolean(state.url) && (prevMode === "cloudflare" || prevMode === "git");
          const enter = o.noDeploy
            ? "; Enter skips (set it later)"
            : keep
              ? "; Enter keeps the current one"
              : "";
          const t = await askHidden(
            `Amp provider token (aop_live_…, not shown; create or copy it in Amp Settings → Orbs → Add Provider)${enter}: `,
          );
          if (t === "" && o.noDeploy) ui.step("amp token: not given; set it later (see the steps below)");
          else if (t === "" && keep) ui.step("amp token: keeping the current Worker secret");
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
        if (config) prewarmStarted = (await startPrewarm(ctx, api as ApiClient, config)).started;
        prewarmAt = ctx.now();
        break;
      case "selftest": {
        if (o.noDeploy) {
          // Workers Builds deploys later, so this run started no prewarm. Report an earlier run if the
          // Worker has one (a rerun after a build); else skip.
          const last = await lastPrewarm(url, controlToken, ctx);
          if (last && Number(last.pending) === 0 && Number(last.count) > 0) {
            // an old failed run does not fail init: the next build may fix the image
            if (Number(last.ok) > 0) reportSelftest(ui, last);
            else
              ui.warn(
                "self-test: the last prewarm run started no instance; check the build, then cf-orbs status",
              );
          } else
            ui.step(
              "self-test: skipped (Workers Builds deploys later; after the first build, cf-orbs status shows the prewarm result)",
            );
          break;
        }
        // The prewarm run starts throwaway orbs from the new image. If one becomes ready, the image,
        // the registry and the container runtime work. No Amp thread and no debug route needed.
        if (prewarmStarted === 0) {
          ui.step('self-test: skipped (no prewarm instance was started; set "prewarm" above 0 to enable)');
          break;
        }
        const until = ctx.now() + SELFTEST_WAIT_MS;
        let view: Record<string, unknown> = {};
        for (;;) {
          const r = await (api as ApiClient).get("/v1/warm");
          const last = warmLast(r.body);
          // Ignore the result of an earlier run.
          if (typeof last.at === "string" && Date.parse(last.at) >= prewarmAt - 10_000) {
            view = last;
            if (Number(last.pending) === 0) break;
          }
          if (ctx.now() >= until) break;
          await ctx.sleep(3_000);
        }
        if (Number(view.count) > 0 && Number(view.pending) === 0) reportSelftest(ui, view);
        else
          ui.warn(
            "self-test: still running after 3 min; the first start on a new host pulls the image. Check cf-orbs status",
          );
        break;
      }
      case "plan-check": {
        // Before the image build: a Free account fails here in seconds, not after a 1.8 GB push.
        // Best effort: only a clear plan or login error stops init; any other error is a warning.
        const r = await makeWrangler(ctx.run, { accountId }).run(["containers", "list", "--json"], {
          timeoutMs: 60_000,
        });
        if (r.code === 0) {
          ui.step("plan: Containers are available on this account");
          break;
        }
        const out = `${r.stdout}\n${r.stderr}`;
        const kind = classifyDeployFailure(out);
        if (kind === "paid" || kind === "auth") throw deployFailureError(kind, out);
        ui.warn(`plan check skipped (wrangler containers list failed: ${lastErrorLine(out)})`);
        break;
      }
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
      case "git-files": {
        if (!config) throw new Error("init plan bug: git-files before scaffold");
        const missing = missingDockerfiles(paths, config);
        if (missing.length > 0)
          throw new CliError(
            `image Dockerfile missing: ${missing.join(", ")}`,
            "create it, or remove its key from images in cf-orbs.config.jsonc",
          );
        await writeWranglerConfig(paths, config, accountId);
        ui.step("git: wrote .cf-orbs/wrangler.jsonc (Workers Builds deploys with it)");
        if (!existsSync(paths.packageJson)) {
          await writeFile(paths.packageJson, gitPackageJson(config.name, WRANGLER_PIN));
          ui.step(`git: wrote package.json (wrangler ${WRANGLER_PIN} for Workers Builds)`);
        }
        await writeLockfile(ctx);
        repoExisted = await gitCommitNew(ctx, ampToken);
        break;
      }
      case "git-secrets": {
        if (!config || !controlToken) throw new Error("init plan bug: git-secrets before scaffold");
        const secrets: Record<string, string> = { CONTROL_TOKEN: controlToken };
        if (ampToken) secrets.AMP_ORB_PROVIDER_TOKEN = ampToken;
        await putSecrets(ctx, config.name, accountId, secrets);
        url = subdomain ? `https://${config.name}.${subdomain}.workers.dev` : state.url;
        if (!url)
          ui.warn(
            "Failed: could not read the account's workers.dev subdomain, so state.json has no URL — fix: after the first build, pass --url https://<name>.<subdomain>.workers.dev to status and doctor",
          );
        state = {
          ...state,
          url,
          accountId,
          mode: "git",
          workerName: config.name,
          cliVersion: await cliVersion(),
        };
        await writeState(paths, state);
        break;
      }
      case "git-next":
        git = gitNext({
          worker: config?.name ?? "cf-orbs",
          repoExisted,
          ampTokenGiven: Boolean(ampToken),
        });
        for (const l of git.lines) ui.out(l);
        break;
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
  return { url, command, providerName, ...(git ? { git } : {}) };
}

/** Workers Builds settings for the dashboard (Settings → Builds → Connect), as tested on 2026-11-02. */
export const GIT_PATH_FILTERS = ["image/**", ".cf-orbs/**", "cf-orbs.config.jsonc", "package*.json"];

export interface GitNext {
  settings: {
    worker: string;
    branch: string;
    buildCommand: string;
    deployCommand: string;
    rootDirectory: string;
    previews: boolean;
    apiToken: string;
    buildWatchPaths: string[];
  };
  /** printed lines, without the final amp command */
  lines: string[];
}

/** The next steps init --no-deploy prints. Pure. */
export function gitNext(o: { worker: string; repoExisted: boolean; ampTokenGiven: boolean }): GitNext {
  const settings = {
    worker: o.worker,
    branch: "main",
    buildCommand: "",
    deployCommand: GIT_DEPLOY_COMMAND,
    rootDirectory: "/",
    previews: false,
    apiToken: "default build token",
    buildWatchPaths: GIT_PATH_FILTERS,
  };
  const push = o.repoExisted
    ? [
        "1. Commit these files, then push the repo to GitHub or GitLab:",
        "     git add -A && git commit -m 'cf-orbs init'",
        "     git push",
      ]
    : [
        "1. Make an empty repo on GitHub or GitLab. Push this directory to it:",
        "     git remote add origin <repo URL>",
        "     git push -u origin main",
      ];
  const lines = [
    "",
    "Next steps. Workers Builds builds the images in your Cloudflare account; this machine needs no Docker.",
    ...push,
    `2. Connect the repo: Cloudflare dashboard → Workers & Pages → ${o.worker} → Settings → Builds → Connect.`,
    "     Repository:         the repo from step 1",
    `     Branch:             ${settings.branch}${o.repoExisted ? " (the branch you push)" : ""}`,
    "     Build command:      (leave empty)",
    `     Deploy command:     ${settings.deployCommand}`,
    `     Root directory:     ${settings.rootDirectory}`,
    "     Previews (builds for non-production branches): off",
    "     API token:          the default build token",
    `     Build watch paths:  include ${settings.buildWatchPaths.join(", ")}`,
    "   If no build starts, push a commit. Measured: first build 10.6 min, plus 2-4 min in the queue.",
    "3. After the first build: cf-orbs status",
    "   The 5-min cron starts the provider. The first spawn on each host pulls the image (40-50 s).",
    ...(o.ampTokenGiven
      ? []
      : [
          "4. No Amp token given. If the Worker has none yet, set it with:",
          "     cf-orbs init --no-deploy --token-file <file>   (no build needed)",
        ]),
    "Upgrades: edit image/Dockerfile or cf-orbs.config.jsonc (or cf-orbs upgrade --digest sha256:<hex> --no-deploy), commit, push.",
    "Docs: https://github.com/meirdick/cf-orbs/blob/main/docs/install-workers-builds.md",
    "Then try it (spends Amp credits):",
  ];
  return { settings, lines };
}

/** package-lock.json for npm clean-install in Workers Builds. A failure is one warning. */
async function writeLockfile(ctx: Ctx): Promise<void> {
  const { paths, ui } = ctx;
  if (existsSync(join(paths.dir, "package-lock.json"))) return;
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = await ctx.run(
    npm,
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: paths.dir,
      timeoutMs: 180_000,
    },
  );
  if (r.code === 0) ui.step("git: wrote package-lock.json");
  else
    ui.warn(
      `Failed: could not write package-lock.json (${lastErrorLine(`${r.stdout}\n${r.stderr}`)}) — fix: run npm install --package-lock-only in ${paths.dir}, then commit it`,
    );
}

/**
 * git init + first commit when dir is in no git work tree. Returns true when a repo was there already.
 * Checks the staged files for tokens before the commit.
 */
async function gitCommitNew(ctx: Ctx, ampToken?: string): Promise<boolean> {
  const { paths, ui } = ctx;
  const g = (args: string[]) => ctx.run("git", ["-C", paths.dir, ...args], { timeoutMs: 60_000 });
  if ((await g(["rev-parse", "--is-inside-work-tree"])).code === 0) {
    ui.step("git: this directory is in a git repo already; commit and push the changes yourself");
    return true;
  }
  const init = await g(["init", "-b", "main"]);
  if (init.code !== 0) {
    ui.warn(
      `Failed: git init did not run (${lastErrorLine(`${init.stdout}\n${init.stderr}`)}) — fix: install git, then run git init -b main && git add -A && git commit -m 'cf-orbs init' in ${paths.dir}`,
    );
    return false;
  }
  await g(["add", "-A"]);
  const ct = await readControlToken(paths);
  const staged = (await gitTrackedFiles(ctx.run, paths.dir)) ?? [];
  const hits = await filesWithSecrets(paths.dir, staged, [
    ...(ct ? [ct] : []),
    ...(ampToken ? [ampToken] : []),
  ]);
  if (hits.length > 0) {
    await g(["reset", "-q"]);
    throw new CliError(
      `a token is in file(s) staged for the first commit: ${hits.join(", ")}`,
      "remove the token from those files (or add them to .gitignore), then rerun cf-orbs init --no-deploy",
    );
  }
  const c = await g(["commit", "-q", "-m", "cf-orbs init (Workers Builds)"]);
  if (c.code === 0) ui.step(`git: made a repo on branch main with a first commit (${staged.length} files)`);
  else
    ui.warn(
      `Failed: git commit did not run (${lastErrorLine(`${c.stdout}\n${c.stderr}`)}) — fix: set git config user.name and user.email, then git commit -m 'cf-orbs init' in ${paths.dir}`,
    );
  return false;
}

/** wrangler secret bulk from a 0600 temp file. Creates the Worker (a placeholder) when it does not exist. */
async function putSecrets(
  ctx: Ctx,
  name: string,
  accountId: string | undefined,
  secrets: Record<string, string>,
): Promise<void> {
  const w = makeWrangler(ctx.run, { configPath: ctx.paths.wrangler, accountId });
  const r = await withSecretsFile(secrets, (file) =>
    w.run(["secret", "bulk", file], { env: { CI: "1" }, timeoutMs: 120_000 }),
  );
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.code !== 0 || /Secrets failed to upload|No content found/i.test(out)) {
    throw classifyDeployFailure(out) === "auth"
      ? new CliError(
          "wrangler is not logged in or the token lacks permissions",
          "run npx wrangler login, then rerun",
        )
      : new CliError(
          `wrangler secret bulk failed: ${lastErrorLine(out)}`,
          "check npx wrangler whoami, then rerun cf-orbs init --no-deploy",
        );
  }
  if (/Creating new Worker/i.test(out))
    ctx.ui.step(`worker: created ${name} (a placeholder until the first build)`);
  ctx.ui.step(`secrets: set ${Object.keys(secrets).join(" and ")} on Worker ${name}`);
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

function sameInstance(a: OrbInstanceSpec, b: { vcpu: number; memoryMib: number; diskMb: number }): boolean {
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

const WORKER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

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
  const name = flagString(ctx.args, "name");
  if (name !== undefined && !WORKER_NAME_RE.test(name))
    throw new CliError(
      `--name ${JSON.stringify(name)} is not a valid Worker name (a-z, 0-9, -; max 63)`,
      "pass --name cf-orbs or another lowercase name",
    );
  const explicitName =
    flagString(ctx.args, "provider-name") ?? ctx.env.AMP_ORB_PROVIDER_NAME ?? existing?.providerName;
  return {
    providerNameExplicit: explicitName !== undefined,
    subdomain: flagString(ctx.args, "subdomain") ?? ctx.env.CF_ORBS_SUBDOMAIN ?? undefined,
    vcpu: parseVcpuFlag(flagString(ctx.args, "vcpu")),
    name,
    noDeploy: flagBool(ctx.args, "no-deploy"),
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
    providerNameSource:
      flagString(ctx.args, "provider-name") !== undefined
        ? "flag"
        : ctx.env.AMP_ORB_PROVIDER_NAME !== undefined
          ? "env"
          : existing?.providerName !== undefined
            ? "saved"
            : existing?.name !== undefined
              ? "config"
              : "default",
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
  ui.step(
    `cf-orbs init in ${paths.dir} (provider host: ${o.mode}${o.noDeploy ? "; --no-deploy: Workers Builds deploys" : ""})`,
  );
  const probes = await gatherProbes(ctx, o);
  const steps = plan(o, probes);
  const r = await runInit(ctx, o, steps);
  if (r.git)
    ui.result({
      ok: true,
      mode: "git",
      providerHost: o.mode,
      url: r.url,
      providerName: r.providerName,
      settings: r.git.settings,
      steps: r.git.lines.filter((l) => l !== ""),
      next: r.command,
    });
  else ui.result({ ok: true, url: r.url, mode: o.mode, providerName: r.providerName, next: r.command });
  if (r.command) ui.out(r.command);
  return 0;
}
