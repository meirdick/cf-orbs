import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args";
import { runDoctor, statusChecks } from "../src/commands/doctor";
import {
  BACKUP_LINE,
  gatherProbes,
  initOptions,
  judgeProviderLog,
  parseVcpuFlag,
  plan,
  runInit,
} from "../src/commands/init";
import { logLines } from "../src/commands/logs";
import { renderOrb, renderStatus } from "../src/commands/status";
import { selectResources } from "../src/commands/uninstall";
import { planUpgrade } from "../src/commands/upgrade";
import { AMP_DEFAULT_IMAGE_REPO, DEFAULT_CONFIG, parseConfigText, validateConfig } from "../src/config";
import { type Ctx, makeCtx } from "../src/context";
import { fileMode, readState } from "../src/project";
import type { Ui } from "../src/ui";
import type { Runner } from "../src/wrangler";

const OLD = DEFAULT_CONFIG.ampImageDigest;
const NEW = `sha256:${"1".repeat(64)}`;
const DOCKERFILE = `FROM ${AMP_DEFAULT_IMAGE_REPO}@${OLD}\nUSER root\n`;

describe("upgrade plan", () => {
  const cfgText = readFileSync(new URL("../../cf-orbs.config.example.jsonc", import.meta.url), "utf8");
  it("bumps the digest, keeps the old image as orb-<short>, keeps comments", () => {
    const p = planUpgrade(DOCKERFILE, cfgText, NEW);
    if (p.noop) throw new Error("expected a change");
    expect(p.oldKey).toBe(`orb-${OLD.slice(7, 19)}`);
    expect(p.dockerfile).toBe(`FROM ${AMP_DEFAULT_IMAGE_REPO}@${NEW}\nUSER root\n`);
    expect(p.oldDockerfile).toBe(DOCKERFILE);
    const c = parseConfigText(p.configText);
    expect(c.images).toEqual({ [`${AMP_DEFAULT_IMAGE_REPO}@${OLD}`]: p.oldKey });
    expect(c.ampImageDigest).toBe(NEW);
    expect(p.configText).toContain("// Orb size.");
  });
  it("is a no-op on the same digest and rejects bad input", () => {
    expect(planUpgrade(DOCKERFILE, cfgText, OLD)).toEqual({ noop: true, digest: OLD });
    expect(() => planUpgrade(DOCKERFILE, cfgText, "sha256:short")).toThrow(
      /^Failed: --digest must look like/,
    );
    expect(() => planUpgrade("FROM node:24\n", cfgText, NEW)).toThrow(/has no FROM .*amp-orb@sha256/);
  });
  it("a second upgrade keeps both old keys", () => {
    const p1 = planUpgrade(DOCKERFILE, cfgText, NEW);
    if (p1.noop) throw new Error("expected a change");
    const p2 = planUpgrade(p1.dockerfile, p1.configText, `sha256:${"2".repeat(64)}`);
    if (p2.noop) throw new Error("expected a change");
    expect(Object.values(parseConfigText(p2.configText).images).sort()).toEqual(
      [p1.oldKey, "orb-111111111111"].sort(),
    );
  });
});

describe("doctor status checks", () => {
  const cfg = validateConfig({ images: { "r/x:1": "custom" } });
  it("passes a running provider and known image keys", () => {
    const st = {
      registry: { retainedSnapshots: 1, imageKeys: ["orb"] },
      provider: { running: true, logTail: ["starting", "waiting for jobs"] },
      orbs: [{ orb: { orbId: "a", imageKey: "orb", handle: { imageKey: "custom" } } }],
    };
    const c = statusChecks(st, cfg);
    expect(c.map((x) => x.status)).toEqual(["PASS", "PASS"]);
    expect(c[0]?.detail).toContain("waiting for jobs");
  });
  it("fails a stopped provider and a stale image key with one-line fixes", () => {
    const st = {
      registry: { imageKeys: ["orb", "orb-deadbeef0000"] },
      provider: { running: false, logTail: [] },
    };
    const c = statusChecks(st, cfg);
    expect(c.map((x) => x.status)).toEqual(["FAIL", "FAIL"]);
    for (const x of c) expect(x.detail).toMatch(/^Failed: [^\n]+ — fix: [^\n]+$/);
    expect(c[1]?.detail).toContain("orb-deadbeef0000");
  });
  it("skips the provider check in external mode", () => {
    expect(statusChecks({}, validateConfig({ providerHost: "external" }))[0]?.status).toBe("SKIP");
  });
  it("external mode fails when the Worker's own provider runs too (two providers on one token)", () => {
    const c = statusChecks({ provider: { running: true } }, validateConfig({ providerHost: "external" }), {
      wranglerPath: "/p/.cf-orbs/wrangler.jsonc",
    });
    expect(c[0]?.status).toBe("FAIL");
    expect(c[0]?.detail).toMatch(
      /two providers on one token\) — fix: npx wrangler secret delete AMP_ORB_PROVIDER_TOKEN --config \/p\/\.cf-orbs\/wrangler\.jsonc$/,
    );
  });
  it("cloudflare mode without the token secret says so instead of 'wait for the cron'", () => {
    const c = statusChecks({ provider: { running: false } }, cfg, { tokenSecret: false });
    expect(c[0]?.status).toBe("FAIL");
    expect(c[0]?.detail).toMatch(
      /no AMP_ORB_PROVIDER_TOKEN secret.* — fix: rerun cf-orbs init with AMP_ORB_PROVIDER_TOKEN/,
    );
  });
  it("shows the provider lastError", () => {
    const c = statusChecks({ provider: { running: false, lastError: "Failed: boom — fix: x" } }, cfg);
    expect(c[0]?.detail).toContain("last error: Failed: boom");
  });
});

describe("provider log judge (init wait-provider)", () => {
  it("fails on a rejected token and on a second provider; counts restarts", () => {
    const rej = judgeProviderLog(["starting; amp 1.0", "Error: Amp rejected the orb provider token"]);
    expect(rej.kind === "fail" && rej.error.message).toMatch(
      /^Failed: Amp rejected the provider token .* — fix: .*--token-file/,
    );
    const two = judgeProviderLog([
      "starting; amp 1.0",
      "Another amp orb provider is connected… Waiting for it to stop",
    ]);
    expect(two.kind === "fail" && two.error.message).toMatch(
      /another amp orb provider already uses this token/,
    );
    expect(
      judgeProviderLog(["starting; amp 1", "amp orb provider exited with code 1 after 3s; restarting in 5s"]),
    ).toEqual({ kind: "ok", exits: 1 });
  });
  it("only lines since the last container start count", () => {
    expect(
      judgeProviderLog([
        "starting; amp 1",
        "Error: Amp rejected the orb provider token",
        "starting; amp 1",
        "ok",
      ]),
    ).toEqual({ kind: "ok", exits: 0 });
  });
});

