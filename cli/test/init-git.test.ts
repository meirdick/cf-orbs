// init --no-deploy (git mode for Workers Builds): fake wrangler, npm and Cloudflare API; real git in a temp dir.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args";
import { runDoctor } from "../src/commands/doctor";
import { gatherProbes, initOptions, plan, runInit } from "../src/commands/init";
import { AMP_DEFAULT_IMAGE_REPO, DEFAULT_CONFIG, loadConfig, parseJsonc } from "../src/config";
import { type Ctx, makeCtx } from "../src/context";
import { readState } from "../src/project";
import type { Ui } from "../src/ui";
import { type Runner, WRANGLER_PIN } from "../src/wrangler";
import { gitRun } from "./git-run";

const PINNED = `FROM ${AMP_DEFAULT_IMAGE_REPO}@${DEFAULT_CONFIG.ampImageDigest}\n`;
const TOKEN = "aop_live_gitmodetoken123";

async function fakeTemplates(root: string) {
  for (const [f, body] of [
    ["worker/src/index.ts", "export default {};\n"],
    ["image/Dockerfile", PINNED],
    ["provider/Dockerfile", `FROM node:24-bookworm-slim@sha256:${"c".repeat(64)}\n`],
    ["dispatch/dispatch.sh", "#!/bin/sh\n"],
  ] as const) {
    await mkdir(join(root, f, ".."), { recursive: true });
    await writeFile(join(root, f), body);
  }
}

let dir: string;
let templates: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cf-orbs-git-"));
  templates = await mkdtemp(join(tmpdir(), "cf-orbs-tpl-"));
  await fakeTemplates(templates);
});

