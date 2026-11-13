// cf-orbs template: the Deploy-to-Cloudflare-button scaffold. No wrangler, no Docker, no Cloudflare
// API; real git in a temp dir, like init --no-deploy's tests.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args";
import { buttonSnippet, templateCommand, templatePackageJson } from "../src/commands/template";
import { parseJsonc } from "../src/config";
import { type Ctx, makeCtx } from "../src/context";
import type { Ui } from "../src/ui";
import { type Runner, WRANGLER_PIN } from "../src/wrangler";
import { gitRun } from "./git-run";

let dir: string;
let templates: string;

async function fakeTemplates(root: string) {
  for (const [f, body] of [
    ["worker/src/index.ts", "export default {};\n"],
    ["image/Dockerfile", "FROM scratch\n"],
    ["provider/Dockerfile", "FROM node\n"],
    ["dispatch/dispatch.sh", "#!/bin/sh\n"],
    ["button/README.md", "# cf-orbs template\n\nDeploy button README.\n"],
    ["button/dev-vars.example", "# AMP_ORB_PROVIDER_TOKEN=\n# CONTROL_TOKEN=\n"],
  ] as const) {
    await mkdir(join(root, f, ".."), { recursive: true });
    await writeFile(join(root, f), body);
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cf-orbs-tplcmd-"));
  templates = await mkdtemp(join(tmpdir(), "cf-orbs-tpl-"));
  await fakeTemplates(templates);
});

