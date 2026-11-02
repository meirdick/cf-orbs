// `cf-orbs snapshots prune`: Registry candidate selection, the delete marker, and the /v1/snapshots routes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/api";
import { PRUNE_DEFAULT_AGE_MS, RegistryCore, selectPruneCandidates } from "../src/core/registry-core";
import {
  DEFAULT_CONFIG,
  PROJECT_MAP_TTL_MS,
  type ProjectSnapshotMapping,
  SNAPSHOT_TTL_MS,
  type SnapshotHandle,
} from "../src/core/types";
import type { Env } from "../src/env";
import { runDelete } from "../src/orb/delete";
import { FakeClock, MemoryKV } from "./fake-container";
import { makeOrbCtx } from "./fake-registry";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));

const H = 3600_000;
const D = 24 * H;
const MB = 1_000_000;

describe("RegistryCore.pruneCandidates", () => {
  let kv: MemoryKV;
  let clock: FakeClock;
  let reg: RegistryCore;
  const at = (msAgo: number) => new Date(clock.now() - msAgo).toISOString();
  const handle = (id: string, msAgo: number, size = 100 * MB): SnapshotHandle => ({
    id,
    size,
    imageKey: "orb",
    instance: DEFAULT_CONFIG.instance,
    createdAt: at(msAgo),
  });
  const mapping = (snapshotId: string, h: SnapshotHandle, usedAgo: number): ProjectSnapshotMapping => ({
    snapshotId,
    handle: h,
    sourceOrbId: "amp-T-1",
    createdAt: h.createdAt,
    lastUsedAt: at(usedAgo),
  });
  const ids = async (olderThan = PRUNE_DEFAULT_AGE_MS) =>
    (await reg.pruneCandidates(olderThan)).candidates.map((c) => c.id);

  beforeEach(() => {
    kv = new MemoryKV();
    clock = new FakeClock();
    reg = new RegistryCore(kv, clock, { maxRunning: 20, alarmSeconds: 60 });
  });

  it("keeps each orb's newest snapshot (its disk); older ones past the age gate are candidates", async () => {
    await reg.recordSnapshot(handle("a1", 20 * D), "amp-T-a");
    await reg.recordSnapshot(handle("a2", 10 * D), "amp-T-a");
    await reg.recordSnapshot(handle("a3", 9 * D), "amp-T-a"); // newest of amp-T-a, old: still its disk
    await reg.recordSnapshot(handle("b1", 3 * D), "amp-T-b");
    await reg.recordSnapshot(handle("b2", 1 * D), "amp-T-b");
    const r = await reg.pruneCandidates(PRUNE_DEFAULT_AGE_MS);
    expect(r.candidates.map((c) => c.id)).toEqual(["a1", "a2"]); // oldest first
    expect(r.totalBytes).toBe(200 * MB);
    expect(r.kept).toEqual({ mapped: 0, current: 2, young: 1 });
    expect(r.candidates[0]).toMatchObject({ orbId: "amp-T-a", imageKey: "orb", bytes: 100 * MB });
    // --all removes only the age gate
    expect(await ids(0)).toEqual(["a1", "a2", "b1"]);
  });

  it("counts age from the later of createdAt and lastRestoredAt", async () => {
    await reg.recordSnapshot(handle("a1", 20 * D), "amp-T-a");
    await reg.recordSnapshot({ ...handle("a1", 20 * D), lastRestoredAt: at(2 * D) }, "amp-T-a");
    await reg.recordSnapshot(handle("a2", 15 * D), "amp-T-a");
    expect(await ids()).toEqual([]);
    clock.advance(5 * D);
    const r = await reg.pruneCandidates(PRUNE_DEFAULT_AGE_MS);
    expect(r.candidates.map((c) => c.id)).toEqual(["a1"]);
    expect(r.candidates[0]?.lastUsedAt).toBe(new Date(clock.now() - 7 * D).toISOString());
  });

  it("never offers a snapshot a live project mapping uses, even with no age gate", async () => {
    const p = handle("p1", 20 * D);
    await reg.recordSnapshot(p, "amp-T-1");
    await reg.recordSnapshot(handle("p2", 19 * D), "amp-T-1");
    await reg.putProjectSnapshot(mapping("snap-live", p, H));
    const r = await reg.pruneCandidates(0);
    expect(r.candidates).toEqual([]);
    expect(r.kept).toMatchObject({ mapped: 1, current: 1 });
    // unused for 72 h: spawn no longer uses the mapping, so the data can go
    clock.advance(PROJECT_MAP_TTL_MS);
    expect(await ids(0)).toEqual(["p1"]);
  });

  it("a project mapping forgotten as stale (projectSnapshotRefresh) does not keep its snapshot", async () => {
    const p = handle("p1", 20 * D);
    await reg.recordSnapshot(p, "amp-T-1");
    await reg.recordSnapshot(handle("p2", 19 * D), "amp-T-1");
    await reg.putProjectSnapshot(mapping("snap-f00d-0123456789", p, H));
    expect(await ids(0)).toEqual([]);
    const r = await reg.markProjectSnapshotStale("snap-f00d-0123456789", "amp updated 1 -> 2", at(0));
    expect(r.forgotten).toBe(true);
    expect(await ids(0)).toEqual(["p1"]);
    expect(await reg.forgetSnapshots(["p1"])).toEqual({ forgotten: ["p1"], mapped: [] });
  });

  it("skips snapshots past their 30-day TTL (Cloudflare dropped them)", async () => {
    await reg.recordSnapshot(handle("old", SNAPSHOT_TTL_MS + H), "amp-T-a");
    await reg.recordSnapshot(handle("new", D), "amp-T-a");
    expect(await ids(0)).toEqual([]);
  });

  it("after a delete, the orb's newest snapshot is no longer its disk", async () => {
    await reg.recordSnapshot(handle("a1", 10 * D), "amp-T-a");
    await reg.recordSnapshot(handle("a2", 9 * D), "amp-T-a");
    expect(await ids()).toEqual(["a1"]);
    await reg.orbDeleted("amp-T-a", at(8 * D));
    expect(await ids()).toEqual(["a1", "a2"]);
    // a later spawn and pause on the same id gives a new disk, which is kept
    await reg.recordSnapshot(handle("a3", 7 * D + H), "amp-T-a");
    expect(await ids()).toEqual(["a1", "a2"]);
    // a marker keeps the later time
    await reg.orbDeleted("amp-T-a", at(20 * D));
    expect(await ids()).toEqual(["a1", "a2"]);
  });

  it("summary reports prunable count and bytes with the default age", async () => {
    await reg.recordSnapshot(handle("a1", 10 * D, 300 * MB), "amp-T-a");
    await reg.recordSnapshot(handle("a2", 9 * D), "amp-T-a");
    await reg.recordSnapshot(handle("b1", D), "amp-T-b");
    const s = await reg.summary();
    expect(s).toMatchObject({ retainedSnapshots: 3, prunableSnapshots: 1, prunableSnapshotBytes: 300 * MB });
  });

  it("forgetSnapshots drops index entries but never one a live mapping uses", async () => {
    const p = handle("p1", 2 * D);
    await reg.recordSnapshot(handle("a1", 10 * D), "amp-T-a");
    await reg.recordSnapshot(p, "amp-T-1");
    await reg.putProjectSnapshot(mapping("snap-live", p, H));
    expect(await reg.forgetSnapshots(["a1", "p1", "nope", "a1"])).toEqual({
      forgotten: ["a1"],
      mapped: ["p1"],
    });
    expect((await reg.listSnapshots()).map((e) => e.handle.id)).toEqual(["p1"]);
  });

  it("gc drops a delete marker once no snapshot of that orb is left and the TTL passed", async () => {
    await reg.recordSnapshot(handle("a1", D), "amp-T-a");
    await reg.orbDeleted("amp-T-a", at(0));
    await reg.orbDeleted("amp-T-b", at(0));
    clock.advance(SNAPSHOT_TTL_MS - 2 * D);
    await reg.gc(new Date(clock.now()).toISOString());
    expect([...(await kv.list("gone:")).keys()].sort()).toEqual(["gone:amp-T-a", "gone:amp-T-b"]);
    clock.advance(3 * D);
    await reg.gc(new Date(clock.now()).toISOString());
    expect([...(await kv.list("gone:")).keys()]).toEqual([]);
  });
});

