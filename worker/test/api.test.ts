import { describe, expect, it, vi } from "vitest";
import { handleApi, parseOpRequest, splitOpId, timingSafeEqualStr } from "../src/api";
import { DEFAULT_CONFIG, type OpRecord, type OpRequest, type RegistryClient } from "../src/core/types";
import type { Env } from "../src/env";
import type { OrbContext } from "../src/orb/context";
import { appendProgress, recoverInflight } from "../src/orb/journal";
import { newRuntime, OpNotifier, type OpRunners, runOpWithJournal, waitForOp } from "../src/orb/session";
import { FakeClock, FakeContainer, MemoryKV } from "./fake-container";

// session.ts extends DurableObject; node has no cloudflare:workers.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));

type Call = { name: string; method: string; args: unknown[] };

function fakeEnv(over: Partial<Env> = {}, behave: Record<string, (...a: unknown[]) => unknown> = {}) {
  const calls: Call[] = [];
  const ns = (label: string) =>
    ({
      getByName(name: string) {
        return new Proxy(
          {},
          {
            get(_t, method: string) {
              return async (...args: unknown[]) => {
                calls.push({ name: `${label}/${name}`, method, args });
                const f = behave[`${label}.${method}`];
                if (f) return f(...args);
                return { method, ok: true };
              };
            },
          },
        );
      },
    }) as unknown as DurableObjectNamespace;
  const env: Env = {
    ORB: ns("ORB"),
    REGISTRY: ns("REGISTRY"),
    PROVIDER: ns("PROVIDER"),
    CF_ORBS_CONFIG: "{}",
    CONTROL_TOKEN: "s3cret-control",
    ...over,
  };
  return { env, calls };
}

const auth = { authorization: "Bearer s3cret-control" };
const req = (path: string, init: RequestInit = {}) => new Request(`https://cf-orbs.example${path}`, init);
const body = async (r: Response) => (await r.json()) as Record<string, any>;

