// Prewarm (config prewarm): throwaway instances after a deploy. Config, Registry run record, job lifecycle, API.
import { describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/api";
import { parseConfig } from "../src/core/config";
import { RegistryCore, WARM_REPORT_GRACE_MS } from "../src/core/registry-core";
import {
  DEFAULT_CONFIG,
  JOB_DEADLINE_MS,
  MAX_PREWARM,
  WARM_JOB_TIMEOUT_MS,
  WARM_ORB_RE,
  type WarmResult,
  warmOrbId,
} from "../src/core/types";
import type { Env } from "../src/env";
import { runAlarm } from "../src/orb/alarm";
import { queueWarmJob, runWarmAlarm, runWarmJob, WARM_JOB_KEY, type WarmDeps } from "../src/orb/prewarm";
import { FakeClock, FakeContainer, MemoryKV } from "./fake-container";
import { FakeRegistry } from "./fake-registry";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));

const S = 1000;

describe("prewarm config", () => {
  it("defaults to 2 and takes 0-5", () => {
    expect(DEFAULT_CONFIG.prewarm).toBe(2);
    expect(parseConfig("{}").prewarm).toBe(2);
    expect(parseConfig('{"prewarm":0}').prewarm).toBe(0);
    expect(parseConfig('{"prewarm":5}').prewarm).toBe(5);
    expect(MAX_PREWARM).toBe(5);
  });
  it("rejects values outside 0-5 with a one-line fix", () => {
    for (const v of ["6", "-1", "1.5", '"2"'])
      expect(() => parseConfig(`{"prewarm":${v}}`)).toThrow(
        /^Failed: prewarm must be an integer from 0 to 5, got .* — fix: edit cf-orbs.config.jsonc/,
      );
  });
  it("warm ids cannot look like Amp orb ids", () => {
    expect(warmOrbId(2, 1761854400000)).toBe("warm-2-1761854400000");
    expect(WARM_ORB_RE.test("warm-2-1761854400000")).toBe(true);
    expect(WARM_ORB_RE.test("amp-T-1")).toBe(false);
    expect(WARM_ORB_RE.test("warm-x")).toBe(false);
  });
});

describe("Registry prewarm run", () => {
  const make = () => {
    const clock = new FakeClock();
    return { clock, reg: new RegistryCore(new MemoryKV(), clock, DEFAULT_CONFIG) };
  };

  it("records a run, takes results, and gives totals", async () => {
    const { clock, reg } = make();
    expect(await reg.warmStatus()).toBeNull();
    const run = await reg.startWarmRun(2);
    expect(run.count).toBe(2);
    expect(run.jobs.map((j) => j.orbId)).toEqual([warmOrbId(1, clock.t), warmOrbId(2, clock.t)]);
    let v = await reg.warmStatus();
    expect(v).toMatchObject({ count: 2, ok: 0, failed: 0, pending: 2, msPerInstance: [] });
    clock.advance(45 * S);
    expect(await reg.recordWarmResult(run.runId, run.jobs[0]!.orbId, { ok: true, ms: 41_000 })).toBe(true);
    expect(
      await reg.recordWarmResult(run.runId, run.jobs[1]!.orbId, {
        ok: false,
        ms: 180_000,
        error: "not ready in 3 min",
      }),
    ).toBe(true);
    v = await reg.warmStatus();
    expect(v).toMatchObject({ ok: 1, failed: 1, pending: 0, msPerInstance: [41_000] });
    expect(v?.jobs[1]).toMatchObject({ state: "failed", error: "not ready in 3 min" });
  });

  it("caps the count at 5 and ignores results of an older run", async () => {
    const { clock, reg } = make();
    const old = await reg.startWarmRun(9);
    expect(old.count).toBe(MAX_PREWARM);
    clock.advance(1000);
    const run = await reg.startWarmRun(1);
    expect(await reg.recordWarmResult(old.runId, old.jobs[0]!.orbId, { ok: true, ms: 1 })).toBe(false);
    expect(await reg.recordWarmResult(run.runId, "warm-9-1", { ok: true, ms: 1 })).toBe(false);
    expect((await reg.warmStatus())?.runId).toBe(run.runId);
  });

  it("a job that never reports counts as failed after the grace", async () => {
    const { clock, reg } = make();
    await reg.startWarmRun(1);
    clock.advance(WARM_REPORT_GRACE_MS + 1);
    expect(await reg.warmStatus()).toMatchObject({
      failed: 1,
      pending: 0,
      jobs: [{ state: "failed", error: "no result from the prewarm job" }],
    });
  });
});