describe("selectPruneCandidates", () => {
  const now = Date.parse("2026-10-30T20:00:00Z");
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const entry = (id: string, orbId: string, msAgo: number) => ({
    handle: { id, size: 1, imageKey: "orb", instance: "lite" as const, createdAt: iso(msAgo) },
    orbId,
    createdAt: iso(msAgo),
  });

  it("treats a tie for newest as current (both kept)", () => {
    const r = selectPruneCandidates([entry("x", "o", 9 * D), entry("y", "o", 9 * D)], [], new Map(), now, 0);
    expect(r.candidates).toEqual([]);
    expect(r.kept.current).toBe(2);
  });
});

describe("delete op marks the orb in the Registry", () => {
  it("calls orbDeleted; a Registry error does not fail the delete", async () => {
    const h = makeOrbCtx();
    expect(await runDelete(h.newOp())).toEqual({ ok: true });
    expect(h.registry.calls.some((c) => c.startsWith("deleted amp-T-test 2026-"))).toBe(true);
    h.registry.orbDeleted = async () => {
      throw new Error("registry down");
    };
    expect(await runDelete(h.newOp())).toEqual({ ok: true });
  });
});

describe("/v1/snapshots routes", () => {
  type Call = { method: string; args: unknown[] };
  function env(): { env: Env; calls: Call[] } {
    const calls: Call[] = [];
    const stub = new Proxy(
      {},
      {
        get(_t, method: string) {
          return async (...args: unknown[]) => {
            calls.push({ method, args });
            if (method === "pruneCandidates") return { candidates: [], totalBytes: 0, olderThanMs: args[0] };
            if (method === "forgetSnapshots") return { forgotten: args[0], mapped: [] };
            if (method === "listSnapshots") return [];
            return {};
          };
        },
      },
    );
    const ns = { getByName: () => stub } as unknown as DurableObjectNamespace;
    return {
      env: { ORB: ns, REGISTRY: ns, PROVIDER: ns, CF_ORBS_CONFIG: "{}", CONTROL_TOKEN: "tok" },
      calls,
    };
  }
  const auth = { authorization: "Bearer tok" };
  const call = (e: Env, path: string, init: RequestInit = {}) =>
    handleApi(new Request(`https://x${path}`, { ...init, headers: auth }), e, { internal: false });

  it("GET ?candidates=1 passes olderThan in ms (default 7 d; 0 allowed)", async () => {
    const { env: e, calls } = env();
    expect((await call(e, "/v1/snapshots?candidates=1")).status).toBe(200);
    expect(calls.at(-1)).toEqual({ method: "pruneCandidates", args: [PRUNE_DEFAULT_AGE_MS] });
    const r = await call(e, "/v1/snapshots?candidates=1&olderThan=0");
    expect(await r.json()).toMatchObject({ olderThanMs: 0 });
    for (const bad of ["-1", "1.5", "x", "99999999999"]) {
      const b = await call(e, `/v1/snapshots?candidates=1&olderThan=${bad}`);
      expect(b.status).toBe(400);
      expect(((await b.json()) as { error: string }).error).toMatch(/^Failed: invalid olderThan .* — fix: /);
    }
  });

  it("GET without candidates lists the index", async () => {
    const { env: e, calls } = env();
    const r = await call(e, "/v1/snapshots");
    expect(await r.json()).toEqual({ snapshots: [], summary: {} });
    expect(calls.map((c) => c.method).sort()).toEqual(["listSnapshots", "status"]);
  });

  it("POST forget-many validates ids and calls forgetSnapshots", async () => {
    const { env: e, calls } = env();
    const ok = await call(e, "/v1/snapshots/forget-many", {
      method: "POST",
      body: JSON.stringify({ ids: ["a1", "b-2"] }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ forgotten: ["a1", "b-2"], mapped: [] });
    for (const body of ["{}", '{"ids":"a"}', '{"ids":["a b"]}', '{"ids":[1]}', "nope"]) {
      const r = await call(e, "/v1/snapshots/forget-many", { method: "POST", body });
      expect(r.status).toBe(400);
    }
    expect(calls.filter((c) => c.method === "forgetSnapshots")).toHaveLength(1);
    expect((await call(e, "/v1/snapshots/forget-many")).status).toBe(405);
    expect((await call(e, "/v1/snapshots", { method: "POST" })).status).toBe(405);
    expect((await call(e, "/v1/snapshots/other", { method: "POST" })).status).toBe(404);
  });
});