describe("auth", () => {
  it("public routes are 404 when CONTROL_TOKEN is unset, even with Bearer undefined", async () => {
    const { env, calls } = fakeEnv({ CONTROL_TOKEN: undefined });
    for (const h of [{}, { authorization: "Bearer undefined" }, { authorization: "Bearer " }] as Record<
      string,
      string
    >[]) {
      const r = await handleApi(req("/v1/health", { headers: h }), env, { internal: false });
      expect(r.status).toBe(404);
    }
    const r = await handleApi(
      req("/v1/orbs/amp-T-1/ops", {
        method: "POST",
        headers: { authorization: "Bearer undefined" },
        body: "{}",
      }),
      env,
      { internal: false },
    );
    expect(r.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("empty CONTROL_TOKEN counts as unset", async () => {
    const { env } = fakeEnv({ CONTROL_TOKEN: "" });
    const r = await handleApi(req("/v1/health", { headers: { authorization: "Bearer " } }), env, {
      internal: false,
    });
    expect(r.status).toBe(404);
  });

  it("401 without bearer or with a wrong one", async () => {
    const { env, calls } = fakeEnv();
    for (const h of [
      {},
      { authorization: "Bearer nope" },
      { authorization: "s3cret-control" },
      { authorization: "Basic s3cret-control" },
    ] as Record<string, string>[]) {
      const r = await handleApi(req("/v1/orbs/amp-T-1", { headers: h }), env, { internal: false });
      expect(r.status).toBe(401);
      expect((await body(r)).error).toMatch(/^Failed: .+ — fix: /);
    }
    expect(calls).toEqual([]);
  });

  it("200 with the right bearer", async () => {
    const { env } = fakeEnv();
    const r = await handleApi(req("/v1/health", { headers: auth }), env, { internal: false });
    expect(r.status).toBe(200);
    expect(await body(r)).toMatchObject({ ok: true, name: "cf-orbs" });
  });

  it("internal calls skip auth, even when CONTROL_TOKEN is unset", async () => {
    const { env } = fakeEnv({ CONTROL_TOKEN: undefined });
    const r = await handleApi(req("/v1/health"), env, { internal: true });
    expect(r.status).toBe(200);
  });

  it("timingSafeEqualStr", async () => {
    expect(await timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(await timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(await timingSafeEqualStr("abc", "abcd")).toBe(false);
    expect(await timingSafeEqualStr("", "")).toBe(true);
  });
});

describe("ops", () => {
  it("POST op routes to orb:<id> with a clean body", async () => {
    const { env, calls } = fakeEnv({}, { "ORB.submitOp": () => ({ opId: "amp-T-1:u-1", attached: false }) });
    const r = await handleApi(
      req("/v1/orbs/amp-T-1/ops", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          op: "spawn",
          token: "tok",
          snapshotId: 'a"b\\c',
          image: null,
          ampUrl: "",
          extra: 1,
        }),
      }),
      env,
      { internal: false },
    );
    expect(r.status).toBe(200);
    expect(await body(r)).toEqual({ opId: "amp-T-1:u-1", attached: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "ORB/orb:amp-T-1", method: "submitOp" });
    expect(calls[0]?.args[0]).toEqual({ op: "spawn", token: "tok", snapshotId: 'a"b\\c' });
  });

  it("rejects unknown op, spawn without token, bad JSON, non-object, wrong types", async () => {
    const { env, calls } = fakeEnv();
    const cases: Array<[string, RegExp]> = [
      [JSON.stringify({ op: "reset" }), /unknown op reset/],
      [JSON.stringify({ op: "spawn" }), /spawn needs ORB_TOKEN/],
      ["{not json", /not valid JSON/],
      ["[1]", /JSON object/],
      [JSON.stringify({ op: "pause", snapshotId: 5 }), /snapshotId must be a string/],
    ];
    for (const [b, re] of cases) {
      const r = await handleApi(
        req("/v1/orbs/amp-T-1/ops", { method: "POST", headers: auth, body: b }),
        env,
        {
          internal: false,
        },
      );
      expect(r.status).toBe(400);
      const e = (await body(r)).error as string;
      expect(e).toMatch(re);
      expect(e).toMatch(/^Failed: .+ — fix: .+/);
      expect(e).not.toContain("\n");
    }
    expect(calls).toEqual([]);
  });

  it("GET op routes by the orb id inside the op id and clamps wait", async () => {
    const rec = { opId: "amp-T-1:0b6e", phase: "running", progress: [] } as unknown as OpRecord;
    const { env, calls } = fakeEnv({}, { "ORB.getOp": () => rec });
    const waits: Array<[string, number]> = [
      ["?wait=20", 20_000],
      ["?wait=999", 25_000],
      ["?wait=-5", 0],
      ["?wait=abc", 0],
      ["", 0],
      ["?wait=0.5", 500],
    ];
    for (const [q, ms] of waits) {
      const r = await handleApi(req(`/v1/ops/amp-T-1:0b6e${q}`, { headers: auth }), env, { internal: false });
      expect(r.status).toBe(200);
      expect(calls.at(-1)).toMatchObject({ name: "ORB/orb:amp-T-1", method: "getOp" });
      expect(calls.at(-1)?.args.slice(0, 2)).toEqual(["amp-T-1:0b6e", ms]);
    }
    await handleApi(req("/v1/ops/amp-T-1%3A0b6e?wait=1&since=3", { headers: auth }), env, {
      internal: false,
    });
    expect(calls.at(-1)?.args).toEqual(["amp-T-1:0b6e", 1000, 3]);
  });

  it("unknown op → 404; malformed op id → 400 without calling a DO", async () => {
    const { env, calls } = fakeEnv({}, { "ORB.getOp": () => null });
    const r = await handleApi(req("/v1/ops/amp-T-1:nope", { headers: auth }), env, { internal: false });
    expect(r.status).toBe(404);
    expect(calls).toHaveLength(1);
    for (const id of ["nocolon", ":x", "__registry:x", "a:b:c", "a:"]) {
      const r2 = await handleApi(req(`/v1/ops/${encodeURIComponent(id)}`, { headers: auth }), env, {
        internal: false,
      });
      expect(r2.status).toBe(400);
    }
    expect(calls).toHaveLength(1);
  });
});

describe("orb id validation", () => {
  it("rejects bad ids with fix text and never reaches a DO", async () => {
    const { env, calls } = fakeEnv();
    for (const id of ["__registry", "a%2Fb", "x".repeat(129), ".hidden", "-x", "a%3Ab", "a b", "%E0%A4%A"]) {
      const r = await handleApi(req(`/v1/orbs/${id}`, { headers: auth }), env, { internal: false });
      expect(r.status, id).toBe(400);
      expect((await body(r)).error).toMatch(/^Failed: invalid orb id .* — fix: check ORB_ID/);
    }
    expect(calls).toEqual([]);
  });

  it("accepts Amp-shaped ids up to 128 chars", async () => {
    const { env, calls } = fakeEnv();
    for (const id of ["amp-T-019a2b3c-4d5e-7f00-8abc-def012345678", "x".repeat(128), "A_b-9"]) {
      const r = await handleApi(req(`/v1/orbs/${id}`, { headers: auth }), env, { internal: false });
      expect(r.status).toBe(200);
      expect(calls.at(-1)).toMatchObject({ name: `ORB/orb:${id}`, method: "status" });
    }
  });

  it("a/b as a path is not an orb route", async () => {
    const { env, calls } = fakeEnv();
    const r = await handleApi(req("/v1/orbs/a/b", { headers: auth }), env, { internal: false });
    expect(r.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe("other routes", () => {
  it("logs clamps lines", async () => {
    const { env, calls } = fakeEnv();
    for (const [q, n] of [
      ["", 100],
      ["?lines=5", 5],
      ["?lines=0", 1],
      ["?lines=99999", 1000],
      ["?lines=x", 100],
    ] as const) {
      const r = await handleApi(req(`/v1/orbs/amp-T-1/logs${q}`, { headers: auth }), env, {
        internal: false,
      });
      expect(r.status).toBe(200);
      expect(calls.at(-1)).toMatchObject({ name: "ORB/orb:amp-T-1", method: "logs", args: [n] });
    }
  });

  it("status merges registry and provider; a failing provider does not fail the route", async () => {
    const { env, calls } = fakeEnv(
      {},
      {
        "REGISTRY.status": () => ({ running: ["a"], max: 20 }),
        "PROVIDER.status": () => {
          throw new Error("boom\n    at secret.ts:1");
        },
      },
    );
    const r = await handleApi(req("/v1/status", { headers: auth }), env, { internal: false });
    expect(r.status).toBe(200);
    const b = await body(r);
    expect(b.registry).toEqual({ running: ["a"], max: 20 });
    expect(b.provider.error).toMatch(/^Failed: status not available: boom — fix: /);
    expect(JSON.stringify(b)).not.toContain("secret.ts");
    expect(calls.map((c) => c.name).sort()).toEqual([
      "PROVIDER/provider",
      "REGISTRY/registry",
      "REGISTRY/registry",
    ]);
  });

  it("POST /v1/provider/start calls ProviderHost.ensureRunning", async () => {
    const { env, calls } = fakeEnv(
      { AMP_ORB_PROVIDER_TOKEN: "aop_live_x" },
      { "PROVIDER.ensureRunning": () => ({ running: true, restarts: 0 }) },
    );
    const r = await handleApi(req("/v1/provider/start", { method: "POST", headers: auth }), env, {
      internal: false,
    });
    expect(r.status).toBe(200);
    expect((await body(r)).running).toBe(true);
    expect(calls.map((c) => `${c.name}.${c.method}`)).toEqual(["PROVIDER/provider.ensureRunning"]);
    const g = await handleApi(req("/v1/provider/start", { headers: auth }), env, { internal: false });
    expect(g.status).toBe(405);
  });

  it("POST /v1/provider/restart?ifImageChanged=1 sends the deploy's provider build to ProviderHost.restart", async () => {
    const { env, calls } = fakeEnv(
      { AMP_ORB_PROVIDER_TOKEN: "aop_live_x", CF_ORBS_PROVIDER_BUILD: "b2" },
      {
        "PROVIDER.restart": () => ({
          action: "restart",
          reason: "provider image changed (build b1 -> b2)",
          restarted: true,
          running: true,
        }),
      },
    );
    const r = await handleApi(
      req("/v1/provider/restart?ifImageChanged=1", { method: "POST", headers: auth }),
      env,
      { internal: false },
    );
    expect(r.status).toBe(200);
    expect(await body(r)).toMatchObject({ action: "restart", restarted: true });
    expect(calls).toEqual([
      { name: "PROVIDER/provider", method: "restart", args: [{ ifImageChanged: true, build: "b2" }] },
    ]);
    // without the flag: a forced restart
    await handleApi(req("/v1/provider/restart", { method: "POST", headers: auth }), env, { internal: false });
    expect(calls.at(-1)?.args).toEqual([{ ifImageChanged: false, build: "b2" }]);
    const g = await handleApi(req("/v1/provider/restart", { headers: auth }), env, { internal: false });
    expect(g.status).toBe(405);
  });

  it("POST /v1/provider/restart: 409 in external mode, 401 without the bearer, 404 from the provider (internal)", async () => {
    const ext = fakeEnv({ AMP_ORB_PROVIDER_TOKEN: undefined });
    const r = await handleApi(req("/v1/provider/restart", { method: "POST", headers: auth }), ext.env, {
      internal: false,
    });
    expect(r.status).toBe(409);
    expect((await body(r)).error).toMatch(/^Failed: .+ — fix: /);
    const { env, calls } = fakeEnv({ AMP_ORB_PROVIDER_TOKEN: "aop_live_x" });
    const noAuth = await handleApi(req("/v1/provider/restart", { method: "POST" }), env, { internal: false });
    expect(noAuth.status).toBe(401);
    const internal = await handleApi(req("/v1/provider/restart", { method: "POST" }), env, {
      internal: true,
    });
    expect(internal.status).toBe(404);
    expect(calls).toEqual([]);
    expect(ext.calls).toEqual([]);
  });

  it("POST /v1/provider/restart on a provider DO with old code stops it and says so", async () => {
    const { env, calls } = fakeEnv(
      { AMP_ORB_PROVIDER_TOKEN: "aop_live_x", CF_ORBS_PROVIDER_BUILD: "b2" },
      {
        "PROVIDER.restart": () => {
          throw new TypeError('The RPC receiver does not implement the method "restart".');
        },
      },
    );
    const r = await handleApi(
      req("/v1/provider/restart?ifImageChanged=1", { method: "POST", headers: auth }),
      env,
      { internal: false },
    );
    expect(r.status).toBe(200);
    expect(await body(r)).toMatchObject({ action: "stopped-old-code", restarted: false, stopped: true });
    expect(calls.map((c) => c.method)).toEqual(["restart", "stop"]);
  });

  it("POST /v1/provider/start is 409 in external mode", async () => {
    const { env, calls } = fakeEnv({ AMP_ORB_PROVIDER_TOKEN: undefined });
    const r = await handleApi(req("/v1/provider/start", { method: "POST", headers: auth }), env, {
      internal: false,
    });
    expect(r.status).toBe(409);
    expect((await body(r)).error).toMatch(/^Failed: .+ — fix: /);
    expect(calls).toEqual([]);
  });

  it("DO errors become one-line 500s without stack or tokens", async () => {
    const { env } = fakeEnv(
      {},
      {
        "ORB.status": () => {
          const e = new Error("exploded with aop_live_abcdef123456\nsecond line");
          e.stack = "Error: exploded\n    at OrbSession.status (session.ts:10:5)";
          throw e;
        },
      },
    );
    const r = await handleApi(req("/v1/orbs/amp-T-1", { headers: auth }), env, { internal: false });
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(text).not.toContain("session.ts");
    expect(text).not.toContain("abcdef123456");
    expect(text).not.toContain("second line");
    expect(JSON.parse(text).error).toMatch(
      /^Failed: internal error: exploded with aop_live_<redacted> — fix: /,
    );
  });

  it("wrong method → 405, unknown path → 404", async () => {
    const { env } = fakeEnv();
    expect(
      (await handleApi(req("/v1/orbs/amp-T-1/ops", { headers: auth }), env, { internal: false })).status,
    ).toBe(405);
    expect(
      (await handleApi(req("/v1/health", { method: "POST", headers: auth }), env, { internal: false }))
        .status,
    ).toBe(405);
    expect((await handleApi(req("/v2/health", { headers: auth }), env, { internal: false })).status).toBe(
      404,
    );
    expect((await handleApi(req("/", { headers: auth }), env, { internal: false })).status).toBe(404);
  });

  it("oversized body → 400", async () => {
    const { env, calls } = fakeEnv();
    const big = JSON.stringify({ op: "spawn", token: "t", image: "x".repeat(70_000) });
    const r = await handleApi(
      req("/v1/orbs/amp-T-1/ops", { method: "POST", headers: auth, body: big }),
      env,
      {
        internal: false,
      },
    );
    expect(r.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("debug routes (exec, bench)", () => {
  const on = JSON.stringify({ debugExec: true });
  const post = (path: string, b: unknown) =>
    req(path, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(b),
    });

  it("are 404 and never reach the DO when debugExec is false, missing or the config is bad", async () => {
    for (const cfg of ["{}", JSON.stringify({ debugExec: false }), "not json"]) {
      const { env, calls } = fakeEnv({ CF_ORBS_CONFIG: cfg });
      const b = await handleApi(
        post("/v1/orbs/bench-r1-1/bench", { action: "start", source: "image" }),
        env,
        {
          internal: false,
        },
      );
      expect(b.status).toBe(404);
      expect((await body(b)).error).toMatch(
        /^Failed: bench is disabled .*debugExec is false.* — fix: set "debugExec": true/,
      );
      const e = await handleApi(post("/v1/orbs/amp-T-1/exec", { cmd: ["true"] }), env, { internal: false });
      expect(e.status).toBe(404);
      expect((await body(e)).error).toMatch(/^Failed: exec is disabled/);
      expect(calls).toEqual([]);
    }
  });

  it("still need the bearer token", async () => {
    const { env, calls } = fakeEnv({ CF_ORBS_CONFIG: on });
    const r = await handleApi(
      req("/v1/orbs/bench-r1-1/bench", { method: "POST", body: JSON.stringify({ action: "destroy" }) }),
      env,
      { internal: false },
    );
    expect(r.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("bench maps actions to DO RPCs when debugExec is true", async () => {
    const { env, calls } = fakeEnv(
      { CF_ORBS_CONFIG: on },
      { "ORB.benchStart": () => ({ ready: true, readyMs: 812, doColo: "YYZ" }) },
    );
    const s = await handleApi(
      post("/v1/orbs/bench-r1-1/bench", {
        action: "start",
        source: { snapshotId: "snap-1" },
        instance: "standard-4",
      }),
      env,
      { internal: false },
    );
    expect(s.status).toBe(200);
    expect(await body(s)).toMatchObject({ ready: true, readyMs: 812, doColo: "YYZ" });
    await handleApi(post("/v1/orbs/bench-r1-1/bench", { action: "snapshot", name: "n1" }), env, {
      internal: false,
    });
    await handleApi(post("/v1/orbs/bench-r1-1/bench", { action: "destroy" }), env, { internal: false });
    expect(calls.map((c) => [c.name, c.method, c.args])).toEqual([
      ["ORB/orb:bench-r1-1", "benchStart", [{ source: { snapshotId: "snap-1" }, instance: "standard-4" }]],
      ["ORB/orb:bench-r1-1", "benchSnapshot", ["n1"]],
      ["ORB/orb:bench-r1-1", "benchDestroy", []],
    ]);
  });

  it("bench refuses non-bench orbs, bad bodies and GET", async () => {
    const { env, calls } = fakeEnv({ CF_ORBS_CONFIG: on });
    const amp = await handleApi(post("/v1/orbs/amp-T-1/bench", { action: "destroy" }), env, {
      internal: false,
    });
    expect(amp.status).toBe(400);
    expect((await body(amp)).error).toMatch(/^Failed: bench needs an orb id that starts with bench-/);
    for (const b of [{ action: "start", source: "disk" }, { action: "boom" }, [1]]) {
      const r = await handleApi(post("/v1/orbs/bench-r1-1/bench", b), env, { internal: false });
      expect(r.status).toBe(400);
      expect((await body(r)).error).toMatch(/^Failed: .+ — fix: /);
    }
    const g = await handleApi(req("/v1/orbs/bench-r1-1/bench", { headers: auth }), env, { internal: false });
    expect(g.status).toBe(405);
    expect(calls).toEqual([]);
  });

  it("exec reaches the DO when debugExec is true", async () => {
    const { env, calls } = fakeEnv({ CF_ORBS_CONFIG: on });
    const r = await handleApi(post("/v1/orbs/amp-T-1/exec", { cmd: ["true"], timeoutMs: 5000 }), env, {
      internal: false,
    });
    expect(r.status).toBe(200);
    expect(calls.map((c) => [c.method, c.args])).toEqual([["exec", [["true"], 5000]]]);
  });
});

describe("helpers", () => {
  it("splitOpId", () => {
    expect(splitOpId("amp-T-1:abc-123")).toEqual({ orbId: "amp-T-1", uuid: "abc-123" });
    expect(splitOpId("amp-T-1")).toBeNull();
    expect(splitOpId("_x:abc")).toBeNull();
  });
  it("parseOpRequest keeps only known fields", () => {
    const r = parseOpRequest({ op: "pause", snapshotId: "snap-1", junk: true }) as OpRequest;
    expect(r).toEqual({ op: "pause", snapshotId: "snap-1" });
  });
});

// ---- OrbSession op lifecycle (runOpWithJournal), no DO needed ----

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup(ops: Partial<OpRunners> = {}) {
  const clock = new FakeClock();
  const kv = new MemoryKV();
  const base = {
    orbId: "amp-T-1",
    container: new FakeContainer(clock),
    kv,
    clock,
    config: structuredClone(DEFAULT_CONFIG),
    registry: {} as RegistryClient,
  };
  const seen: OrbContext[] = [];
  const runners: OpRunners = {
    runSpawn: async (ctx) => {
      seen.push(ctx);
      return { ok: true, source: "image", wakeMs: 1234 };
    },
    runPause: async () => ({ ok: true }),
    runDelete: async () => undefined,
    ...ops,
  };
  const log: string[] = [];
  const rt = newRuntime((l) => log.push(l));
  return { clock, kv, base, runners, rt, seen, log };
}

const TOKEN = "eyJhbGciOi.test.sig-ORBTOKEN-1234567890";

describe("runOpWithJournal", () => {
  it("spawn success: journal, progress, result, deadline, token never stored", async () => {
    const s = setup({
      runSpawn: async (ctx, req) => {
        s.seen.push(ctx);
        ctx.say(`starting from image with token ${req.token}`);
        ctx.say("bootstrap connected");
        return { ok: true, source: "image", wakeMs: 4200 };
      },
    });
    const r = await runOpWithJournal(s.base, s.kv, { op: "spawn", token: TOKEN }, s.runners, s.rt);
    expect(r.attached).toBe(false);
    expect(r.opId).toMatch(/^amp-T-1:[0-9a-f-]{36}$/);
    const rec = await r.done;
    expect(rec?.phase).toBe("succeeded");
    expect(rec?.result).toEqual({ source: "image", wakeMs: 4200 });
    expect(rec?.progress[0]).toMatch(/^0\.0s starting from image with token <redacted>$/);
    expect(rec?.progress.at(-1)).toMatch(/spawn done$/);
    expect(s.seen[0]?.deadline).toBe(Date.parse(rec?.startedAt ?? "") + 4.5 * 60_000);
    expect(await s.kv.get("ops:inflight")).toEqual([]);
    const all = JSON.stringify([...s.kv.map.values()]) + s.log.join("\n");
    expect(all).not.toContain("ORBTOKEN");
    expect(all).not.toContain("eyJhbGciOi");
  });

  it("identical in-flight inputs attach to the same op; the runner runs once", async () => {
    const gate = deferred<void>();
    let calls = 0;
    const s = setup({
      runSpawn: async () => {
        calls++;
        await gate.promise;
        return { ok: true, source: "running", wakeMs: 1 };
      },
    });
    const req = { op: "spawn" as const, token: TOKEN };
    const [a, b] = await Promise.all([
      runOpWithJournal(s.base, s.kv, req, s.runners, s.rt),
      runOpWithJournal(s.base, s.kv, req, s.runners, s.rt),
    ]);
    expect(b.opId).toBe(a.opId);
    expect([a.attached, b.attached].sort()).toEqual([false, true]);
    const c = await runOpWithJournal(s.base, s.kv, { op: "spawn", token: `${TOKEN}-other` }, s.runners, s.rt);
    expect(c.opId).not.toBe(a.opId);
    gate.resolve();
    await a.done;
    await c.done;
    expect(calls).toBe(2);
    // finished op: a replay now starts a new op
    const d = await runOpWithJournal(s.base, s.kv, req, s.runners, s.rt);
    expect(d.attached).toBe(false);
    expect(d.opId).not.toBe(a.opId);
    await d.done;
  });

  it("ops run one at a time in submit order", async () => {
    const order: string[] = [];
    const gate = deferred<void>();
    const s = setup({
      runSpawn: async () => {
        order.push("spawn:start");
        await gate.promise;
        order.push("spawn:end");
        return { ok: true, source: "image", wakeMs: 1 };
      },
      runPause: async () => {
        order.push("pause");
        return { ok: true };
      },
    });
    const a = await runOpWithJournal(s.base, s.kv, { op: "spawn", token: TOKEN }, s.runners, s.rt);
    const b = await runOpWithJournal(s.base, s.kv, { op: "pause" }, s.runners, s.rt);
    await Promise.resolve();
    expect((await s.kv.get<{ phase: string }>(`op:${b.opId}`))?.phase).toBe("queued");
    gate.resolve();
    await Promise.all([a.done, b.done]);
    expect(order).toEqual(["spawn:start", "spawn:end", "pause"]);
  });

  it("failed op: one-line Failed text with fix, token redacted", async () => {
    const s = setup({
      runSpawn: async () => ({ ok: false, error: `bootstrap died\nlast line has ${TOKEN}` }),
    });
    const r = await runOpWithJournal(s.base, s.kv, { op: "spawn", token: TOKEN }, s.runners, s.rt);
    const rec = await r.done;
    expect(rec?.phase).toBe("failed");
    expect(rec?.error).toMatch(
      /^Failed: bootstrap died last line has <redacted> — fix: retry the message; run cf-orbs logs amp-T-1$/,
    );
    expect(JSON.stringify(rec)).not.toContain("ORBTOKEN");
  });

  it("an error that already has fix text is kept", async () => {
    const s = setup({
      runSpawn: async () => ({ ok: false, error: "Failed: orb was deleted at X — fix: start a new thread" }),
    });
    const rec = await (await runOpWithJournal(s.base, s.kv, { op: "spawn", token: TOKEN }, s.runners, s.rt))
      .done;
    expect(rec?.error).toBe("Failed: orb was deleted at X — fix: start a new thread");
  });

  it("a throwing op fails cleanly and the queue keeps going", async () => {
    const s = setup({
      runPause: async () => {
        throw new Error("snapshot exploded\n    at stack.ts:1");
      },
    });
    const a = await runOpWithJournal(s.base, s.kv, { op: "pause" }, s.runners, s.rt);
    const b = await runOpWithJournal(s.base, s.kv, { op: "delete" }, s.runners, s.rt);
    const ra = await a.done;
    const rb = await b.done;
    expect(ra?.phase).toBe("failed");
    expect(ra?.error).toMatch(/^Failed: snapshot exploded at stack\.ts:1 — fix: /);
    expect(rb?.phase).toBe("succeeded");
  });

  it("pause stores the handle as result", async () => {
    const handle = {
      id: "snap-1",
      size: 1,
      imageKey: "orb",
      instance: "standard-1",
      createdAt: "2026-10-30T00:00:00Z",
    };
    const s = setup({ runPause: async () => ({ ok: true, handle }) });
    const rec = await (
      await runOpWithJournal(s.base, s.kv, { op: "pause", snapshotId: "p" }, s.runners, s.rt)
    ).done;
    expect(rec?.result).toEqual({ handle });
  });

  it("after a restart, a replay does not attach to the dead op", async () => {
    const s = setup();
    const gate = deferred<void>();
    s.runners.runPause = async () => {
      await gate.promise;
      return { ok: true };
    };
    const a = await runOpWithJournal(s.base, s.kv, { op: "pause" }, s.runners, s.rt);
    // simulate DO restart: new runtime, recoverInflight
    const failed = await recoverInflight(s.kv, new Date(s.clock.now()).toISOString());
    expect(failed.map((o) => o.opId)).toEqual([a.opId]);
    const b = await runOpWithJournal(s.base, s.kv, { op: "pause" }, s.runners, newRuntime());
    expect(b.attached).toBe(false);
    expect(b.opId).not.toBe(a.opId);
    gate.resolve();
    await Promise.all([a.done, b.done]);
  });
});

describe("waitForOp", () => {
  it("returns at once when terminal; unknown op → undefined", async () => {
    const s = setup();
    const r = await runOpWithJournal(s.base, s.kv, { op: "delete" }, s.runners, s.rt);
    await r.done;
    const t0 = s.clock.now();
    expect((await waitForOp(s.kv, r.opId, 20_000, undefined, s.clock, s.rt.notifier))?.phase).toBe(
      "succeeded",
    );
    expect(s.clock.now()).toBe(t0);
    expect(await waitForOp(s.kv, "amp-T-1:nope", 20_000, undefined, s.clock, s.rt.notifier)).toBeUndefined();
  });

  it("times out at waitMs (max 25 s) when nothing changes", async () => {
    const s = setup();
    const gate = deferred<void>();
    s.runners.runDelete = async () => {
      await gate.promise;
    };
    const r = await runOpWithJournal(s.base, s.kv, { op: "delete" }, s.runners, s.rt);
    let t0 = s.clock.now();
    const rec = await waitForOp(s.kv, r.opId, 5_000, undefined, s.clock, s.rt.notifier);
    expect(rec?.phase).not.toBe("succeeded");
    expect(s.clock.now() - t0).toBe(5_000);
    t0 = s.clock.now();
    await waitForOp(s.kv, r.opId, 999_000, undefined, s.clock, s.rt.notifier);
    expect(s.clock.now() - t0).toBe(25_000);
    gate.resolve();
    await r.done;
  });

  it("returns early when progress grows past since, woken by notify", async () => {
    const s = setup();
    const gate = deferred<void>();
    let say: ((l: string) => void) | undefined;
    s.runners.runSpawn = async (ctx) => {
      say = ctx.say;
      await gate.promise;
      return { ok: true, source: "image", wakeMs: 1 };
    };
    const r = await runOpWithJournal(s.base, s.kv, { op: "spawn", token: TOKEN }, s.runners, s.rt);
    await new Promise((res) => setTimeout(res, 0));
    // since=0 with no progress yet: real-time notifier wakes the poll when a line lands
    const realClock = {
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((res) => setTimeout(res, ms)),
    };
    const t0 = Date.now();
    const p = waitForOp(s.kv, r.opId, 10_000, 0, realClock, s.rt.notifier);
    setTimeout(() => say?.("step one"), 20);
    const rec = await p;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(rec?.progress).toHaveLength(1);
    // since below current length → immediate
    expect((await waitForOp(s.kv, r.opId, 10_000, 0, realClock, s.rt.notifier))?.progress).toHaveLength(1);
    gate.resolve();
    await r.done;
  });

  it("a notify while the read is in flight still wakes the poll", async () => {
    const s = setup();
    const gate = deferred<void>();
    s.runners.runSpawn = async () => {
      await gate.promise;
      return { ok: true, source: "image", wakeMs: 1 };
    };
    const r = await runOpWithJournal(s.base, s.kv, { op: "spawn", token: TOKEN }, s.runners, s.rt);
    await new Promise((res) => setTimeout(res, 0));
    // The first read returns the record as it was, but a line lands and notifies before it returns.
    const stale = structuredClone(await s.kv.get<OpRecord>(`op:${r.opId}`));
    let first = true;
    const racy = {
      get: async <T>(k: string): Promise<T | undefined> => {
        if (!first) return s.kv.get<T>(k);
        first = false;
        await appendProgress(s.kv, r.opId, "late line");
        s.rt.notifier.notify(r.opId);
        return stale as T;
      },
      put: <T>(k: string, v: T) => s.kv.put(k, v),
      delete: (k: string) => s.kv.delete(k),
      list: <T>(p: string) => s.kv.list<T>(p),
    };
    const realClock = {
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((res) => setTimeout(res, ms)),
    };
    const t0 = Date.now();
    const rec = await waitForOp(racy, r.opId, 10_000, 0, realClock, s.rt.notifier);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(rec?.progress).toEqual(["late line"]);
    gate.resolve();
    await r.done;
  });

  it("spawn done: the poll wakes once, on the final record with the done line", async () => {
    const s = setup();
    const gate = deferred<void>();
    s.runners.runSpawn = async () => {
      await gate.promise;
      return { ok: true, source: "image", wakeMs: 1 };
    };
    const r = await runOpWithJournal(s.base, s.kv, { op: "spawn", token: TOKEN }, s.runners, s.rt);
    await new Promise((res) => setTimeout(res, 0));
    const realClock = {
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((res) => setTimeout(res, ms)),
    };
    const p = waitForOp(s.kv, r.opId, 10_000, 0, realClock, s.rt.notifier);
    gate.resolve();
    const rec = await p;
    expect(rec?.phase).toBe("succeeded");
    expect(rec?.progress.at(-1)).toMatch(/spawn done$/);
    await r.done;
  });

  it("OpNotifier cancel removes the waiter", () => {
    const n = new OpNotifier();
    const w = n.next("x");
    w.cancel();
    n.notify("x");
    expect((n as unknown as { waiters: Map<string, Set<unknown>> }).waiters.get("x")?.size ?? 0).toBe(0);
  });
});

describe("text replies for dispatch.sh (?format=text)", () => {
  const op: OpRecord = {
    opId: "amp-T-1:11111111-1111-4111-8111-111111111111",
    orbId: "amp-T-1",
    op: "spawn",
    inputsHash: "h",
    phase: "running",
    startedAt: "2026-11-10T00:00:00.000Z",
    progress: ["0.0s one", "0.5s two\twith\u0001control", "0.9s three"],
  };

  it("POST ops answers opId and attached as key=value lines", async () => {
    const { env } = fakeEnv({}, { "ORB.submitOp": () => ({ opId: op.opId, attached: true }) });
    const r = await handleApi(
      req("/v1/orbs/amp-T-1/ops?format=text", { method: "POST", body: JSON.stringify({ op: "pause" }) }),
      env,
      { internal: true },
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await r.text()).toBe(`opId=${op.opId}\nattached=true\n`);
  });

  it("GET op answers phase, total and only the progress lines after since, one per line", async () => {
    const { env } = fakeEnv({}, { "ORB.getOp": () => op });
    const r = await handleApi(req(`/v1/ops/${op.opId}?wait=0&since=1&format=text`), env, { internal: true });
    expect(await r.text()).toBe(
      "phase=running\ntotal=3\nprogress=0.5s two with control\nprogress=0.9s three\n",
    );
  });

  it("a long-poll with new lines waits a moment and sends the lines that came in the meantime", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const later = { ...op, progress: [...op.progress, "1.0s four"] };
      const { env, calls } = fakeEnv({}, { "ORB.getOp": () => (n++ === 0 ? op : later) });
      const pending = handleApi(req(`/v1/ops/${op.opId}?wait=20&since=2&format=text`), env, {
        internal: true,
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(await (await pending).text()).toBe(
        "phase=running\ntotal=4\nprogress=0.9s three\nprogress=1.0s four\n",
      );
      expect(calls.filter((c) => c.method === "getOp").map((c) => c.args[1])).toEqual([20_000, 0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed op carries its error line", async () => {
    const failed = { ...op, phase: "failed", error: "Failed: boom — fix: retry" };
    const { env } = fakeEnv({}, { "ORB.getOp": () => failed });
    const r = await handleApi(req(`/v1/ops/${op.opId}?since=3&format=text`), env, { internal: true });
    expect(await r.text()).toBe("phase=failed\ntotal=3\nerror=Failed: boom — fix: retry\n");
  });

  it("errors keep their status and become one error= line", async () => {
    const { env } = fakeEnv();
    const r = await handleApi(req("/v1/ops/nope?format=text"), env, { internal: true });
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/^error=Failed: invalid op id nope — fix: [^\n]+\n$/);
    const denied = await handleApi(req("/v1/health?format=text"), env, { internal: false });
    expect(denied.status).toBe(401);
    expect(await denied.text()).toMatch(/^error=Failed: missing or wrong bearer token/);
  });

  it("without format=text the JSON replies are unchanged", async () => {
    const { env } = fakeEnv({}, { "ORB.getOp": () => op });
    const r = await handleApi(req(`/v1/ops/${op.opId}?since=1`), env, { internal: true });
    expect((await body(r)).progress).toHaveLength(3);
  });
});
