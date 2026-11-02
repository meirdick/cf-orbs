// doctor file checks against fixture projects. Real git in temp dirs.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";
import {
  debugExecCheck,
  fileChecks,
  gitignoreCheck,
  orbImagePinCheck,
  providerImagePinCheck,
  trackedSecretsCheck,
  unpinnedFroms,
  wranglerPinCheck,
} from "../src/file-checks";
import {
  ensureGitignore,
  GIT_MODE_GITIGNORE_LINES,
  gitPackageJson,
  projectPaths,
  writeControlToken,
} from "../src/project";
import { WRANGLER_PIN } from "../src/wrangler";
import { gitRun } from "./git-run";

const D = `sha256:${"a".repeat(64)}`;
let dir: string;
const p = () => projectPaths(dir);
const write = async (f: string, body: string) => {
  await mkdir(join(dir, f, ".."), { recursive: true });
  await writeFile(join(dir, f), body);
};
const git = (...args: string[]) => gitRun("git", ["-C", dir, ...args]);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cf-orbs-fc-"));
});

describe("Dockerfile pins", () => {
  it("finds FROM refs without a digest; stage names, scratch and flags are fine", () => {
    expect(unpinnedFroms(`FROM r/x@${D}\nRUN true\n`)).toEqual([]);
    expect(unpinnedFroms("FROM node:24\n")).toEqual(["node:24"]);
    expect(
      unpinnedFroms(`FROM --platform=linux/amd64 r/x@${D} AS build\nFROM build\nFROM scratch\n`),
    ).toEqual([]);
    expect(unpinnedFroms(`# FROM node:24\nfrom r/y:latest as b\nFROM r/x@sha256:abc\n`)).toEqual([
      "r/y:latest",
      "r/x@sha256:abc",
    ]);
  });

  it("orb image: PASS when pinned, FAIL with the upgrade fix when not, FAIL when missing", async () => {
    expect((await orbImagePinCheck(p())).detail).toMatch(
      /^Failed: image\/Dockerfile not found — fix: run cf-orbs init/,
    );
    await write("image/Dockerfile", `FROM r/amp-orb@${D}\n`);
    const ok = await orbImagePinCheck(p());
    expect(ok).toEqual({
      name: "orb image pin",
      status: "PASS",
      detail: "image/Dockerfile FROM r/amp-orb@sha256:aaaaaaaaaaaa… (by digest)",
    });
    await write("image/old.Dockerfile", "FROM r/amp-orb:latest\n");
    const bad = await orbImagePinCheck(p(), validateConfig({ images: { "r/amp-orb@sha256:x": "old" } }));
    expect(bad.status).toBe("FAIL");
    expect(bad.detail).toBe(
      "Failed: image/old.Dockerfile FROM r/amp-orb:latest has no @sha256 digest — fix: pin the base image as <image>@sha256:<digest> (for the Amp image: cf-orbs upgrade --digest sha256:<hex>)",
    );
  });

  it("provider image: the project copy if there is one, else the CLI template", async () => {
    const tpl = await mkdtemp(join(tmpdir(), "cf-orbs-tpl-"));
    await mkdir(join(tpl, "provider"));
    await writeFile(join(tpl, "provider", "Dockerfile"), "FROM node:24-bookworm-slim\n");
    const t = await providerImagePinCheck(p(), tpl);
    expect(t.status).toBe("FAIL");
    expect(t.detail).toContain(
      "provider/Dockerfile (CLI template) FROM node:24-bookworm-slim has no @sha256 digest",
    );
    await write(".cf-orbs/provider/Dockerfile", `FROM node:24-bookworm-slim@${D}\n`);
    const c = await providerImagePinCheck(p(), tpl);
    expect(c.status).toBe("PASS");
    expect(c.detail).toContain(".cf-orbs/provider/Dockerfile FROM");
  });

  it("the shipped provider template is pinned", async () => {
    expect((await providerImagePinCheck(p())).status).toBe("PASS");
  });
});

describe("debugExec", () => {
  it("PASS when false; WARN (not FAIL) with the fix when true", () => {
    expect(debugExecCheck(validateConfig({}), false).status).toBe("PASS");
    const w = debugExecCheck(validateConfig({ debugExec: true }), false);
    expect(w.status).toBe("WARN");
    expect(w.detail).toBe(
      'Failed: debugExec is true: whoever has the control token can run any command in any orb — fix: set "debugExec": false in cf-orbs.config.jsonc, then run cf-orbs deploy (keep it on only for the substrate bench)',
    );
    expect(debugExecCheck(validateConfig({ debugExec: true }), true).detail).toContain(
      "then commit and push",
    );
  });
});

