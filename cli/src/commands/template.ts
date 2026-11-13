// cf-orbs template [dir]: write a repo that a Deploy to Cloudflare button
// (deploy.workers.cloudflare.com) installs in one click. Same scaffold as init --no-deploy, minus
// everything that talks to Cloudflare: no login, no Docker, no tokens, no account id in
// wrangler.jsonc (the button deploys to the account that clicks it). The button is the whole
// install: the setup page prompts for the Amp provider token (the one uncommented entry in
// .dev.vars.example) and sets it as a Worker secret, so the user never needs the CLI.
// Re-runnable like init: user-owned files (config, image/, README, package.json) keep their edits.
import { existsSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type CfOrbsConfig, loadConfig } from "../config.js";
import type { Ctx } from "../context.js";
import { CliError } from "../errors.js";
import { nodeMajor } from "../probes.js";
import { materialize, templatesDir, writeWranglerConfig } from "../project.js";
import { WRANGLER_PIN } from "../wrangler.js";
import { gitCommitNew, writeLockfile } from "./init.js";

export const BUTTON_URL = "https://deploy.workers.cloudflare.com";
export const BUTTON_IMAGE = `${BUTTON_URL}/button`;

/** The README snippet that renders the button for a repo URL. */
export function buttonSnippet(repoUrl: string): string {
  return `[![Deploy to Cloudflare](${BUTTON_IMAGE})](${BUTTON_URL}/?url=${repoUrl})`;
}

/**
 * Root package.json for the template repo. Same shape as git mode (Workers Builds runs the deploy
 * script), plus the `cloudflare.bindings` descriptions the button setup page shows for the secrets.
 */
export function templatePackageJson(name: string, wrangler: string): string {
  const pkg = {
    name,
    private: true,
    scripts: { deploy: "wrangler deploy --config .cf-orbs/wrangler.jsonc" },
    cloudflare: {
      bindings: {
        CONTROL_TOKEN: {
          description:
            "Optional, only for the cf-orbs CLI (status, logs, doctor). Leave it empty for a no-CLI install; the CLI can set it later.",
        },
        AMP_ORB_PROVIDER_TOKEN: {
          description:
            "Your Amp provider token (`aop_live_…`) from Amp Settings → Orbs → Add Provider. Paste the one you made there; the provider starts on its own after the deploy.",
        },
      },
    },
    devDependencies: { wrangler },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** Copy src to dst when dst is missing. Returns false when the user's file was kept. `optional` skips a missing src. */
async function copyWhenMissing(src: string, dst: string, optional = false): Promise<boolean> {
  if (existsSync(dst)) return false;
  if (!existsSync(src)) {
    if (optional) return false;
    throw new CliError(`CLI templates missing at ${src}`, "reinstall cf-orbs");
  }
  await mkdir(dirname(dst), { recursive: true });
  await cp(src, dst);
  return true;
}

export async function templateCommand(ctx: Ctx): Promise<number> {
  const { ui, paths } = ctx;
  if (nodeMajor(process.versions.node) < 22)
    throw new CliError(
      `Node ${process.versions.node} is too old; cf-orbs needs Node 22 or later`,
      "install Node 22+ (https://nodejs.org) and rerun",
    );
  if (existsSync(paths.state))
    throw new CliError(
      `${paths.dir} is a cf-orbs install already`,
      "run cf-orbs template in a new, empty directory",
    );
  ui.step(`cf-orbs template in ${paths.dir}`);

  const t = ctx.templates ?? templatesDir();
  await materialize(paths, { templates: t, git: true });
  const config: CfOrbsConfig = await loadConfig(paths.config);
  // No account id: the button deploys to whichever account clicks it, and a checked-in id would
  // make every deploy from the template fail (or land on ours).
  await writeWranglerConfig(paths, config);
  ui.step("scaffold: wrote .cf-orbs/wrangler.jsonc (no account id; the button deploys to your account)");

  if (!existsSync(paths.packageJson)) {
    await writeFile(paths.packageJson, templatePackageJson(config.name, WRANGLER_PIN));
    ui.step(`scaffold: wrote package.json (wrangler ${WRANGLER_PIN}, button secret descriptions)`);
  }
  const readme = await copyWhenMissing(join(t, "button", "README.md"), join(paths.dir, "README.md"));
  if (readme) ui.step("scaffold: wrote README.md (button and one-click setup)");
  const vars = await copyWhenMissing(
    join(t, "button", "dev-vars.example"),
    join(paths.dir, ".dev.vars.example"),
  );
  if (vars) ui.step("scaffold: wrote .dev.vars.example (the button setup page reads it)");
  // The template repo is public; carry the license like the npm package does.
  const pkgRoot = resolve(t, "..");
  for (const f of ["LICENSE", "NOTICE"])
    if (await copyWhenMissing(join(pkgRoot, f), join(paths.dir, f), true)) ui.step(`scaffold: wrote ${f}`);

  await writeLockfile(ctx);
  const repoExisted = await gitCommitNew(
    ctx,
    undefined,
    "cf-orbs template (Deploy to Cloudflare button)",
    "cf-orbs template",
  );

  const lines = [
    "",
    "Next steps. The Deploy to Cloudflare button needs a public GitHub or GitLab repo.",
    ...(repoExisted
      ? [
          "1. Commit and push this directory:",
          "     git add -A && git commit -m 'cf-orbs template'",
          "     git push",
        ]
      : [
          "1. Make an empty public repo, then push:",
          "     git remote add origin <repo URL>",
          "     git push -u origin main",
        ]),
    `2. Button for any README or docs page:`,
    `     ${buttonSnippet("<repo URL>")}`,
    `3. Or open the deploy page directly: ${BUTTON_URL}/?url=<repo URL>`,
    "Users paste their Amp provider token on the setup page; no CLI, no secrets afterwards.",
    "The CLI stays optional: `npx cf-orbs init --no-deploy --adopt` adds status/logs/doctor to a clone.",
    "Docs: https://github.com/meirdick/cf-orbs/blob/main/docs/install-button.md",
  ];
  for (const l of lines) ui.out(l);
  ui.result({
    ok: true,
    dir: paths.dir,
    button: buttonSnippet("<repo URL>"),
    steps: lines.filter((l) => l !== ""),
  });
  return 0;
}
