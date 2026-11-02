// cf-orbs deploy: refresh templates, regenerate wrangler.jsonc, wrangler deploy with retries.
// Always re-sends CONTROL_TOKEN (secrets are additive; this repairs a lost secret).
// providerHost "external": also deletes AMP_ORB_PROVIDER_TOKEN so the Worker runs no provider.
// Then asks the Worker to restart the provider if its image changed, and to prewarm (config prewarm).
// Both are best effort and never fail the deploy.
import { type ApiClient, makeApi } from "../api.js";
import { type CfOrbsConfig, loadConfig } from "../config.js";
import type { Ctx } from "../context.js";
import { CliError } from "../errors.js";
import {
  cliVersion,
  materialize,
  missingDockerfiles,
  readState,
  requireControlToken,
  type State,
  withSecretsFile,
  writeState,
  writeWranglerConfig,
} from "../project.js";
import { deployWithRetry, lastErrorLine, makeWrangler, type Wrangler } from "../wrangler.js";

export interface DeployInput {
  config: CfOrbsConfig;
  state: State;
  secrets: Record<string, string>;
}

/** Shared by init, deploy and upgrade. Returns the Worker URL. */
export async function deployProject(
  ctx: Ctx,
  input: DeployInput,
): Promise<{ url: string; attempts: number; providerBuild: string }> {
  const { ui, paths } = ctx;
  const { config, state } = input;
  await materialize(paths, { templates: ctx.templates });
  const missing = missingDockerfiles(paths, config);
  if (missing.length > 0) {
    throw new CliError(
      `image Dockerfile missing: ${missing.join(", ")}`,
      "create it, or remove its key from images in cf-orbs.config.jsonc",
    );
  }
  const providerBuild = await writeWranglerConfig(paths, config, state.accountId);
  ui.step(
    `deploy: wrangler deploy (${config.name}); first deploy builds and pushes a ~1.8 GB image, allow 5-15 min`,
  );
  const w = makeWrangler(ctx.run, { configPath: paths.wrangler, accountId: state.accountId });
  const t0 = ctx.now();
  const r = await withSecretsFile(input.secrets, (file) =>
    deployWithRetry(w, ["--secrets-file", file], {
      name: config.name,
      onOutput: (s) => ui.raw(s),
      onRetry: (n, why) => ui.step(`deploy: ${why}; retry ${n} of 3 (layers already pushed are kept)`),
      sleep: ctx.sleep,
    }),
  );
  const url = r.url ?? state.url;
  if (!url) {
    throw new CliError(
      "deploy finished but no workers.dev URL was printed",
      "pass --url https://<name>.<subdomain>.workers.dev to status/doctor",
    );
  }
  ui.step(
    `deploy: done in ${Math.round((ctx.now() - t0) / 1000)} s (${r.attempts} attempt${r.attempts > 1 ? "s" : ""}); ${url}`,
  );
  if (config.providerHost === "external") await dropProviderToken(ctx, w);
  await writeState(paths, {
    ...state,
    url,
    workerName: config.name,
    mode: config.providerHost,
    deployedAt: new Date(ctx.now()).toISOString(),
    cliVersion: await cliVersion(),
  });
  return { url, attempts: r.attempts, providerBuild };
}

/**
 * External mode: the Worker must run no provider. Secrets are additive, so delete AMP_ORB_PROVIDER_TOKEN;
 * without it ProviderHost never starts and a running one stops at its next check. Not-found is fine.
 */
export async function dropProviderToken(ctx: Ctx, w: Wrangler): Promise<void> {
  const d = await w.run(["secret", "delete", "AMP_ORB_PROVIDER_TOKEN"], {
    env: { CI: "1" },
    timeoutMs: 60_000,
  });
  const out = `${d.stdout}\n${d.stderr}`;
  if (d.code === 0 && !/not found|does not exist|10056/i.test(out))
    ctx.ui.step(
      "provider: removed AMP_ORB_PROVIDER_TOKEN from the Worker (external mode); its provider stops",
    );
  else if (d.code !== 0 && !/not found|does not exist|10056/i.test(out)) {
    ctx.ui.warn(
      `Failed: could not remove AMP_ORB_PROVIDER_TOKEN from the Worker (${lastErrorLine(out)}) — fix: npx wrangler secret delete AMP_ORB_PROVIDER_TOKEN --config ${ctx.paths.wrangler}`,
    );
  }
}

/** What the provider restart request did. action is the Worker's, or "error". */
export interface ProviderRestart {
  action: string;
  restarted: boolean;
  error?: string;
}

/** Wait between checks for a provider DO on old code to unload. Each check keeps it loaded, so > 140 s. */
export const OLD_CODE_WAIT_MS = 150_000;
const OLD_CODE_TRIES = 3;

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const cause = (e: unknown) =>
  String(e instanceof Error ? e.message : e)
    .replace(/^Failed: /, "")
    .replace(/ — fix: .*$/s, "");

/**
 * POST /v1/provider/restart?ifImageChanged=1 after a deploy. The Worker restarts the provider container only
 * when the provider image (build) changed. Best effort: a failure is one warning; the cron checks every 5 min.
 */