function warmHarness(readyAfterMs: number) {
  const clock = new FakeClock();
  const fake = new FakeContainer(clock);
  fake.readyAfterMs = readyAfterMs;
  const kv = new MemoryKV();
  const reports: { runId: string; r: WarmResult }[] = [];
  const lines: string[] = [];
  const deps: WarmDeps = {
    orbId: "warm-1-1761854400000",
    container: fake,
    clock,
    config: { ...DEFAULT_CONFIG, instance: { vcpu: 2, memoryMib: 6144, diskMb: 20000 } },
    kv,
    report: async (runId, r) => {
      reports.push({ runId, r });
    },
    say: (l) => lines.push(l),
  };
  return { clock, fake, kv, reports, lines, deps };
}

describe("prewarm job", () => {
  it("starts from the orb image with the configured size, waits for readiness, destroys", async () => {
    const h = warmHarness(41 * S);
    const r = await runWarmJob(h.deps);
    expect(r.ok).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(41 * S);
    expect(r.ms).toBeLessThan(43 * S);
    expect(h.fake.startCount).toBe(1);
    expect(h.fake.startedWith).toMatchObject({
      source: { image: h.fake.images().orb },
      instance: { vcpu: 2, memoryMib: 6144, diskMb: 20000 },
      enableInternet: false,
      labels: { orb: "warm-1-1761854400000", prewarm: "1" },
    });
    expect(h.fake.execLog.every((c) => c[0] === "true")).toBe(true);
    expect(h.fake.running).toBe(false);
    expect(h.fake.destroyCount).toBe(1);
    expect(h.fake.snapshotCount).toBe(0);
  });

  it("timeout: not ready in 3 min → destroyed, failed", async () => {
    const h = warmHarness(10 * 60 * S);
    const t0 = h.clock.now();
    const r = await runWarmJob(h.deps);
    expect(r).toMatchObject({ ok: false, error: "not ready in 3 min" });
    expect(h.clock.now() - t0).toBeLessThanOrEqual(WARM_JOB_TIMEOUT_MS + 5 * S);
    expect(h.fake.running).toBe(false);
    expect(h.fake.destroyCount).toBe(1);
  });

  it("start error → failed, nothing left running", async () => {
    const h = warmHarness(0);
    h.fake.start = () => {
      throw new Error("no capacity");
    };
    const r = await runWarmJob(h.deps);
    expect(r).toMatchObject({ ok: false, error: "start failed: no capacity" });
    expect(h.fake.running).toBe(false);
  });

  it("alarm runs a queued job once, reports it, and clears it", async () => {
    const h = warmHarness(39 * S);
    await queueWarmJob(h.kv, h.deps.orbId, "run-1", h.clock.now());
    expect(await runWarmAlarm(h.deps)).toBe(true);
    expect(h.reports).toEqual([{ runId: "run-1", r: { ok: true, ms: expect.any(Number) } }]);
    expect(await h.kv.get(WARM_JOB_KEY)).toBeUndefined();
    expect(h.fake.running).toBe(false);
    expect(h.lines.some((l) => /^prewarm: instance ready in 39\.\d s; destroyed$/.test(l))).toBe(true);
    // a second alarm has nothing to do
    expect(await runWarmAlarm(h.deps)).toBe(false);
    expect(h.fake.startCount).toBe(1);
  });

  it("alarm after a DO restart mid-job: does not start again, destroys, reports a failure", async () => {
    const h = warmHarness(0);
    await h.kv.put(WARM_JOB_KEY, { runId: "run-1", queuedAt: "x", startedAt: "y" });
    h.fake.start({ source: { image: "img" }, instance: "standard-1", enableInternet: false });
    expect(await runWarmAlarm(h.deps)).toBe(true);
    expect(h.fake.running).toBe(false);
    expect(h.fake.startCount).toBe(1);
    expect(h.reports[0]?.r).toMatchObject({ ok: false, error: /interrupted/ });
    expect(await h.kv.get(WARM_JOB_KEY)).toBeUndefined();
  });

  it("a report failure is logged, not thrown", async () => {
    const h = warmHarness(0);
    h.deps.report = async () => {
      throw new Error("registry down");
    };
    await queueWarmJob(h.kv, h.deps.orbId, "run-1", h.clock.now());
    await runWarmAlarm(h.deps);
    expect(h.lines).toContain("prewarm: could not report the result: registry down");
  });

  it("only warm-* orbs take a job", async () => {
    await expect(queueWarmJob(new MemoryKV(), "amp-T-1", "r", 0)).rejects.toThrow(
      /^Failed: prewarm runs only on warm-<n>-<ts> orbs/,
    );
  });

  it("leftover container with no job: the normal alarm (no orb record) destroys it", async () => {
    const h = warmHarness(0);
    h.fake.start({ source: { image: "img" }, instance: "standard-1", enableInternet: false });
    expect(await runWarmAlarm(h.deps)).toBe(false);
    const registry = new FakeRegistry();
    const r = await runAlarm({
      ...h.deps,
      registry,
      deadline: h.clock.now() + JOB_DEADLINE_MS,
    });
    expect(r.rearmInMs).toBeNull();
    expect(h.fake.running).toBe(false);
    expect(h.fake.destroyCount).toBe(1);
  });
});