describe("uninstall resource selection", () => {
  it("picks only this Worker's apps and image tags", () => {
    const apps = JSON.stringify([
      { id: "1", name: "cf-orbs-orbsession" },
      { id: "2", name: "cf-orbs-providerhost" },
      { id: "3", name: "cf-orbs-spike-spike" },
      { id: "4", name: "other" },
    ]);
    const images = JSON.stringify([
      { name: "cf-orbs-orbsession-orb", tags: ["wrangler-a", "rootfs-snapshot-b"] },
      { name: "cf-orbs-providerhost-provider", tags: ["wrangler-c"] },
      { name: "cf-orbs-spike-spike-orb", tags: ["x"] },
    ]);
    expect(selectResources("cf-orbs", apps, images)).toEqual({
      worker: "cf-orbs",
      apps: [
        { id: "1", name: "cf-orbs-orbsession" },
        { id: "2", name: "cf-orbs-providerhost" },
      ],
      images: [
        "cf-orbs-orbsession-orb:wrangler-a",
        "cf-orbs-orbsession-orb:rootfs-snapshot-b",
        "cf-orbs-providerhost-provider:wrangler-c",
      ],
    });
  });
});

describe("status and logs rendering", () => {
  const now = Date.parse("2026-10-30T20:00:00Z");
  it("renders install status with an orb table", () => {
    const text = renderStatus(
      {
        registry: {
          projectSnapshots: 1,
          retainedSnapshots: 3,
          retainedSnapshotBytes: 2.5e9,
          running: ["amp-T-2"],
          max: 20,
          nextExpiry: "2026-11-29T18:00:00Z",
        },
        provider: { running: true, startedAt: "2026-10-30T19:59:00Z", restarts: 1, logTail: ["ready"] },
        orbs: [
          {
            orb: {
              orbId: "amp-T-1",
              state: "paused",
              imageKey: "orb",
              handle: { createdAt: "2026-10-30T18:00:00Z", size: 31e6 },
            },
            containerRunning: false,
          },
        ],
      },
      now,
    );
    expect(text).toContain("provider: running, started 60s ago (2026-10-30T19:59:00Z), restarts 1");
    expect(text).toContain("provider log: ready");
    expect(text).not.toContain("provider image:");
    expect(text).toContain(
      "snapshots: 3 retained, 2.50 GB, 1 project snapshot(s), next expiry 2026-11-29T18:00:00Z",
    );
    expect(text).toContain("awake orbs: 1 of 20\n  amp-T-2");
    expect(text).toMatch(/amp-T-1\s+paused\s+no\s+orb\s+2h\s+31 MB/);
  });

  it("renders the provider image digest, and a pending restart when the deploy has another build", () => {
    const img = (d: string) => `registry.cloudflare.com/acct/cf-orbs-providerhost-provider@sha256:${d}`;
    const provider = {
      running: true,
      startedAt: "2026-10-30T19:59:00Z",
      restarts: 2,
      image: img("0123456789abcdef0123"),
      build: "b1",
      deployedImage: img("0123456789abcdef0123"),
      deployedBuild: "b1",
      logTail: [],
    };
    const same = renderStatus({ provider }, now);
    expect(same).toContain(
      "provider: running, started 60s ago (2026-10-30T19:59:00Z), restarts 2, image sha256:0123456789ab",
    );
    expect(same).not.toContain("provider image:");
    const pending = renderStatus(
      { provider: { ...provider, deployedImage: img("fedcba9876543210"), deployedBuild: "b2" } },
      now,
    );
    expect(pending).toContain(
      "provider image: the deploy has a new one (sha256:fedcba987654); the 5-min check restarts the provider",
    );
  });

  it("renders project snapshots with age, amp version, image digest and the stale flag", () => {
    const text = renderStatus(
      {
        registry: {
          projectSnapshots: 1,
          projects: [
            {
              snapshotId: "snap-a-0011aabb",
              createdAt: "2026-10-30T18:00:00Z",
              lastUsedAt: "2026-10-30T19:00:00Z",
              ampVersion: "0.0.1793387810-g5421c2",
              imageRef: "registry.cloudflare.com/acct/cf-orbs-orb@sha256:0123456789abcdef",
              expired: false,
            },
            {
              snapshotId: "snap-b-0022ccdd",
              createdAt: "2026-10-29T20:00:00Z",
              lastUsedAt: "2026-10-30T19:30:00Z",
              stale: { reason: "amp updated 1 -> 2", at: "2026-10-30T19:30:00Z", forgotten: true },
              expired: false,
            },
          ],
          running: [],
          max: 20,
        },
      },
      now,
    );
    expect(text).toMatch(/PROJECT SNAPSHOT\s+AGE\s+AMP\s+IMAGE\s+STALE/);
    expect(text).toMatch(/snap-a-0011aabb\s+2h\s+0\.0\.1793387810-g5421c2\s+sha256:0123456789ab\s+no/);
    expect(text).toMatch(/snap-b-0022ccdd\s+24h\s+-\s+-\s+yes, forgotten/);
    expect(text).toContain(
      "project snapshot snap-b-0022ccdd stale since 2026-10-30T19:30:00Z (amp updated 1 -> 2): delete it in Amp settings to re-prepare",
    );
    expect(text).not.toContain("project snapshot snap-a-0011aabb stale");
    expect(renderStatus({ registry: { projects: [] } }, now)).not.toContain("PROJECT SNAPSHOT");
  });
  it("renders one orb", () => {
    const text = renderOrb(
      {
        orb: {
          orbId: "amp-T-1",
          state: "awake",
          imageKey: "orb",
          lastSpawnMs: 14100,
          spawns: [
            { at: "x", source: "image", ms: 45100, ok: true },
            { at: "y", source: "image", ms: 3000, ok: false, error: "e" },
            { at: "z", source: "per-orb-snapshot", ms: 14100, ok: true },
          ],
        },
        containerRunning: true,
        doColo: "YYZ",
      },
      now,
    );
    expect(text).toMatch(/state\s+awake/);
    expect(text).toMatch(/last spawn\s+14.1 s/);
    expect(text).toMatch(/recent spawns\s+14.1 s per-orb-snapshot, FAILED image, 45.1 s image/);
    expect(text).toMatch(/DO colo\s+YYZ/);
    expect(text).not.toContain("warm until");
  });
  it("renders a warm orb with the time left", () => {
    const warmUntil = new Date(now + 8 * 60_000).toISOString();
    const status = { orb: { orbId: "amp-T-1", state: "warm", warmUntil }, containerRunning: true };
    const text = renderOrb(status, now);
    expect(text).toMatch(/state\s+warm \(8m left\)/);
    expect(text).toContain(`warm until`);
    expect(renderStatus({ orbs: [status] }, now)).toMatch(/amp-T-1\s+warm \(8m left\)\s+yes/);
  });
  it("renders the last prewarm run", () => {
    const at = new Date(now - 3 * 60_000).toISOString();
    const run = (o: object) => renderStatus({ prewarm: { at, count: 2, ...o } }, now);
    expect(run({ ok: 2, failed: 0, pending: 0, msPerInstance: [41_200, 38_800] })).toContain(
      "prewarm: 2 of 2 ready in 41 s and 39 s, 3m ago",
    );
    expect(
      run({
        ok: 1,
        failed: 1,
        pending: 0,
        msPerInstance: [41_000],
        jobs: [{ state: "ready" }, { state: "failed", error: "not ready in 3 min" }],
      }),
    ).toContain("prewarm: 1 of 2 ready in 41 s, 1 failed (not ready in 3 min), 3m ago");
    expect(run({ ok: 0, failed: 0, pending: 2, msPerInstance: [] })).toContain(
      "prewarm: 0 of 2 ready, 2 still starting, 3m ago",
    );
    expect(renderStatus({ prewarm: null }, now)).not.toContain("prewarm");
    expect(renderStatus({}, now)).not.toContain("prewarm");
  });
  it("accepts {lines}, arrays and text bodies for logs", () => {
    expect(logLines({ lines: ["a", "b"] })).toEqual(["a", "b"]);
    expect(logLines(["x"])).toEqual(["x"]);
    expect(logLines({ containerRunning: true, log: "boot\n== control plane\nspawn ok" })).toEqual([
      "boot",
      "== control plane",
      "spawn ok",
    ]);
    expect(logLines("l1\nl2\n")).toEqual(["l1", "l2"]);
    expect(logLines("")).toEqual([]);
  });
});