export async function restartProviderAfterDeploy(
  ctx: Ctx,
  api: ApiClient,
  build: string,
): Promise<ProviderRestart> {
  const { ui } = ctx;
  let body: Obj;
  try {
    const r = await api.post("/v1/provider/restart?ifImageChanged=1");
    body = asObj(r.body);
    if (r.status < 200 || r.status >= 300)
      throw new Error(typeof body.error === "string" ? body.error : `HTTP ${r.status}`);
  } catch (e) {
    const error = `Failed: provider restart check did not run (${cause(e)}) — fix: run cf-orbs status; the 5-min check restarts the provider for a new image`;
    ui.warn(error);
    return { action: "error", restarted: false, error };
  }
  const action = String(body.action);
  const reason = typeof body.reason === "string" ? body.reason : "";
  if (action === "restart" && reason.startsWith("provider image changed"))
    ui.step("provider: restarted for the new image");
  else if (action === "restart") ui.step(`provider: restarted (${reason})`);
  else if (action === "keep") ui.step("provider: image unchanged");
  else if (action === "start") ui.step("provider: started with the new image (it was not running)");
  else if (action === "stopped-old-code") return waitForNewCode(ctx, api, build);
  else ui.step(`provider: not restarted (${reason || action})`);
  return { action, restarted: body.restarted === true };
}

/**
 * The provider DO ran code from before provider restarts. The Worker stopped it; it loads the new code only
 * after it unloads (no request for 70-140 s). Then start it here, or the cron starts it.
 */
async function waitForNewCode(ctx: Ctx, api: ApiClient, build: string): Promise<ProviderRestart> {
  const { ui } = ctx;
  ui.step(
    `provider: its Durable Object ran old code, so it was stopped; waiting for it to load the new code (up to ${Math.round((OLD_CODE_WAIT_MS * OLD_CODE_TRIES) / 60_000)} min)`,
  );
  for (let i = 0; i < OLD_CODE_TRIES; i++) {
    await ctx.sleep(OLD_CODE_WAIT_MS);
    let p: Obj;
    try {
      p = asObj(asObj((await api.get("/v1/status")).body).provider);
    } catch {
      continue;
    }
    if (p.deployedBuild !== build) continue;
    if (p.running !== true) {
      try {
        const r = await api.post("/v1/provider/start");
        if (r.status < 200 || r.status >= 300) continue;
      } catch {
        continue;
      }
    }
    ui.step("provider: restarted for the new image");
    return { action: "restart", restarted: true };
  }
  ui.step(
    "provider: stopped; the 5-min check starts it with the new image once its Durable Object unloads; check cf-orbs status",
  );
  return { action: "stopped-old-code", restarted: false };
}

/** What the prewarm request did. started is 0 when prewarm is off or the request failed. */
export interface PrewarmStart {
  started: number;
  error?: string;
}

/**
 * POST /v1/warm after a deploy. The Worker starts `prewarm` throwaway instances from the new image in the
 * background and destroys them when they are ready. Best effort: a failure is one warning line.
 */
export async function startPrewarm(ctx: Ctx, api: ApiClient, config: CfOrbsConfig): Promise<PrewarmStart> {
  if (config.prewarm === 0) return { started: 0 };
  let cause: string;
  try {
    const r = await api.post("/v1/warm");
    const body = (r.body && typeof r.body === "object" ? r.body : {}) as Record<string, unknown>;
    if (r.status >= 200 && r.status < 300 && typeof body.started === "number") {
      const n = body.started;
      if (n > 0) {
        ctx.ui.step(
          `prewarm: started ${n} instance${n === 1 ? "" : "s"} in the background; check cf-orbs status`,
        );
        return { started: n };
      }
      cause = Array.isArray(body.errors) ? String(body.errors[0]) : "the Worker started no instance";
    } else
      cause =
        typeof body.error === "string"
          ? body.error.replace(/^Failed: /, "").replace(/ — fix: .*$/s, "")
          : `HTTP ${r.status}`;
  } catch (e) {
    cause = (e as Error).message.replace(/^Failed: /, "").replace(/ — fix: .*$/s, "");
  }
  const error = `Failed: prewarm did not start (${cause}) — fix: run cf-orbs deploy again to retry, or set "prewarm": 0 in cf-orbs.config.jsonc`;
  ctx.ui.warn(error);
  return { started: 0, error };
}

export async function deployCommand(ctx: Ctx): Promise<number> {
  const config = await loadConfig(ctx.paths.config);
  const state = await readState(ctx.paths);
  const token = await requireControlToken(ctx.paths);
  const r = await deployProject(ctx, { config, state, secrets: { CONTROL_TOKEN: token } });
  const api = makeApi(r.url, token, ctx.fetch);
  const provider =
    config.providerHost === "external"
      ? undefined
      : await restartProviderAfterDeploy(ctx, api, r.providerBuild);
  const prewarm = await startPrewarm(ctx, api, config);
  ctx.ui.out(`Deployed ${config.name}: ${r.url}`);
  ctx.ui.result({ ok: true, url: r.url, attempts: r.attempts, provider, prewarm });
  return 0;
}