describe("prewarm API", () => {
  type Call = { name: string; method: string; args: unknown[] };
  function fakeEnv(config: object, behave: Record<string, (...a: unknown[]) => unknown> = {}) {
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
      CF_ORBS_CONFIG: JSON.stringify(config),
      CONTROL_TOKEN: "s3cret-control",
    };
    return { env, calls };
  }
  const auth = { authorization: "Bearer s3cret-control" };
  const call = (env: Env, path: string, method = "GET") =>
    handleApi(new Request(`https://cf-orbs.example${path}`, { method, headers: auth }), env, {
      internal: false,
    });

  it("POST /v1/warm records a run and queues one job per warm-* orb, then returns", async () => {
    const clock = new FakeClock();
    const reg = new RegistryCore(new MemoryKV(), clock, DEFAULT_CONFIG);
    const { env, calls } = fakeEnv(
      { prewarm: 3 },
      {
        "REGISTRY.startWarmRun": (n) => reg.startWarmRun(n as number),
        "REGISTRY.recordWarmResult": (a, b, c) =>
          reg.recordWarmResult(a as string, b as string, c as WarmResult),
        "ORB.warmStart": () => ({ queued: true }),
      },
    );
    const r = await call(env, "/v1/warm", "POST");
    expect(r.status).toBe(200);
    const b = (await r.json()) as Record<string, unknown>;
    expect(b).toMatchObject({ count: 3, started: 3, runId: String(clock.t) });
    expect(b.orbIds).toEqual([1, 2, 3].map((n) => warmOrbId(n, clock.t)));
    const warm = calls.filter((c) => c.method === "warmStart");
    expect(warm.map((c) => c.name)).toEqual([1, 2, 3].map((n) => `ORB/orb:${warmOrbId(n, clock.t)}`));
    expect(warm.every((c) => c.args[0] === String(clock.t))).toBe(true);
  });

  it("POST /v1/warm: a job that cannot be queued is recorded as failed", async () => {
    const clock = new FakeClock();
    const reg = new RegistryCore(new MemoryKV(), clock, DEFAULT_CONFIG);
    const { env } = fakeEnv(
      { prewarm: 2 },
      {
        "REGISTRY.startWarmRun": (n) => reg.startWarmRun(n as number),
        "REGISTRY.recordWarmResult": (a, b, c) =>
          reg.recordWarmResult(a as string, b as string, c as WarmResult),
        "ORB.warmStart": () => {
          throw new Error("DO overloaded");
        },
      },
    );
    const b = (await (await call(env, "/v1/warm", "POST")).json()) as Record<string, unknown>;
    expect(b).toMatchObject({ count: 2, started: 0 });
    expect(await reg.warmStatus()).toMatchObject({ failed: 2, jobs: [{ error: /could not queue/ }, {}] });
  });

  it("POST /v1/warm with prewarm 0 starts nothing", async () => {
    const { env, calls } = fakeEnv({ prewarm: 0 });
    const r = await call(env, "/v1/warm", "POST");
    expect(await r.json()).toEqual({ count: 0, started: 0, orbIds: [] });
    expect(calls).toEqual([]);
  });

  it("GET /v1/warm returns the config value and the last run; /v1/status carries it too", async () => {
    const last = { runId: "1", count: 2, ok: 2, msPerInstance: [41_000, 39_000] };
    const { env } = fakeEnv(
      { prewarm: 2 },
      { "REGISTRY.warmStatus": () => last, "REGISTRY.status": () => ({ running: [] }) },
    );
    expect(await (await call(env, "/v1/warm")).json()).toEqual({ prewarm: 2, last });
    expect(((await (await call(env, "/v1/status")).json()) as Record<string, unknown>).prewarm).toEqual(last);
    expect((await call(env, "/v1/warm", "DELETE")).status).toBe(405);
  });

  it("Amp ops on a warm-* orb id are rejected", async () => {
    const { env, calls } = fakeEnv({});
    const r = await handleApi(
      new Request("https://cf-orbs.example/v1/orbs/warm-1-1761854400000/ops", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ op: "spawn", token: "t" }),
      }),
      env,
      { internal: true },
    );
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(
      /^Failed: orb id warm-1-1761854400000 is reserved for prewarm — fix: /,
    );
    expect(calls).toEqual([]);
  });
});