// ---------- end to end against fakes ----------

interface Captured {
  ui: Ui;
  lines: string[];
}
function captureUi(): Captured {
  const lines: string[] = [];
  const push = (l: string) => lines.push(l);
  return {
    lines,
    ui: {
      json: false,
      nonInteractive: true,
      step: push,
      warn: push,
      out: push,
      result: () => {},
      raw: () => {},
    },
  };
}

async function fakeTemplates(root: string) {
  for (const [f, body] of [
    ["worker/src/index.ts", "export default {};\n"],
    ["image/Dockerfile", DOCKERFILE],
    ["provider/Dockerfile", `FROM node:24-bookworm-slim@sha256:${"c".repeat(64)}\n`],
    ["dispatch/dispatch.sh", "#!/bin/sh\n"],
  ] as const) {
    await mkdir(join(root, f, ".."), { recursive: true });
    await writeFile(join(root, f), body);
  }
}

describe("init end to end (fake wrangler, docker and control plane)", () => {
  let dir: string;
  let templates: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cf-orbs-e2e-"));
    templates = await mkdtemp(join(tmpdir(), "cf-orbs-tpl-"));
    await fakeTemplates(templates);
  });

  function setup(
    argv: string[],
    env: Record<string, string>,
    providerRunningAfter = 2,
    startRoute = true,
    extra: {
      logTail?: string[];
      subdomain?: "has" | "none";
      secretList?: string[];
      warm?: "ok" | "fail";
      /** wrangler containers list: ok (default), paid (plan error), other (unknown error) */
      containers?: "ok" | "paid" | "other";
      /**
       * wrangler deployments list --name: missing (default until a deploy ran, then found), found,
       * or error (wrangler fails with a network error)
       */
      worker?: "missing" | "found" | "error";
      /** GET /v1/warm after init starts prewarm: ok (default), failed (no instance ready), pending (never done) */
      selftest?: "ok" | "failed" | "pending";
      /** /v1/provider/restart body; {status, error} answers with that HTTP error */
      restart?: Record<string, unknown>;
      /** provider fields merged into /v1/status, given the call count */
      providerStatus?: (n: number) => Record<string, unknown>;
    } = {},
  ) {
    const deploySecrets: Record<string, string>[] = [];
    const cfApi: string[] = [];
    const secretDeletes: string[] = [];
    const secretPaths: string[] = [];
    const wranglerCalls: string[] = [];
    let workerDeployed = false;
    const run: Runner = async (cmd, args, ro) => {
      if (cmd === "docker") return { code: 0, stdout: "27.0.0", stderr: "" };
      if (args.includes("whoami"))
        return {
          code: 0,
          stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: "acct1", name: "Me" }] }),
          stderr: "",
        };
      if (args.includes("containers") && args.includes("list")) {
        if (extra.containers === "paid")
          return {
            code: 1,
            stdout: "",
            stderr: "A request to the Cloudflare API failed: Containers need the Workers Paid plan",
          };
        if (extra.containers === "other") return { code: 1, stdout: "", stderr: "network unreachable" };
        return { code: 0, stdout: "[]", stderr: "" };
      }
      if (cmd !== "docker") wranglerCalls.push(`${ro?.env?.CLOUDFLARE_ACCOUNT_ID} ${args.join(" ")}`);
      if (args.includes("deploy")) {
        workerDeployed = true;
        const f = args[args.indexOf("--secrets-file") + 1] as string;
        secretPaths.push(f);
        deploySecrets.push(JSON.parse(readFileSync(f, "utf8")));
        expect(args).toContain("--config");
        return { code: 0, stdout: "Uploaded cf-orbs\n  https://cf-orbs.sub.workers.dev\n", stderr: "" };
      }
      if (args.includes("auth") && args.includes("token")) {
        if (!extra.subdomain) return { code: 1, stdout: "", stderr: "not logged in" };
        return {
          code: 0,
          stdout: JSON.stringify({ type: "oauth", token: "oauth-secret-value-123" }),
          stderr: "",
        };
      }
      if (args.includes("secret") && args.includes("list")) {
        const names = extra.secretList ?? ["CONTROL_TOKEN", "AMP_ORB_PROVIDER_TOKEN"];
        return {
          code: 0,
          stdout: JSON.stringify(names.map((name) => ({ name, type: "secret_text" }))),
          stderr: "",
        };
      }
      if (args.includes("secret")) {
        secretDeletes.push(args.join(" "));
        return { code: 0, stdout: "Success", stderr: "" };
      }
      if (args.includes("deployments")) {
        const w = extra.worker ?? (workerDeployed ? "found" : "missing");
        if (w === "missing")
          return {
            code: 1,
            stdout: "",
            stderr:
              "\u001b[31m✘ [ERROR]\u001b[0m A request to the Cloudflare API (/accounts/acct1/workers/scripts/cf-orbs/deployments) failed.\n\n  This Worker does not exist on your account. [code: 10007]\n",
          };
        if (w === "error") return { code: 1, stdout: "", stderr: "fetch failed: network unreachable" };
        return { code: 0, stdout: '[{"created_on":"2026-10-30T20:00:00Z"}]', stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${cmd} ${args.join(" ")}` };
    };
    let statusCalls = 0;
    const calls: string[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const auth = (init?.headers as Record<string, string>)?.authorization ?? "";
      if (u.hostname === "api.cloudflare.com") {
        cfApi.push(`${init?.method ?? "GET"} ${u.pathname} ${init?.body ?? ""} ${auth}`);
        if ((init?.method ?? "GET") === "PUT")
          return Response.json({ success: true, result: { subdomain: "x" } });
        if (extra.subdomain === "has") return Response.json({ success: true, result: { subdomain: "me" } });
        return Response.json(
          {
            success: false,
            errors: [{ code: 10007, message: "This account does not have a workers.dev subdomain" }],
          },
          { status: 404 },
        );
      }
      calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
      if (!/^Bearer [0-9a-f]{64}$/.test(auth)) return new Response("", { status: 401 });
      if (u.pathname === "/v1/health") return Response.json({ ok: true });
      if (u.pathname === "/v1/provider/start" && startRoute) return Response.json({ ok: true });
      if (u.pathname === "/v1/provider/restart" && init?.method === "POST") {
        expect(u.searchParams.get("ifImageChanged")).toBe("1");
        const r = extra.restart ?? { action: "keep", reason: "running", restarted: false };
        if (typeof r.status === "number") return Response.json({ error: r.error }, { status: r.status });
        return Response.json(r);
      }
      if (u.pathname === "/v1/warm" && init?.method === "POST") {
        if (extra.warm === "fail")
          return Response.json(
            { error: "Failed: internal error: DO overloaded — fix: retry" },
            { status: 500 },
          );
        return Response.json({ runId: "1", count: 2, started: 2, orbIds: ["warm-1-1", "warm-2-1"] });
      }
      if (u.pathname === "/v1/warm" && (init?.method ?? "GET") === "GET") {
        const at = new Date(1_000_000 + t).toISOString();
        const st = extra.selftest ?? "ok";
        const last =
          st === "pending"
            ? { runId: "1", count: 2, at, ok: 0, failed: 0, pending: 2, msPerInstance: [] }
            : st === "failed"
              ? {
                  runId: "1",
                  count: 2,
                  at,
                  ok: 0,
                  failed: 2,
                  pending: 0,
                  msPerInstance: [],
                  jobs: [{ state: "failed", error: "image pull failed" }],
                }
              : { runId: "1", count: 2, at, ok: 2, failed: 0, pending: 0, msPerInstance: [41000, 39000] };
        return Response.json({ prewarm: 2, last });
      }
      if (u.pathname === "/v1/status") {
        statusCalls++;
        return Response.json({
          registry: {
            projectSnapshots: 0,
            retainedSnapshots: 0,
            retainedSnapshotBytes: 0,
            running: [],
            max: 20,
          },
          provider: {
            running: statusCalls >= providerRunningAfter,
            restarts: 0,
            stopped: false,
            logTail: extra.logTail ?? ["provider connected"],
            ...(extra.providerStatus?.(statusCalls) ?? {}),
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    let t = 0;
    const cap = captureUi();
    const ctx: Ctx = makeCtx(
      cap.ui,
      parseArgs(argv, {
        provider: { type: "string" },
        "non-interactive": { type: "boolean" },
        "provider-name": { type: "string" },
        vcpu: { type: "string" },
        adopt: { type: "boolean" },
        name: { type: "string" },
        "no-deploy": { type: "boolean" },
      }),
      dir,
      {
        run,
        fetch: fakeFetch,
        env,
        sleep: async (ms) => {
          t += ms;
        },
        now: () => 1_000_000 + t,
        templates,
      },
    );
    return { ctx, cap, deploySecrets, secretPaths, calls, secretDeletes, cfApi, wranglerCalls };
  }

  it("plan check: a Containers plan error stops init before scaffold and deploy", async () => {
    const { ctx, deploySecrets, calls } = setup(
      ["--non-interactive"],
      { AMP_ORB_PROVIDER_TOKEN: "aop_live_testtoken123" },
      2,
      true,
      { containers: "paid" },
    );
    const o = initOptions(ctx);
    const probes = { ...(await gatherProbes(ctx)), tty: false };
    await expect(runInit(ctx, o, plan(o, probes))).rejects.toThrow(/Workers Paid/);
    expect(deploySecrets).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("plan check: an unknown wrangler error is a warning and init goes on", async () => {
    const { ctx, cap } = setup(
      ["--non-interactive"],
      { AMP_ORB_PROVIDER_TOKEN: "aop_live_testtoken123" },
      2,
      true,
      { containers: "other" },
    );
    const o = initOptions(ctx);
    const probes = { ...(await gatherProbes(ctx)), tty: false };
    await runInit(ctx, o, plan(o, probes));
    expect(cap.lines.join("\n")).toMatch(/plan check skipped .*network unreachable/);
  });

  it("self-test: fails init when no prewarm instance becomes ready", async () => {
    const { ctx } = setup(
      ["--non-interactive"],
      { AMP_ORB_PROVIDER_TOKEN: "aop_live_testtoken123" },
      2,
      true,
      { selftest: "failed" },
    );
    const o = initOptions(ctx);
    const probes = { ...(await gatherProbes(ctx)), tty: false };
    await expect(runInit(ctx, o, plan(o, probes))).rejects.toThrow(
      /orb self-test failed: no instance started from the new image \(image pull failed\)/,
    );
  });

  it("self-test: still pending after the wait is a warning, not a failure", async () => {
    const { ctx, cap } = setup(
      ["--non-interactive"],
      { AMP_ORB_PROVIDER_TOKEN: "aop_live_testtoken123" },
      2,
      true,
      { selftest: "pending" },
    );
    const o = initOptions(ctx);
    const probes = { ...(await gatherProbes(ctx)), tty: false };
    await runInit(ctx, o, plan(o, probes));
    expect(cap.lines.join("\n")).toMatch(/self-test: still running after 3 min/);
  });

  it("cloudflare mode: deploys with both secrets, deletes the secrets file, waits for the provider, prints the amp command", async () => {
    const token = "aop_live_testtoken123";
    const { ctx, cap, deploySecrets, secretPaths, calls } = setup(["--non-interactive"], {
      AMP_ORB_PROVIDER_TOKEN: token,
    });
    const o = initOptions(ctx);
    const probes = { ...(await gatherProbes(ctx)), tty: false };
    const r = await runInit(ctx, o, plan(o, probes));
    expect(r).toEqual({
      url: "https://cf-orbs.sub.workers.dev",
      command: 'amp -ox "hello from cf-orbs" --orb-provider cloudflare',
      providerName: "cloudflare",
    });
    expect(deploySecrets).toHaveLength(1);
    expect(deploySecrets[0]?.AMP_ORB_PROVIDER_TOKEN).toBe(token);
    expect(deploySecrets[0]?.CONTROL_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(secretPaths[0] as string)).toBe(false);
    // running is only the container state: init waits until it has stayed up 15 s with a clean log
    expect(calls.slice(0, 6)).toEqual([
      "GET /v1/health",
      "GET /v1/status",
      "POST /v1/warm",
      "GET /v1/warm",
      "POST /v1/provider/start",
      "GET /v1/status",
    ]);
    expect(calls.slice(6).every((c) => c === "GET /v1/status")).toBe(true);
    expect(cap.lines).toContain("plan: Containers are available on this account");
    expect(cap.lines).toContain("self-test: orb image starts (2 of 2 ready in 41 s and 39 s)");
    expect(cap.lines).toContain("prewarm: started 2 instances in the background; check cf-orbs status");
    // no --provider-name: the name is the default, so init warns that it must match Amp
    expect(cap.lines).toContain(
      "provider name cloudflare was not given explicitly; it must match the name in Amp Settings → Orbs (pass --provider-name <name> if it differs)",
    );
    expect(calls.length).toBeGreaterThanOrEqual(6);
    const state = await readState(ctx.paths);
    expect(state).toMatchObject({
      url: "https://cf-orbs.sub.workers.dev",
      accountId: "acct1",
      mode: "cloudflare",
      providerName: "cloudflare",
    });
    const stateRaw = await readFile(ctx.paths.state, "utf8");
    expect(stateRaw).not.toContain(token);
    expect(stateRaw).not.toContain(deploySecrets[0]?.CONTROL_TOKEN);
    expect(await fileMode(ctx.paths.controlToken)).toBe(0o600);
    const wr = await readFile(ctx.paths.wrangler, "utf8");
    expect(wr).toContain('"account_id": "acct1"');
    expect(wr).not.toContain(token);
    expect(cap.lines.join("\n")).not.toContain(token);

    // re-run without a token: keeps the Amp secret, reuses the control token
    const again = setup(["--non-interactive"], {});
    const o2 = initOptions(again.ctx);
    const p2 = plan(o2, { ...(await gatherProbes(again.ctx)), tty: false });
    expect(p2.find((s) => s.kind === "amp-token")).toEqual({ kind: "amp-token", source: "keep" });
    await runInit(again.ctx, o2, p2);
    expect(again.deploySecrets[0]).toEqual({ CONTROL_TOKEN: deploySecrets[0]?.CONTROL_TOKEN });
    // the name is saved from the first run: no warning on the re-run
    expect(again.cap.lines).not.toContain("provider name cloudflare was not given explicitly");
  });

  it("default provider name is cloudflare, with the fallback warning", async () => {
    const { ctx, cap } = setup(["--non-interactive"], { AMP_ORB_PROVIDER_TOKEN: "aop_live_x1234567" });
    const o = initOptions(ctx);
    expect(o.providerName).toBe("cloudflare");
    expect(o.providerNameSource).toBe("default");
    await runInit(ctx, o, plan(o, { ...(await gatherProbes(ctx)), tty: false }));
    expect(cap.lines.join("\n")).toContain("provider name cloudflare was not given explicitly");
  });

  it("provider name chain: flag, env, saved, config name (not cf-orbs), default", () => {
    const pick = (
      args: string[],
      env: Record<string, string>,
      existing?: Parameters<typeof initOptions>[1],
    ) => {
      const o = initOptions(setup(args, env).ctx, existing);
      return [o.providerName, o.providerNameSource];
    };
    expect(
      pick(["--provider-name", "f"], { AMP_ORB_PROVIDER_NAME: "e" }, { providerName: "s", name: "c" }),
    ).toEqual(["f", "flag"]);
    expect(pick([], { AMP_ORB_PROVIDER_NAME: "e" }, { providerName: "s", name: "c" })).toEqual(["e", "env"]);
    expect(pick([], {}, { providerName: "s", name: "c" })).toEqual(["s", "saved"]);
    expect(pick([], {}, { name: "cf-orbs-small" })).toEqual(["cloudflare", "default"]);
    expect(pick([], {}, { name: "cf-orbs" })).toEqual(["cloudflare", "default"]);
    expect(pick([], {})).toEqual(["cloudflare", "default"]);
  });

  it("success prints the back up line last, before the amp command", async () => {
    const { ctx, cap } = setup(["--non-interactive"], { AMP_ORB_PROVIDER_TOKEN: "aop_live_x1234567" });
    const o = initOptions(ctx);
    const r = await runInit(ctx, o, plan(o, { ...(await gatherProbes(ctx)), tty: false }));
    expect(cap.lines.at(-1)).toBe(BACKUP_LINE);
    expect(cap.lines.filter((l) => l.startsWith("back up:"))).toHaveLength(1);
    expect(r.command).toContain("amp -ox");
    expect(BACKUP_LINE).toContain("cf-orbs.config.jsonc and image/");
  });

  it("provider name given with --provider-name: no warning, used in the final command", async () => {
    const { ctx, cap } = setup(["--non-interactive", "--provider-name", "my-orbs"], {
      AMP_ORB_PROVIDER_TOKEN: "aop_live_x1234567",
    });
    const o = initOptions(ctx);
    const r = await runInit(ctx, o, plan(o, { ...(await gatherProbes(ctx)), tty: false }));
    expect(r.command).toContain("--orb-provider my-orbs");
    expect(cap.lines).not.toContain("provider name my-orbs was not given explicitly");
  });

  it("cloudflare mode: Amp rejects the token → fails with the token fix, no success line", async () => {
    const { ctx, cap } = setup(
      ["--non-interactive"],
      { AMP_ORB_PROVIDER_TOKEN: "aop_live_x1234567" },
      1,
      true,
      {
        logTail: ["starting; amp 1.0", "Error: Amp rejected the orb provider token"],
      },
    );
    const o = initOptions(ctx);
    await expect(runInit(ctx, o, plan(o, { ...(await gatherProbes(ctx)), tty: false }))).rejects.toThrow(
      /^Failed: Amp rejected the provider token \(wrong or revoked\) — fix: /,
    );
    expect(cap.lines.join("\n")).not.toContain("provider: running");
  });

  it("registers a workers.dev subdomain when the account has none (--subdomain / CF_ORBS_SUBDOMAIN)", async () => {
    const { ctx, cap, cfApi } = setup(
      ["--non-interactive"],
      { AMP_ORB_PROVIDER_TOKEN: "aop_live_x1234567", CF_ORBS_SUBDOMAIN: "my-orbs" },
      1,
      true,
      { subdomain: "none" },
    );
    const o = initOptions(ctx);
    await runInit(ctx, o, plan(o, { ...(await gatherProbes(ctx)), tty: false }));
    expect(cfApi.map((c) => c.split(" ").slice(0, 3).join(" "))).toEqual([
      "GET /client/v4/accounts/acct1/workers/subdomain ",
      'PUT /client/v4/accounts/acct1/workers/subdomain {"subdomain":"my-orbs"}',
    ]);
    expect(cfApi[0]).toContain("Bearer oauth-secret-value-123");
    expect(cap.lines.join("\n")).toContain("registered my-orbs.workers.dev");
    expect(cap.lines.join("\n")).not.toContain("oauth-secret-value-123");
  });

  it("no subdomain, non-interactive, no name → one-line failure with the real account URL", async () => {
    const { ctx } = setup(["--non-interactive"], { AMP_ORB_PROVIDER_TOKEN: "aop_live_x1234567" }, 1, true, {
      subdomain: "none",
    });
    const o = initOptions(ctx);
    await expect(runInit(ctx, o, plan(o, { ...(await gatherProbes(ctx)), tty: false }))).rejects.toThrow(
      "Failed: this account has no workers.dev subdomain yet — fix: rerun with --subdomain <name>, or open https://dash.cloudflare.com/acct1/workers/onboarding",
    );
  });

  it("an existing subdomain is left alone", async () => {
    const { ctx, cfApi } = setup(
      ["--non-interactive"],
      { AMP_ORB_PROVIDER_TOKEN: "aop_live_x1234567" },
      1,
      true,
      {
        subdomain: "has",
      },
    );
    const o = initOptions(ctx);
    await runInit(ctx, o, plan(o, { ...(await gatherProbes(ctx)), tty: false }));
    expect(cfApi).toHaveLength(1);
  });

  it("cloudflare mode: provider never starts → one-line failure after 90 s", async () => {
    const { ctx } = setup(
      ["--non-interactive"],
      { AMP_ORB_PROVIDER_TOKEN: "aop_live_x1234567" },
      Number.POSITIVE_INFINITY,
    );
    const o = initOptions(ctx);
    await expect(runInit(ctx, o, plan(o, { ...(await gatherProbes(ctx)), tty: false }))).rejects.toThrow(
      /^Failed: provider did not report running within 90 s — fix: run cf-orbs doctor/,
    );
  });

  it("cloudflare mode without a start route: waits for the cron tick (5 min + 90 s)", async () => {
    // provider reports running on the 50th status poll (5 s apart ≈ 4 min): too late for 90 s, fine with the cron wait
    const { ctx, cap, calls } = setup(
      ["--non-interactive"],
      { AMP_ORB_PROVIDER_TOKEN: "aop_live_x1234567" },
      50,
      false,
    );
    const o = initOptions(ctx);
    const r = await runInit(ctx, o, plan(o, { ...(await gatherProbes(ctx)), tty: false }));
    expect(r.command).toContain("--orb-provider cloudflare");
    expect(calls).toContain("POST /v1/provider/start");
    expect(cap.lines.join("\n")).toContain("waiting up to 390 s");
  });

  it("external mode: only CONTROL_TOKEN, prints dispatch env without the token value", async () => {
    const { ctx, cap, deploySecrets, calls } = setup(["--provider", "external", "--non-interactive"], {});
    const o = initOptions(ctx);
    expect(o.mode).toBe("external");
    const r = await runInit(ctx, o, plan(o, { ...(await gatherProbes(ctx)), tty: false }));
    expect(Object.keys(deploySecrets[0] ?? {})).toEqual(["CONTROL_TOKEN"]);
    expect(calls).toEqual(["GET /v1/health", "GET /v1/status", "POST /v1/warm", "GET /v1/warm"]);
    const out = cap.lines.join("\n");
    expect(out).toContain("CF_ORBS_URL=https://cf-orbs.sub.workers.dev");
    expect(out).toContain(`CF_ORBS_CONTROL_TOKEN_FILE=${ctx.paths.controlToken}`);
    expect(out).not.toContain(deploySecrets[0]?.CONTROL_TOKEN);
    expect(r.command).toContain("--orb-provider cloudflare");
    expect(parseConfigText(await readFile(ctx.paths.config, "utf8")).providerHost).toBe("external");
  });

  it("no --vcpu: the config gets the default 4 vCPU, 12 GiB, 20 GB", async () => {
    const { ctx } = setup(["--non-interactive"], { AMP_ORB_PROVIDER_TOKEN: "aop_live_x1234567" }, 1);
    const o = initOptions(ctx);
    expect(o.vcpu).toBeUndefined();
    await runInit(ctx, o, plan(o, { ...(await gatherProbes(ctx)), tty: false }));
    const c = parseConfigText(await readFile(ctx.paths.config, "utf8"));
    expect(c.instance).toEqual({ vcpu: 4, memoryMib: 12288, diskMb: 20000 });
    const wr = await readFile(ctx.paths.wrangler, "utf8");
    expect(wr).toContain('\\"vcpu\\":4,\\"memoryMib\\":12288');
  });

  it("--vcpu 2 writes 2 vCPU, 6 GiB, 20 GB on one line and keeps comments; a re-run keeps it; --vcpu 3 changes it", async () => {
    await writeFile(
      join(templates, "cf-orbs.config.example.jsonc"),
      readFileSync(new URL("../../cf-orbs.config.example.jsonc", import.meta.url), "utf8"),
    );
    const first = setup(
      ["--non-interactive", "--vcpu", "2"],
      { AMP_ORB_PROVIDER_TOKEN: "aop_live_x1234567" },
      1,
    );
    const o1 = initOptions(first.ctx);
    expect(o1.vcpu).toBe(2);
    await runInit(first.ctx, o1, plan(o1, { ...(await gatherProbes(first.ctx)), tty: false }));
    const text = await readFile(first.ctx.paths.config, "utf8");
    expect(text).toContain('  "instance": { "vcpu": 2, "memoryMib": 6144, "diskMb": 20000 },\n');
    expect(text).toContain("// Orb size.");
    expect(first.cap.lines.join("\n")).toContain("scaffold: instance set to 2 vCPU, 6 GiB, 20 GB disk");
    const wr = await readFile(first.ctx.paths.wrangler, "utf8");
    expect(wr).toContain('\\"vcpu\\":2,\\"memoryMib\\":6144');

    const again = setup(["--non-interactive"], {}, 1);
    const o2 = initOptions(again.ctx);
    await runInit(again.ctx, o2, plan(o2, { ...(await gatherProbes(again.ctx)), tty: false }));
    expect(parseConfigText(await readFile(again.ctx.paths.config, "utf8")).instance).toEqual({
      vcpu: 2,
      memoryMib: 6144,
      diskMb: 20000,
    });
    expect(again.cap.lines.join("\n")).not.toContain("instance set to");

    const third = setup(["--non-interactive", "--vcpu=3"], {}, 1);
    const o3 = initOptions(third.ctx);
    await runInit(third.ctx, o3, plan(o3, { ...(await gatherProbes(third.ctx)), tty: false }));
    expect(parseConfigText(await readFile(third.ctx.paths.config, "utf8")).instance).toEqual({
      vcpu: 3,
      memoryMib: 9216,
      diskMb: 20000,
    });
  });

  it("--vcpu takes only 1, 2, 3 or 4", () => {
    expect([1, 2, 3, 4].map((n) => parseVcpuFlag(String(n)))).toEqual([1, 2, 3, 4]);
    expect(parseVcpuFlag(undefined)).toBeUndefined();
    for (const bad of ["0", "5", "2.5", "two", "", "04"])
      expect(() => parseVcpuFlag(bad)).toThrow(
        /^Failed: --vcpu must be 1, 2, 3 or 4, got .* — fix: pass --vcpu 4/,
      );
    const { ctx } = setup(["--non-interactive", "--vcpu", "8"], {});
    expect(() => initOptions(ctx)).toThrow(/--vcpu must be 1, 2, 3 or 4, got "8"/);
  });

  it("switching cloudflare → external removes the Amp token secret from the Worker", async () => {
    const first = setup(["--non-interactive"], { AMP_ORB_PROVIDER_TOKEN: "aop_live_x1234567" }, 1);
    const o1 = initOptions(first.ctx);
    await runInit(first.ctx, o1, plan(o1, { ...(await gatherProbes(first.ctx)), tty: false }));
    expect(first.secretDeletes).toEqual([]);
    const second = setup(["--provider", "external", "--non-interactive"], {});
    const o2 = initOptions(second.ctx);
    await runInit(second.ctx, o2, plan(o2, { ...(await gatherProbes(second.ctx)), tty: false }));
    expect(second.secretDeletes).toHaveLength(1);
    expect(second.secretDeletes[0]).toMatch(/secret delete AMP_ORB_PROVIDER_TOKEN .*--config/);
  });

  it("switching external → cloudflare without a token fails at plan time with a clear fix", async () => {
    const first = setup(["--provider", "external", "--non-interactive"], {});
    const o1 = initOptions(first.ctx);
    await runInit(first.ctx, o1, plan(o1, { ...(await gatherProbes(first.ctx)), tty: false }));
    const second = setup(["--provider", "cloudflare", "--non-interactive"], {});
    const o2 = initOptions(second.ctx);
    await expect(
      runInit(second.ctx, o2, plan(o2, { ...(await gatherProbes(second.ctx)), tty: false })),
    ).rejects.toThrow(
      "Failed: no Amp provider token (the Worker has none after external mode) — fix: set AMP_ORB_PROVIDER_TOKEN or pass --token-file <file>",
    );
    expect(second.deploySecrets).toHaveLength(0);
    // with a token it works and sends the secret again
    const third = setup(
      ["--provider", "cloudflare", "--non-interactive"],
      { AMP_ORB_PROVIDER_TOKEN: "aop_live_x1234567" },
      1,
    );
    const o3 = initOptions(third.ctx);
    await runInit(third.ctx, o3, plan(o3, { ...(await gatherProbes(third.ctx)), tty: false }));
    expect(third.deploySecrets[0]?.AMP_ORB_PROVIDER_TOKEN).toBe("aop_live_x1234567");
  });

  it("cf-orbs deploy starts prewarm after the deploy and reports it; prewarm 0 skips it", async () => {
    const first = setup(["--non-interactive"], { AMP_ORB_PROVIDER_TOKEN: "aop_live_x1234567" }, 1);
    const o = initOptions(first.ctx);
    await runInit(first.ctx, o, plan(o, { ...(await gatherProbes(first.ctx)), tty: false }));
    const { deployCommand } = await import("../src/commands/deploy");
    const d = setup([], {});
    const results: unknown[] = [];
    d.ctx.ui.result = (v) => results.push(v);
    expect(await deployCommand(d.ctx)).toBe(0);
    expect(d.calls).toEqual(["POST /v1/provider/restart", "POST /v1/warm"]);
    expect(d.cap.lines).toContain("prewarm: started 2 instances in the background; check cf-orbs status");
    expect(results[0]).toMatchObject({ ok: true, prewarm: { started: 2 } });

    const cfg = await readFile(d.ctx.paths.config, "utf8");
    await writeFile(d.ctx.paths.config, cfg.replace(/"prewarm": 2/, '"prewarm": 0'));
    const off = setup([], {});
    await deployCommand(off.ctx);
    expect(off.calls).toEqual(["POST /v1/provider/restart"]);
    expect(off.cap.lines.join("\n")).not.toContain("prewarm");
  });

  describe("cf-orbs deploy restarts the provider only for a new image", () => {
    const buildIn = async (file: string) =>
      /"CF_ORBS_PROVIDER_BUILD": "([0-9a-f]{16})"/.exec(await readFile(file, "utf8"))?.[1] as string;
    /** init, then deploy with a fake control plane. extra gets the provider build init wrote. */
    async function deployWith(extra: (build: string) => Parameters<typeof setup>[4]) {
      const first = setup(["--non-interactive"], { AMP_ORB_PROVIDER_TOKEN: "aop_live_x1234567" }, 1);
      const o = initOptions(first.ctx);
      await runInit(first.ctx, o, plan(o, { ...(await gatherProbes(first.ctx)), tty: false }));
      const build = await buildIn(first.ctx.paths.wrangler);
      const { deployCommand } = await import("../src/commands/deploy");
      const d = setup([], {}, 1, true, extra(build));
      const results: unknown[] = [];
      d.ctx.ui.result = (v) => results.push(v);
      expect(await deployCommand(d.ctx)).toBe(0);
      expect(await buildIn(d.ctx.paths.wrangler)).toBe(build);
      return { d, results, build, lines: d.cap.lines.filter((l) => l.startsWith("provider")) };
    }

    it("image changed: prints restarted for the new image", async () => {
      const { lines, results } = await deployWith(() => ({
        restart: { action: "restart", reason: "provider image changed (build a -> b)", restarted: true },
      }));
      expect(lines).toEqual(["provider: restarted for the new image"]);
      expect(results[0]).toMatchObject({ provider: { action: "restart", restarted: true } });
    });

    it("image unchanged: prints image unchanged; wrangler.jsonc carries the provider build", async () => {
      const { lines, build } = await deployWith(() => ({}));
      expect(lines).toEqual(["provider: image unchanged"]);
      expect(build).toMatch(/^[0-9a-f]{16}$/);
    });

    it("a failed restart check is one warning; the deploy still succeeds", async () => {
      const { d, lines } = await deployWith(() => ({
        restart: { status: 500, error: "Failed: x — fix: y" },
      }));
      expect(lines).toEqual([]);
      expect(d.cap.lines).toContain(
        "Failed: provider restart check did not run (x) — fix: run cf-orbs status; the 5-min check restarts the provider for a new image",
      );
    });

    it("provider DO on old code: waits for it to unload, then starts it on the new code", async () => {
      const { d, lines, results } = await deployWith((build) => ({
        restart: { action: "stopped-old-code", reason: "old", restarted: false },
        // 1st check: still the old DO (no deployedBuild). 2nd: new code, not running yet.
        providerStatus: (n) => (n <= 1 ? { running: false } : { running: false, deployedBuild: build }),
      }));
      expect(lines).toEqual([
        "provider: its Durable Object ran old code, so it was stopped; waiting for it to load the new code (up to 8 min)",
        "provider: restarted for the new image",
      ]);
      expect(d.calls).toEqual([
        "POST /v1/provider/restart",
        "GET /v1/status",
        "GET /v1/status",
        "POST /v1/provider/start",
        "POST /v1/warm",
      ]);
      expect(results[0]).toMatchObject({ provider: { action: "restart", restarted: true } });
    });

    it("provider DO on old code that never unloads: leaves it to the cron", async () => {
      const { lines, results } = await deployWith(() => ({
        restart: { action: "stopped-old-code", reason: "old", restarted: false },
        providerStatus: () => ({ running: false }),
      }));
      expect(lines.at(-1)).toBe(
        "provider: stopped; the 5-min check starts it with the new image once its Durable Object unloads; check cf-orbs status",
      );
      expect(results[0]).toMatchObject({ provider: { action: "stopped-old-code", restarted: false } });
    });
  });

  it("cf-orbs deploy: a failed prewarm is one warning; the deploy still succeeds", async () => {
    const first = setup(["--non-interactive"], { AMP_ORB_PROVIDER_TOKEN: "aop_live_x1234567" }, 1);
    const o = initOptions(first.ctx);
    await runInit(first.ctx, o, plan(o, { ...(await gatherProbes(first.ctx)), tty: false }));
    const { deployCommand } = await import("../src/commands/deploy");
    const d = setup([], {}, 1, true, { warm: "fail" });
    expect(await deployCommand(d.ctx)).toBe(0);
    const warn = d.cap.lines.filter((l) => l.includes("prewarm"));
    expect(warn).toEqual([
      'Failed: prewarm did not start (internal error: DO overloaded) — fix: run cf-orbs deploy again to retry, or set "prewarm": 0 in cf-orbs.config.jsonc',
    ]);
  });

  it("cf-orbs deploy in external mode deletes the Amp token secret (README step 1)", async () => {
    const first = setup(["--provider", "external", "--non-interactive"], {});
    const o1 = initOptions(first.ctx);
    await runInit(first.ctx, o1, plan(o1, { ...(await gatherProbes(first.ctx)), tty: false }));
    expect(first.secretDeletes).toHaveLength(1);
    const d = setup([], {});
    const { deployCommand } = await import("../src/commands/deploy");
    await deployCommand(d.ctx);
    expect(d.secretDeletes).toEqual([expect.stringMatching(/secret delete AMP_ORB_PROVIDER_TOKEN/)]);
  });

  it("doctor: cloudflare mode with no token secret → FAIL with the init fix", async () => {
    const first = setup(["--non-interactive"], { AMP_ORB_PROVIDER_TOKEN: "aop_live_x1234567" }, 1);
    const o = initOptions(first.ctx);
    await runInit(first.ctx, o, plan(o, { ...(await gatherProbes(first.ctx)), tty: false }));
    const d = setup([], {}, Number.POSITIVE_INFINITY, true, { secretList: ["CONTROL_TOKEN"] });
    const checks = await runDoctor(d.ctx);
    const p = checks.find((c) => c.name === "provider");
    expect(p?.status).toBe("FAIL");
    expect(p?.detail).toMatch(/no AMP_ORB_PROVIDER_TOKEN secret/);
  });

  it("doctor: wrangler logged out → deployment FAIL says log in, not redeploy", async () => {
    const d = setup([], {});
    const orig = d.ctx.run;
    d.ctx.run = async (cmd, args, o) =>
      args.includes("deployments")
        ? { code: 1, stdout: "", stderr: "✘ [ERROR] You are not authenticated. Please run `wrangler login`." }
        : orig(cmd, args, o);
    const checks = await runDoctor(d.ctx);
    expect(checks.find((c) => c.name === "deployment")?.detail).toMatch(/— fix: run npx wrangler login$/);
  });

  it("doctor after init: all checks pass and nothing is started", async () => {
    const first = setup(["--non-interactive"], { AMP_ORB_PROVIDER_TOKEN: "aop_live_x1234567" }, 1);
    const o = initOptions(first.ctx);
    await runInit(first.ctx, o, plan(o, { ...(await gatherProbes(first.ctx)), tty: false }));
    const d = setup([], {}, 1, true, { worker: "found" });
    const checks = await runDoctor(d.ctx);
    expect(checks.map((c) => `${c.status} ${c.name}`)).toEqual([
      "PASS config",
      "PASS control token",
      "PASS orb image pin",
      "PASS provider image pin",
      "PASS debugExec",
      "SKIP secrets in git",
      "PASS deployment",
      "PASS health",
      "PASS status",
      "PASS provider",
      "PASS image keys",
      "INFO Amp snapshot cache",
    ]);
    expect(d.calls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  // --- adopt guard ---
  const ENV = { AMP_ORB_PROVIDER_TOKEN: "aop_live_testtoken123" };
  const STOP =
    "Failed: Worker cf-orbs already exists in this account and this folder did not create it — fix: run init in the folder that made it, restore that folder (see Back up and restore), pass --name <new> for a second install, or pass --adopt to take it over";
  const ADOPT =
    "adopt: taking over Worker cf-orbs; a new control token replaces the old one (the folder that made it loses CLI access); this folder's config and image/ are deployed";

  function make(argv: string[], extra: Parameters<typeof setup>[4] = {}) {
    return setup(argv, ENV, 2, true, extra);
  }
  async function go(s: ReturnType<typeof make>) {
    const o = initOptions(s.ctx);
    const probes = { ...(await gatherProbes(s.ctx, o)), tty: false };
    return runInit(s.ctx, o, plan(o, probes));
  }
  const lookups = (s: ReturnType<typeof make>) =>
    s.wranglerCalls.filter((c) => c.includes(" deployments list "));

  it("new folder, Worker not found: checks with --json --name, then deploys as before", async () => {
    const s = make(["--non-interactive"]);
    await go(s);
    expect(lookups(s)).toHaveLength(1);
    expect(lookups(s)[0]).toMatch(/^acct1 .* deployments list --json --name cf-orbs$/);
    expect(s.deploySecrets).toHaveLength(1);
    expect(s.cap.lines.join("\n")).not.toMatch(/adopt|existing-Worker/);
  });

  it("new folder, Worker found: stops with one line before any deploy, secret or token write", async () => {
    const s = make(["--non-interactive"], { worker: "found" });
    await expect(go(s)).rejects.toThrow(STOP);
    expect(s.deploySecrets).toHaveLength(0);
    expect(s.secretDeletes).toEqual([]);
    expect(s.calls).toEqual([]);
    expect(existsSync(s.ctx.paths.controlToken)).toBe(false);
    expect((await readState(s.ctx.paths)).url).toBeUndefined();
  });

  it("the check uses the account id and the --name Worker name", async () => {
    const s = make(["--non-interactive", "--name", "second"], { worker: "found" });
    await expect(go(s)).rejects.toThrow(/^Failed: Worker second already exists/);
    expect(lookups(s)).toHaveLength(1);
    expect(lookups(s)[0]).toMatch(/^acct1 .* deployments list --json --name second$/);
  });

  it("new folder, found, --adopt: one warning, then deploys with a new control token", async () => {
    const s = make(["--non-interactive", "--adopt"], { worker: "found" });
    await go(s);
    expect(s.cap.lines.filter((l) => l.startsWith("adopt:"))).toEqual([ADOPT]);
    expect(s.deploySecrets).toHaveLength(1);
    expect(s.deploySecrets[0]?.CONTROL_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  });

  it("--adopt with no existing Worker: no warning, deploys", async () => {
    const s = make(["--non-interactive", "--adopt"]);
    await go(s);
    expect(s.cap.lines.join("\n")).not.toContain("adopt:");
    expect(s.deploySecrets).toHaveLength(1);
  });

  it("check fails for another reason: one warning and init goes on", async () => {
    const s = make(["--non-interactive"], { worker: "error" });
    await go(s);
    const w = s.cap.lines.filter((l) => l.startsWith("existing-Worker check could not run"));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("network unreachable");
    expect(s.deploySecrets).toHaveLength(1);
  });

  it("same folder re-run: no check, no stop", async () => {
    const first = make(["--non-interactive"]);
    await go(first);
    // the Worker exists now, but this folder made it (state.json has the URL)
    const again = make(["--non-interactive"], { worker: "found" });
    await go(again);
    expect(lookups(again)).toEqual([]);
    expect(again.deploySecrets).toHaveLength(1);
  });

  it("external mode: found stops, --adopt goes on", async () => {
    const s = make(["--non-interactive", "--provider", "external"], { worker: "found" });
    await expect(go(s)).rejects.toThrow(STOP);
    expect(s.deploySecrets).toHaveLength(0);
    const a = make(["--non-interactive", "--provider", "external", "--adopt"], { worker: "found" });
    await go(a);
    expect(a.deploySecrets).toHaveLength(1);
  });

  it("the plan has the step only for a folder with no saved deployment, between scaffold and control-token", async () => {
    const s = make(["--non-interactive", "--adopt"]);
    const o = initOptions(s.ctx);
    const base = { ...(await gatherProbes(s.ctx, o)), tty: false };
    const kinds = plan(o, base).map((x) => x.kind);
    expect(kinds.slice(1, 5)).toEqual(["plan-check", "scaffold", "adopt-check", "control-token"]);
    expect(plan(o, base).find((x) => x.kind === "adopt-check")).toEqual({ kind: "adopt-check", adopt: true });
    const saved = plan(o, { ...base, deployed: true, prevMode: "cloudflare", hasControlToken: true });
    expect(saved.map((x) => x.kind)).not.toContain("adopt-check");
    // a folder with a control token but no saved URL (a run that failed after the deploy, or a restored backup)
    const tokenOnly = plan(o, { ...base, deployed: false, hasControlToken: true });
    expect(tokenOnly.map((x) => x.kind)).not.toContain("adopt-check");
  });
});