describe("secrets in tracked files", () => {
  it("SKIP outside git; PASS clean; FAIL on an aop_live_ token or the control token value, names files only", async () => {
    expect((await trackedSecretsCheck(gitRun, p())).status).toBe("SKIP");
    await git("init", "-q", "-b", "main");
    await write("README.md", "token: aop_live_… goes in a file\n");
    await git("add", "-A");
    expect((await trackedSecretsCheck(gitRun, p())).status).toBe("PASS");

    const ct = "b".repeat(64);
    await writeControlToken(p(), ct);
    await write("notes/a.txt", `x ${ct}\n`);
    await write("env.sh", "export AMP_ORB_PROVIDER_TOKEN=aop_live_abcdefgh1234\n");
    await git("add", "-A");
    const c = await trackedSecretsCheck(gitRun, p());
    expect(c.status).toBe("FAIL");
    expect(c.detail).toMatch(
      /^Failed: a token is in tracked file\(s\): (?=.*\.cf-orbs\/control-token)(?=.*notes\/a\.txt)(?=.*env\.sh).* — fix: git rm --cached/,
    );
    expect(c.detail).not.toContain(ct);
    expect(c.detail).not.toContain("abcdefgh1234");
  });
});

describe("git mode files", () => {
  it("gitignore: PASS with the git mode lines; FAIL when missing or tracked", async () => {
    await git("init", "-q", "-b", "main");
    expect((await gitignoreCheck(gitRun, p())).detail).toMatch(
      /^Failed: \.cf-orbs\/control-token and \.cf-orbs\/state\.json not ignored by git \(or tracked\) — fix: add /,
    );
    await ensureGitignore(p(), true);
    expect((await gitignoreCheck(gitRun, p())).status).toBe("PASS");
    await writeControlToken(p(), "b".repeat(64));
    await git("add", "-f", ".cf-orbs/control-token");
    const c = await gitignoreCheck(gitRun, p());
    expect(c.status).toBe("FAIL");
    expect(c.detail).toContain(".cf-orbs/control-token not ignored");
  });

  it("gitignore without a repo falls back to the .gitignore lines", async () => {
    await ensureGitignore(p(), true);
    expect((await gitignoreCheck(gitRun, p())).status).toBe("PASS");
  });

  it("git mode gitignore drops the local lines that hide the generated files", async () => {
    await ensureGitignore(p());
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain(".cf-orbs/*\n");
    await ensureGitignore(p(), true);
    const lines = (await readFile(join(dir, ".gitignore"), "utf8")).split("\n");
    expect(lines).not.toContain(".cf-orbs/*");
    expect(lines).not.toContain("!.cf-orbs/state.json");
    expect(lines).toEqual(expect.arrayContaining(GIT_MODE_GITIGNORE_LINES));
  });

  it("wrangler pin: PASS on the CLI's version; FAIL on another or none", async () => {
    expect((await wranglerPinCheck(p())).status).toBe("FAIL");
    await write("package.json", gitPackageJson("x", WRANGLER_PIN));
    expect((await wranglerPinCheck(p())).status).toBe("PASS");
    await write("package.json", gitPackageJson("x", "^4.0.0"));
    expect((await wranglerPinCheck(p())).detail).toBe(
      `Failed: package.json pins wrangler ^4.0.0; cf-orbs uses ${WRANGLER_PIN} — fix: set devDependencies.wrangler to "${WRANGLER_PIN}", run npm install, commit and push`,
    );
  });

  it("fileChecks adds the git mode checks only in git mode", async () => {
    await write("image/Dockerfile", `FROM r/amp-orb@${D}\n`);
    const cfg = validateConfig({});
    const local = await fileChecks(gitRun, p(), cfg, { git: false });
    expect(local.map((c) => c.name)).toEqual([
      "orb image pin",
      "provider image pin",
      "debugExec",
      "secrets in git",
    ]);
    const g = await fileChecks(gitRun, p(), cfg, { git: true });
    expect(g.map((c) => c.name).slice(4)).toEqual(["gitignore", "wrangler pin"]);
  });
});