function setup() {
  const calls: string[] = [];
  const run: Runner = async (cmd, args, o) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "git") return gitRun(cmd, args, o);
    if (cmd.startsWith("npm")) {
      await writeFile(join(o?.cwd as string, "package-lock.json"), '{"lockfileVersion":3}\n');
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${cmd} ${args.join(" ")}` };
  };
  const lines: string[] = [];
  const ui: Ui = {
    json: false,
    nonInteractive: true,
    step: (l) => lines.push(l),
    warn: (l) => lines.push(l),
    out: (l) => lines.push(l),
    result: () => {},
    raw: () => {},
  };
  const ctx: Ctx = makeCtx(ui, parseArgs(["template"], {}), dir, {
    run,
    env: { ...process.env, CI: "1" },
    templates,
  });
  return { ctx, calls, lines };
}

describe("template package.json and button", () => {
  it("has the deploy script, the wrangler pin and both secret descriptions", () => {
    const pkg = JSON.parse(templatePackageJson("cf-orbs", WRANGLER_PIN));
    expect(pkg).toEqual({
      name: "cf-orbs",
      private: true,
      scripts: { deploy: "wrangler deploy --config .cf-orbs/wrangler.jsonc" },
      cloudflare: {
        bindings: {
          CONTROL_TOKEN: { description: expect.stringContaining("cf-orbs CLI") },
          AMP_ORB_PROVIDER_TOKEN: { description: expect.stringContaining("aop_live_") },
        },
      },
      devDependencies: { wrangler: WRANGLER_PIN },
    });
  });
  it("renders the button markdown", () => {
    expect(buttonSnippet("https://github.com/x/cf-orbs-template")).toBe(
      "[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/x/cf-orbs-template)",
    );
  });
  it("ships a .dev.vars.example that prompts only for the Amp token", async () => {
    // The button setup page prompts for every uncommented entry as a required secret, so the
    // one-click install breaks if the Amp token is commented out or CONTROL_TOKEN is not.
    const vars = await readFile(
      join(import.meta.dirname, "..", "..", "docs", "button-template", "dev-vars.example"),
      "utf8",
    );
    const active = vars
      .split("\n")
      .filter((l) => /^[A-Z]/.test(l))
      .map((l) => l.split("=")[0]);
    expect(active).toEqual(["AMP_ORB_PROVIDER_TOKEN"]);
  });
});

describe("cf-orbs template", () => {
  it("writes the button repo, commits once, never calls wrangler, docker or the API", async () => {
    const s = setup();
    expect(await templateCommand(s.ctx)).toBe(0);

    // files
    const wr = parseJsonc(await readFile(s.ctx.paths.wrangler, "utf8")) as Record<string, unknown>;
    expect(wr).toMatchObject({
      name: "cf-orbs",
      main: "worker/src/index.ts",
      workers_dev: true,
      preview_urls: false,
    });
    expect(wr.account_id).toBeUndefined(); // the button deploys to the account that clicks it
    expect((wr.containers as unknown[]).length).toBe(2);
    expect(((wr.vars as Record<string, string>).CF_ORBS_PROVIDER_BUILD ?? "").length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "cf-orbs.config.jsonc"))).toBe(true);
    expect(existsSync(join(dir, "image", "Dockerfile"))).toBe(true);
    expect(existsSync(join(dir, ".cf-orbs", "worker", "src", "index.ts"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect((await readFile(join(dir, ".dev.vars.example"), "utf8")).toString()).toContain(
      "AMP_ORB_PROVIDER_TOKEN",
    );
    const gi = (await readFile(join(dir, ".gitignore"), "utf8")).split("\n");
    expect(gi).toEqual(
      expect.arrayContaining([
        ".cf-orbs/control-token",
        ".cf-orbs/state.json",
        ".wrangler/",
        "node_modules/",
      ]),
    );
    expect(gi).not.toContain(".cf-orbs/*");

    // no install artifacts
    expect(existsSync(s.ctx.paths.state)).toBe(false);
    expect(existsSync(s.ctx.paths.controlToken)).toBe(false);

    // git: one commit on main, no state or token tracked
    const tracked = (await gitRun("git", ["-C", dir, "ls-files"])).stdout.split("\n");
    expect(tracked).toEqual(
      expect.arrayContaining([
        ".cf-orbs/wrangler.jsonc",
        ".cf-orbs/worker/src/index.ts",
        "cf-orbs.config.jsonc",
        "package.json",
        "package-lock.json",
        "README.md",
        ".dev.vars.example",
      ]),
    );
    expect(tracked).not.toContain(".cf-orbs/state.json");
    expect(tracked).not.toContain(".cf-orbs/control-token");
    expect((await gitRun("git", ["-C", dir, "rev-list", "--count", "HEAD"])).stdout.trim()).toBe("1");
    expect((await gitRun("git", ["-C", dir, "branch", "--show-current"])).stdout.trim()).toBe("main");

    // nothing reached for Cloudflare or Docker
    expect(s.calls.some((c) => c.startsWith("wrangler") || c.startsWith("npx wrangler"))).toBe(false);
    expect(s.calls.some((c) => c.startsWith("docker"))).toBe(false);
  });

  it("is re-runnable and keeps user edits; no second commit", async () => {
    const s = setup();
    expect(await templateCommand(s.ctx)).toBe(0);
    await writeFile(join(dir, "README.md"), "# my fork's readme\n");
    await writeFile(
      join(dir, "cf-orbs.config.jsonc"),
      `${await readFile(join(dir, "cf-orbs.config.jsonc"), "utf8")}\n// my note\n`,
    );
    expect(await templateCommand(s.ctx)).toBe(0);
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe("# my fork's readme\n");
    expect(await readFile(join(dir, "cf-orbs.config.jsonc"), "utf8")).toContain("// my note\n");
    expect((await gitRun("git", ["-C", dir, "rev-list", "--count", "HEAD"])).stdout.trim()).toBe("1");
    expect(s.lines.some((l) => l.includes("git: this directory is in a git repo already"))).toBe(true);
  });

  it("refuses to run in an existing install", async () => {
    const s = setup();
    await mkdir(s.ctx.paths.stateDir, { recursive: true });
    await writeFile(s.ctx.paths.state, '{"mode":"git"}\n');
    await expect(templateCommand(s.ctx)).rejects.toThrow(/is a cf-orbs install already/);
  });
});