function setup(argv: string[], env: Record<string, string> = {}, warm?: unknown) {
  const calls: string[] = [];
  const bulk: Record<string, string>[] = [];
  const bulkFiles: string[] = [];
  const run: Runner = async (cmd, args, o) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "git") return gitRun(cmd, args, o);
    if (cmd === "docker") throw new Error("git mode must not call docker");
    if (cmd.startsWith("npm")) {
      await writeFile(join(o?.cwd as string, "package-lock.json"), '{"lockfileVersion":3}\n');
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args.includes("whoami"))
      return {
        code: 0,
        stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: "acct1", name: "Me" }] }),
        stderr: "",
      };
    if (args.includes("auth") && args.includes("token"))
      return {
        code: 0,
        stdout: JSON.stringify({ type: "oauth", token: "oauth-secret-value-123" }),
        stderr: "",
      };
    if (args.includes("secret") && args.includes("bulk")) {
      const f = args[args.indexOf("bulk") + 1] as string;
      bulkFiles.push(f);
      bulk.push(JSON.parse(readFileSync(f, "utf8")));
      expect(args).toContain("--config");
      return {
        code: 0,
        stdout:
          '🌀 Creating new Worker "cf-orbs-wb2"...\n✨ Successfully created secret for key: CONTROL_TOKEN\n',
        stderr: "",
      };
    }
    if (args.includes("containers") && args.includes("list")) return { code: 0, stdout: "[]", stderr: "" };
    if (args.includes("deploy") && args.includes("--secrets-file"))
      return { code: 0, stdout: "Uploaded\n  https://cf-orbs-wb2.me.workers.dev\n", stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected ${cmd} ${args.join(" ")}` };
  };
  const fakeFetch = (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    if (u.hostname === "api.cloudflare.com")
      return Response.json({ success: true, result: { subdomain: "me" } });
    if (warm !== undefined && u.pathname === "/v1/warm") return Response.json(warm);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const lines: string[] = [];
  const push = (l: string) => lines.push(l);
  const ui: Ui = {
    json: false,
    nonInteractive: true,
    step: push,
    warn: push,
    out: push,
    result: () => {},
    raw: () => {},
  };
  const ctx: Ctx = makeCtx(
    ui,
    parseArgs(argv, {
      "non-interactive": { type: "boolean" },
      "no-deploy": { type: "boolean" },
      "token-file": { type: "string" },
      "provider-name": { type: "string" },
      provider: { type: "string" },
      name: { type: "string" },
      digest: { type: "string" },
    }),
    dir,
    { run, fetch: fakeFetch, env, sleep: async () => {}, templates },
  );
  return { ctx, calls, bulk, bulkFiles, lines };
}

async function init(s: ReturnType<typeof setup>) {
  const o = initOptions(s.ctx);
  return runInit(s.ctx, o, plan(o, { ...(await gatherProbes(s.ctx, o)), tty: false }));
}

describe("init --no-deploy (git mode)", () => {
  it("writes the repo files, commits once, sets both secrets, writes state, prints the dashboard steps; no docker", async () => {
    const tf = join(await mkdtemp(join(tmpdir(), "cf-orbs-tok-")), "t");
    await writeFile(tf, `${TOKEN}\n`, { mode: 0o600 });
    const s = setup([
      "--no-deploy",
      "--non-interactive",
      "--token-file",
      tf,
      "--provider-name",
      "cloudflare-wb2",
      "--name",
      "cf-orbs-wb2",
    ]);
    const r = await init(s);
    expect(s.calls.some((c) => c.startsWith("docker"))).toBe(false);

    // files
    const wr = parseJsonc(await readFile(s.ctx.paths.wrangler, "utf8"), "wrangler.jsonc") as Record<
      string,
      unknown
    >;
    expect(wr).toMatchObject({
      name: "cf-orbs-wb2",
      workers_dev: true,
      preview_urls: false,
      account_id: "acct1",
    });
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8"))).toEqual({
      name: "cf-orbs-wb2",
      private: true,
      scripts: { deploy: "wrangler deploy --config .cf-orbs/wrangler.jsonc" },
      devDependencies: { wrangler: WRANGLER_PIN },
    });
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
    expect(s.calls).toContain("npm install --package-lock-only --ignore-scripts --no-audit --no-fund");

    // git: one commit with the generated files, never the tokens
    const tracked = (await gitRun("git", ["-C", dir, "ls-files"])).stdout.split("\n");
    expect(tracked).toEqual(
      expect.arrayContaining([
        ".cf-orbs/wrangler.jsonc",
        ".cf-orbs/worker/src/index.ts",
        ".cf-orbs/provider/Dockerfile",
        "image/Dockerfile",
        "cf-orbs.config.jsonc",
        "package.json",
        "package-lock.json",
        ".gitignore",
      ]),
    );
    expect(tracked).not.toContain(".cf-orbs/control-token");
    expect(tracked).not.toContain(".cf-orbs/state.json");
    expect((await gitRun("git", ["-C", dir, "rev-list", "--count", "HEAD"])).stdout.trim()).toBe("1");
    expect((await gitRun("git", ["-C", dir, "branch", "--show-current"])).stdout.trim()).toBe("main");

    // secrets: one bulk call from a temp file that is gone afterwards
    expect(s.bulk).toHaveLength(1);
    expect(Object.keys(s.bulk[0] ?? {}).sort()).toEqual(["AMP_ORB_PROVIDER_TOKEN", "CONTROL_TOKEN"]);
    expect(s.bulk[0]?.AMP_ORB_PROVIDER_TOKEN).toBe(TOKEN);
    expect(existsSync(s.bulkFiles[0] as string)).toBe(false);
    expect(s.lines).toContain("worker: created cf-orbs-wb2 (a placeholder until the first build)");

    // state: URL from the account subdomain, mode git
    expect(await readState(s.ctx.paths)).toMatchObject({
      url: "https://cf-orbs-wb2.me.workers.dev",
      mode: "git",
      workerName: "cf-orbs-wb2",
      providerName: "cloudflare-wb2",
      accountId: "acct1",
    });
    expect(r.url).toBe("https://cf-orbs-wb2.me.workers.dev");

    // printed steps
    const out = s.lines.join("\n");
    expect(out).toContain("Workers & Pages → cf-orbs-wb2 → Settings → Builds → Connect");
    expect(out).toContain("Deploy command:     npx wrangler deploy --config .cf-orbs/wrangler.jsonc");
    expect(out).toContain(
      "Build watch paths:  include image/**, .cf-orbs/**, cf-orbs.config.jsonc, package*.json",
    );
    expect(out).toContain("3. After the first build: cf-orbs status");
    expect(out).not.toContain("No Amp token given");
    expect(out).toContain("plan: Containers are available on this account");
    expect(out).toContain(
      "self-test: skipped (Workers Builds deploys later; after the first build, cf-orbs status shows the prewarm result)",
    );
    expect(out).not.toContain(TOKEN);
    expect(r.command).toBe('amp -ox "hello from cf-orbs" --orb-provider cloudflare-wb2');
    expect(r.git?.settings).toEqual({
      worker: "cf-orbs-wb2",
      branch: "main",
      buildCommand: "",
      deployCommand: "npx wrangler deploy --config .cf-orbs/wrangler.jsonc",
      rootDirectory: "/",
      previews: false,
      apiToken: "default build token",
      buildWatchPaths: ["image/**", ".cf-orbs/**", "cf-orbs.config.jsonc", "package*.json"],
    });

    // doctor's file checks pass in the new repo
    const checks = await runDoctor(setup([]).ctx);
    // before the first build the Worker is a placeholder: the fix is the build, not cf-orbs deploy
    expect(checks.find((c) => c.name === "health")?.detail).toMatch(
      / — fix: wait for the Workers Builds build to finish \(Workers & Pages → cf-orbs-wb2 → Deployments\)/,
    );
    const files = checks.filter((c) =>
      [
        "orb image pin",
        "provider image pin",
        "debugExec",
        "secrets in git",
        "gitignore",
        "wrangler pin",
      ].includes(c.name),
    );
    expect(files.map((c) => `${c.status} ${c.name}`)).toEqual([
      "PASS orb image pin",
      "PASS provider image pin",
      "PASS debugExec",
      "PASS secrets in git",
      "PASS gitignore",
      "PASS wrangler pin",
    ]);
  });

  it("without a token: sets only CONTROL_TOKEN and prints how to set the Amp token later; a re-run with it sets it", async () => {
    const s = setup(["--no-deploy", "--non-interactive"]);
    await init(s);
    expect(Object.keys(s.bulk[0] ?? {})).toEqual(["CONTROL_TOKEN"]);
    expect(s.lines.join("\n")).toContain(
      "     cf-orbs init --no-deploy --token-file <file>   (no build needed)",
    );
    const ct = s.bulk[0]?.CONTROL_TOKEN;

    const again = setup(["--no-deploy", "--non-interactive"], { AMP_ORB_PROVIDER_TOKEN: TOKEN });
    await init(again);
    expect(again.bulk[0]).toEqual({ CONTROL_TOKEN: ct, AMP_ORB_PROVIDER_TOKEN: TOKEN });
    expect(again.lines.join("\n")).toContain("in a git repo already");
    expect((await gitRun("git", ["-C", dir, "rev-list", "--count", "HEAD"])).stdout.trim()).toBe("1");
  });

  it("plan: no Docker needed; --provider external is rejected", async () => {
    const s = setup(["--no-deploy", "--non-interactive"]);
    const o = initOptions(s.ctx);
    const probes = { ...(await gatherProbes(s.ctx, o)), docker: false, tty: false };
    expect(plan(o, probes).map((x) => x.kind)).toEqual([
      "use-account",
      "plan-check",
      "scaffold",
      "control-token",
      "subdomain",
      "git-files",
      "git-secrets",
      "selftest",
      "git-next",
      "done",
    ]);
    const ext = setup(["--no-deploy", "--non-interactive", "--provider", "external"]);
    const o2 = initOptions(ext.ctx);
    const steps = plan(o2, { ...probes });
    expect(steps[0]?.kind === "fail" && steps[0].error.message).toBe(
      "Failed: --no-deploy supports only --provider cloudflare — fix: drop --provider external, or run cf-orbs init --provider external without --no-deploy",
    );
  });

  it("a rerun after a build reports the last prewarm run as the self-test; an old failed run only warns", async () => {
    await init(setup(["--no-deploy", "--non-interactive"]));
    const ok = setup(
      ["--no-deploy", "--non-interactive"],
      {},
      {
        last: { at: "2026-11-02T10:00:00Z", count: 2, ok: 2, pending: 0, msPerInstance: [41000, 39000] },
      },
    );
    await init(ok);
    expect(ok.lines).toContain("self-test: orb image starts (2 of 2 ready in 41 s and 39 s)");
    const bad = setup(
      ["--no-deploy", "--non-interactive"],
      {},
      {
        last: { at: "2026-11-02T10:00:00Z", count: 2, ok: 0, pending: 0 },
      },
    );
    await init(bad);
    expect(bad.lines).toContain(
      "self-test: the last prewarm run started no instance; check the build, then cf-orbs status",
    );
  });

  it("a token in a file to be committed stops the first commit", async () => {
    await writeFile(join(dir, "notes.txt"), `token ${TOKEN}\n`);
    const s = setup(["--no-deploy", "--non-interactive"]);
    await expect(init(s)).rejects.toThrow(
      "Failed: a token is in file(s) staged for the first commit: notes.txt — fix: remove the token from those files (or add them to .gitignore), then rerun cf-orbs init --no-deploy",
    );
    expect((await gitRun("git", ["-C", dir, "rev-parse", "--verify", "HEAD"])).code).not.toBe(0);
    expect(s.bulk).toHaveLength(0);
  });

  it("a local cf-orbs deploy in a git mode project keeps mode git and the git mode .gitignore", async () => {
    await init(setup(["--no-deploy", "--non-interactive", "--name", "cf-orbs-wb2"]));
    const d = setup([]);
    const { deployProject } = await import("../src/commands/deploy");
    await deployProject(d.ctx, {
      config: await loadConfig(d.ctx.paths.config),
      state: await readState(d.ctx.paths),
      secrets: { CONTROL_TOKEN: "c".repeat(64) },
    });
    expect((await readState(d.ctx.paths)).mode).toBe("git");
    expect((await readFile(join(dir, ".gitignore"), "utf8")).split("\n")).not.toContain(".cf-orbs/*");
  });

  it("upgrade --no-deploy in git mode writes wrangler.jsonc with the old image key and says commit and push", async () => {
    await init(setup(["--no-deploy", "--non-interactive"]));
    const u = setup(["--digest", `sha256:${"1".repeat(64)}`, "--no-deploy"]);
    const { upgradeCommand } = await import("../src/commands/upgrade");
    expect(await upgradeCommand(u.ctx)).toBe(0);
    const old = `orb-${DEFAULT_CONFIG.ampImageDigest.slice(7, 19)}`;
    expect(await readFile(u.ctx.paths.wrangler, "utf8")).toContain(
      `"dockerfile": "../image/${old}.Dockerfile"`,
    );
    expect(u.lines).toContain("Commit and push: Workers Builds builds and deploys the new image.");
  });

  it("--name must be a valid Worker name", () => {
    const s = setup(["--no-deploy", "--name", "Bad_Name"]);
    expect(() => initOptions(s.ctx)).toThrow(/^Failed: --name "Bad_Name" is not a valid Worker name/);
  });
});
