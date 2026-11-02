import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseConfigText } from "../src/config";
import {
  ensureGitignore,
  fileMode,
  materialize,
  projectPaths,
  providerBuild,
  readControlToken,
  readState,
  withSecretsFile,
  writeControlToken,
  writeState,
} from "../src/project";

let dir: string;
let templates: string;

async function fakeTemplates(root: string) {
  await mkdir(join(root, "worker", "src"), { recursive: true });
  await writeFile(join(root, "worker", "src", "index.ts"), "export default {};\n");
  await mkdir(join(root, "image"), { recursive: true });
  await writeFile(join(root, "image", "Dockerfile"), "FROM scratch\n");
  await mkdir(join(root, "provider"), { recursive: true });
  await writeFile(join(root, "provider", "Dockerfile"), "FROM node\n");
  await mkdir(join(root, "dispatch"), { recursive: true });
  await writeFile(join(root, "dispatch", "dispatch.sh"), "#!/bin/sh\n");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cf-orbs-test-"));
  templates = await mkdtemp(join(tmpdir(), "cf-orbs-tpl-"));
  await fakeTemplates(templates);
});

describe("secrets file", () => {
  it("is 0600 while fn runs and deleted afterwards", async () => {
    let seen = "";
    const r = await withSecretsFile({ CONTROL_TOKEN: "a".repeat(64) }, async (f) => {
      seen = f;
      expect(JSON.parse(await readFile(f, "utf8"))).toEqual({ CONTROL_TOKEN: "a".repeat(64) });
      expect(await fileMode(f)).toBe(0o600);
      return 42;
    });
    expect(r).toBe(42);
    expect(existsSync(seen)).toBe(false);
  });
  it("is deleted even when the deploy fails", async () => {
    let seen = "";
    await expect(
      withSecretsFile({ AMP_ORB_PROVIDER_TOKEN: "aop_live_secretvalue" }, async (f) => {
        seen = f;
        throw new Error("deploy exploded");
      }),
    ).rejects.toThrow("deploy exploded");
    expect(seen).not.toBe("");
    expect(existsSync(seen)).toBe(false);
  });
});

describe("project files", () => {
  it("materialize writes config, Dockerfile, gitignore, copies templates; keeps user files on re-run", async () => {
    const p = projectPaths(dir);
    const r1 = await materialize(p, { templates, configOverrides: { providerHost: "external" } });
    expect(r1).toEqual({ wroteConfig: true, wroteDockerfile: true });
    expect(parseConfigText(await readFile(p.config, "utf8")).providerHost).toBe("external");
    expect(existsSync(join(p.stateDir, "worker", "src", "index.ts"))).toBe(true);
    expect(existsSync(join(p.stateDir, "provider", "Dockerfile"))).toBe(true);
    expect(existsSync(join(p.stateDir, "dispatch", "dispatch.sh"))).toBe(true);
    await writeFile(p.imageDockerfile, "FROM custom\n");
    await writeFile(join(p.stateDir, "worker", "src", "stale.ts"), "x");
    const r2 = await materialize(p, { templates });
    expect(r2).toEqual({ wroteConfig: false, wroteDockerfile: false });
    expect(await readFile(p.imageDockerfile, "utf8")).toBe("FROM custom\n");
    expect(existsSync(join(p.stateDir, "worker", "src", "stale.ts"))).toBe(false);
  });
  it("materialize fails with a fix when templates are missing", async () => {
    await expect(materialize(projectPaths(dir), { templates: join(dir, "nope") })).rejects.toThrow(
      /^Failed: CLI templates missing .* — fix: /,
    );
  });
  it("gitignore keeps existing lines, ignores .cf-orbs and the control token, is idempotent", async () => {
    const p = projectPaths(dir);
    await writeFile(p.gitignore, "node_modules/\n*.log");
    await ensureGitignore(p);
    await ensureGitignore(p);
    const g = await readFile(p.gitignore, "utf8");
    expect(g).toContain("*.log\n");
    expect(g).toContain(".cf-orbs/*");
    expect(g).toContain(".cf-orbs/control-token");
    expect(g.match(/node_modules\//g)).toHaveLength(1);
    expect(g.match(/\.cf-orbs\/\*/g)).toHaveLength(1);
  });
  it("control token is written 0600, also over an existing world-readable file", async () => {
    const p = projectPaths(dir);
    await mkdir(p.stateDir, { recursive: true });
    await writeFile(p.controlToken, "old\n", { mode: 0o644 });
    const t = "b".repeat(64);
    await writeControlToken(p, t);
    expect(await fileMode(p.controlToken)).toBe(0o600);
    expect(await readControlToken(p)).toBe(t);
  });
  it("state.json keeps only whitelisted fields (never tokens)", async () => {
    const p = projectPaths(dir);
    await writeState(p, {
      url: "https://x.y.workers.dev",
      mode: "cloudflare",
      token: "aop_live_x",
      CONTROL_TOKEN: "c",
    } as never);
    const raw = await readFile(p.state, "utf8");
    expect(raw).not.toMatch(/aop_live_|CONTROL_TOKEN|token/i);
    expect(await readState(p)).toMatchObject({ url: "https://x.y.workers.dev", mode: "cloudflare" });
  });
});

describe("providerBuild", () => {
  it("is 16 hex, stable, and changes when dispatch.sh, entry.sh or the provider Dockerfile change", async () => {
    const p = projectPaths(dir);
    await materialize(p, { templates });
    const a = await providerBuild(p);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await providerBuild(p)).toBe(a);
    await writeFile(join(p.stateDir, "provider", "README.md"), "docs only\n");
    expect(await providerBuild(p)).toBe(a);
    const seen = new Set([a]);
    for (const f of ["dispatch/dispatch.sh", "provider/entry.sh", "provider/Dockerfile"]) {
      await writeFile(join(p.stateDir, f), `changed ${f}\n`);
      const b = await providerBuild(p);
      expect(seen.has(b)).toBe(false);
      seen.add(b);
    }
  });
});
