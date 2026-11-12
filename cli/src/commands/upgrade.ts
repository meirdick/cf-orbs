// cf-orbs upgrade --digest sha256:<hex>: move the orb image to a new Amp orb image digest.
// Keeps the old image buildable as key orb-<short> (image/orb-<short>.Dockerfile + images entry), because paused orbs
// and project snapshots stay tied to the image they were taken from. Then deploys unless --no-deploy.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeApi } from "../api.js";
import { flagBool, flagString } from "../args.js";
import {
  AMP_DEFAULT_IMAGE_REPO,
  CONFIG_FILE,
  loadConfig,
  parseConfigText,
  setTopLevelJsonc,
} from "../config.js";
import type { Ctx } from "../context.js";
import { CliError } from "../errors.js";
import { materialize, readState, requireControlToken, writeWranglerConfig } from "../project.js";
import { deployProject, restartProviderAfterDeploy, startPrewarm } from "./deploy.js";
import { AMP_CACHE_STEPS } from "./snapshots.js";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const FROM_RE = new RegExp(`^(\\s*FROM\\s+${escapeRe(AMP_DEFAULT_IMAGE_REPO)}@)(sha256:[0-9a-f]{64})`, "m");

export type UpgradePlan =
  | { noop: true; digest: string }
  | {
      noop: false;
      oldDigest: string;
      newDigest: string;
      oldKey: string;
      oldDockerfileName: string;
      dockerfile: string;
      oldDockerfile: string;
      configText: string;
    };

/** Pure: compute the new Dockerfile and config text. */
export function planUpgrade(dockerfile: string, configText: string, newDigest: string): UpgradePlan {
  if (!DIGEST_RE.test(newDigest))
    throw new CliError(
      `--digest must look like sha256:<64 hex>, got ${newDigest}`,
      "pass --digest sha256:… from the Amp orb image release",
    );
  const m = FROM_RE.exec(dockerfile);
  if (!m) {
    throw new CliError(
      `image/Dockerfile has no FROM ${AMP_DEFAULT_IMAGE_REPO}@sha256:… line`,
      "edit image/Dockerfile by hand, then run cf-orbs deploy",
    );
  }
  const oldDigest = m[2] as string;
  if (oldDigest === newDigest) return { noop: true, digest: newDigest };
  const short = oldDigest.slice(7, 19);
  const oldKey = `orb-${short}`;
  const cfg = parseConfigText(configText);
  const images = { ...cfg.images, [`${AMP_DEFAULT_IMAGE_REPO}@${oldDigest}`]: oldKey };
  let text = setTopLevelJsonc(configText, "images", images);
  text = setTopLevelJsonc(text, "ampImageDigest", newDigest);
  parseConfigText(text); // must still validate
  return {
    noop: false,
    oldDigest,
    newDigest,
    oldKey,
    oldDockerfileName: `${oldKey}.Dockerfile`,
    dockerfile: dockerfile.replace(FROM_RE, `$1${newDigest}`),
    oldDockerfile: dockerfile,
    configText: text,
  };
}

export async function upgradeCommand(ctx: Ctx): Promise<number> {
  const { ui, paths } = ctx;
  const digest = flagString(ctx.args, "digest");
  if (!digest)
    throw new CliError("no --digest given", "pass --digest sha256:<64 hex> of the new Amp orb image");
  let dockerfile: string;
  let configText: string;
  try {
    dockerfile = await readFile(paths.imageDockerfile, "utf8");
    configText = await readFile(paths.config, "utf8");
  } catch {
    throw new CliError(
      `no cf-orbs project in ${paths.dir}`,
      "run cf-orbs init first, or pass --dir <project dir>",
    );
  }
  const p = planUpgrade(dockerfile, configText, digest);
  if (p.noop) {
    ui.out(`image/Dockerfile already uses ${p.digest}; nothing to do.`);
    ui.result({ ok: true, changed: false });
    return 0;
  }
  const oldPath = join(paths.imageDir, p.oldDockerfileName);
  if (!existsSync(oldPath)) await writeFile(oldPath, p.oldDockerfile);
  await writeFile(paths.config, p.configText);
  await writeFile(paths.imageDockerfile, p.dockerfile);
  ui.step(`upgrade: image/Dockerfile now FROM …@${p.newDigest}`);
  ui.step(
    `upgrade: old image kept as key ${p.oldKey} (image/${p.oldDockerfileName}, images entry in ${CONFIG_FILE})`,
  );
  ui.warn(
    "paused orbs restore on the new image but keep the old disk content; new image content reaches only orbs started from the image (cf-orbs status <orb> shows the disk image)",
  );
  ui.warn(
    "awake orbs keep the old Worker code until they pause; keep the old key until their snapshots expire (30 days)",
  );
  if (flagBool(ctx.args, "no-deploy")) {
    const state = await readState(paths);
    if (state.mode === "git") {
      // Workers Builds deploys the committed wrangler.jsonc, so write it now with the new images entry
      await materialize(paths, { templates: ctx.templates, git: true });
      await writeWranglerConfig(paths, await loadConfig(paths.config), state.accountId);
      ui.step("upgrade: wrote .cf-orbs/wrangler.jsonc");
    }
    ui.out(
      state.mode === "git"
        ? "Commit and push: Workers Builds builds and deploys the new image."
        : "Run cf-orbs deploy to build and push the new image.",
    );
    for (const l of AMP_CACHE_STEPS) ui.out(l);
    ui.result({ ok: true, changed: true, deployed: false, oldKey: p.oldKey, nextSteps: AMP_CACHE_STEPS });
    return 0;
  }
  const config = await loadConfig(paths.config);
  const token = await requireControlToken(paths);
  const r = await deployProject(ctx, {
    config,
    state: await readState(paths),
    secrets: { CONTROL_TOKEN: token },
  });
  const api = makeApi(r.url, token, ctx.fetch);
  const provider =
    config.providerHost === "external"
      ? undefined
      : await restartProviderAfterDeploy(ctx, api, r.providerBuild);
  const prewarm = await startPrewarm(ctx, api, config);
  ui.out(`Upgraded to ${p.newDigest}: ${r.url}`);
  for (const l of AMP_CACHE_STEPS) ui.out(l);
  ui.result({
    ok: true,
    changed: true,
    deployed: true,
    oldKey: p.oldKey,
    url: r.url,
    provider,
    prewarm,
    nextSteps: AMP_CACHE_STEPS,
  });
  return 0;
}
