import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/core/config";
import { RegistryCore, runCapMessage } from "../src/core/registry-core";
import {
  DEFAULT_CONFIG,
  PROJECT_MAP_TTL_MS,
  type ProjectSnapshotMapping,
  SNAPSHOT_TTL_MS,
  type SnapshotHandle,
} from "../src/core/types";
import { FakeClock, MemoryKV } from "./fake-container";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const H = 3600_000;
const GB = 1_000_000_000;

function handle(id: string, createdAt: string, size = GB): SnapshotHandle {
  return { id, size, imageKey: "orb", instance: DEFAULT_CONFIG.instance, createdAt };
}

function mapping(snapshotId: string, h: SnapshotHandle, lastUsedAt = h.createdAt): ProjectSnapshotMapping {
  return { snapshotId, handle: h, sourceOrbId: "amp-T-1", createdAt: h.createdAt, lastUsedAt };
}

describe("RegistryCore run cap", () => {
  let kv: MemoryKV;
  let clock: FakeClock;
  let reg: RegistryCore;
  beforeEach(() => {
    kv = new MemoryKV();
    clock = new FakeClock();
    reg = new RegistryCore(kv, clock, { maxRunning: 20, alarmSeconds: 60 });
  });

  it("rejects orb #21 with the cap text; a running orb keeps its slot", async () => {
    for (let i = 1; i <= 20; i++) {
      const r = await reg.acquireRunSlot(`amp-T-${i}`);
      expect(r).toMatchObject({ ok: true, running: i, max: 20 });
    }
    const r21 = await reg.acquireRunSlot("amp-T-21");
    expect(r21.ok).toBe(false);
    expect(r21.running).toBe(20);
    expect(r21.error).toBe(
      "Failed: 20/20 orbs already running — fix: raise maxRunning in cf-orbs.config.jsonc or pause idle threads",
    );
    expect(runCapMessage(20, 20)).toBe(r21.error);
    expect(await reg.acquireRunSlot("amp-T-5")).toMatchObject({ ok: true, running: 20 });
    await reg.releaseRunSlot("amp-T-5");
    expect(await reg.acquireRunSlot("amp-T-21")).toMatchObject({ ok: true, running: 20 });
  });

  it("concurrent acquires never exceed the cap", async () => {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => reg.acquireRunSlot(`amp-T-${i}`)));
    expect(results.filter((r) => r.ok)).toHaveLength(20);
    expect((await kv.list("run:")).size).toBe(20);
  });

  it("stale heartbeats expire and free the slot; fresh ones keep it", async () => {
    for (let i = 1; i <= 20; i++) await reg.acquireRunSlot(`amp-T-${i}`);
    clock.advance(120_000);
    await reg.heartbeat("amp-T-1");
    clock.advance(61_000); // others: 181 s since last beat > 3 × 60 s
    const r = await reg.acquireRunSlot("amp-T-21");
    expect(r).toMatchObject({ ok: true, running: 2 });
    expect((await reg.summary()).running).toEqual(["amp-T-1", "amp-T-21"]);
    expect(await kv.get("run:amp-T-2")).toBeUndefined();
  });

  it("heartbeat restores a dropped slot", async () => {
    await reg.heartbeat("amp-T-9");
    expect((await reg.summary()).running).toEqual(["amp-T-9"]);
  });
});

describe("RegistryCore project snapshots and GC", () => {
  let kv: MemoryKV;
  let clock: FakeClock;
  let reg: RegistryCore;
  const iso = (ms: number) => new Date(ms).toISOString();
  beforeEach(() => {
    kv = new MemoryKV();
    clock = new FakeClock();
    reg = new RegistryCore(kv, clock, { maxRunning: 20, alarmSeconds: 60 });
  });

  it("put indexes the handle; get/touch/drop work", async () => {
    const h = handle("s1", iso(clock.now()));
    await reg.putProjectSnapshot(mapping("snap-proj-a", h));
    expect((await reg.getProjectSnapshot("snap-proj-a"))?.handle.id).toBe("s1");
    expect(await kv.get("snap:s1")).toMatchObject({ orbId: "amp-T-1", createdAt: h.createdAt });
    clock.advance(10 * H);
    await reg.touchProjectSnapshot("snap-proj-a", iso(clock.now()));
    expect((await reg.getProjectSnapshot("snap-proj-a"))?.lastUsedAt).toBe(iso(clock.now()));
    expect(await kv.get("snap:s1")).toMatchObject({ lastRestoredAt: iso(clock.now()) });
    await reg.dropProjectSnapshot("snap-proj-a");
    expect(await reg.getProjectSnapshot("snap-proj-a")).toBeUndefined();
    expect(await kv.get("snap:s1")).toBeDefined(); // data is still retained by Cloudflare
  });

  it("72 h GC drops unused project maps, keeps used ones", async () => {
    const t0 = clock.now();
    await reg.putProjectSnapshot(mapping("old", handle("s-old", iso(t0))));
    await reg.putProjectSnapshot(mapping("used", handle("s-used", iso(t0))));
    clock.advance(70 * H);
    await reg.touchProjectSnapshot("used", iso(clock.now()));
    clock.advance(3 * H); // old: 73 h unused; used: 3 h
    expect(await reg.getProjectSnapshot("old")).toBeUndefined(); // reads honour the TTL before GC runs
    const r = await reg.gc(iso(clock.now()));
    expect(r.projects).toBe(1);
    expect(await kv.get("proj:old")).toBeUndefined();
    expect(await kv.get("proj:used")).toBeDefined();
    expect(r.snapshots).toBe(0); // snapshots live 30 days
  });

  it("snapshots expire 30 days after max(createdAt, lastRestoredAt)", async () => {
    const t0 = clock.now();
    await reg.recordSnapshot(handle("a", iso(t0)), "amp-T-1");
    await reg.recordSnapshot(handle("b", iso(t0)), "amp-T-2");
    clock.advance(20 * 24 * H);
    await reg.recordSnapshot(
      { ...handle("b", iso(t0)), lastRestoredAt: iso(clock.now()) } as SnapshotHandle,
      "x",
    );
    expect(await kv.get("snap:b")).toMatchObject({ orbId: "amp-T-2", createdAt: iso(t0) });
    const r = await reg.gc(iso(t0 + SNAPSHOT_TTL_MS + 1));
    expect(r.snapshots).toBe(1);
    expect(await kv.get("snap:a")).toBeUndefined();
    expect(await kv.get("snap:b")).toBeDefined();
  });

  it("GC drops a project map whose handle expired and stale run slots", async () => {
    const t0 = clock.now();
    await reg.putProjectSnapshot(mapping("p", handle("s", iso(t0)), iso(t0 + SNAPSHOT_TTL_MS - H)));
    await reg.acquireRunSlot("amp-T-1");
    const r = await reg.gc(iso(t0 + SNAPSHOT_TTL_MS));
    expect(r).toEqual({ projects: 1, snapshots: 1, running: 1 });
  });

  it("summary lists retained GB and next expiry", async () => {
    const t0 = clock.now();
    await reg.recordSnapshot(handle("a", iso(t0), 2 * GB), "amp-T-1");
    clock.advance(H);
    await reg.recordSnapshot(handle("b", iso(clock.now()), 3 * GB), "amp-T-2");
    await reg.putProjectSnapshot(mapping("p", handle("c", iso(clock.now()), 31_000_000)));
    await reg.acquireRunSlot("amp-T-2");
    const s = await reg.summary();
    expect(s).toEqual({
      projectSnapshots: 1,
      projects: [
        { snapshotId: "p", createdAt: iso(clock.now()), lastUsedAt: iso(clock.now()), expired: false },
      ],
      retainedSnapshots: 3,
      retainedSnapshotBytes: 5 * GB + 31_000_000,
      running: ["amp-T-2"],
      max: 20,
      nextExpiry: iso(t0 + SNAPSHOT_TTL_MS),
      prunableSnapshots: 0,
      prunableSnapshotBytes: 0,
    });
    clock.t = t0 + SNAPSHOT_TTL_MS; // "a" expired, not yet GC'd
    const s2 = await reg.summary();
    expect(s2.retainedSnapshotBytes).toBe(3 * GB + 31_000_000);
    expect(s2.nextExpiry).toBe(iso(t0 + H + SNAPSHOT_TTL_MS));
    expect(s2.projectSnapshots).toBe(0); // unused > 72 h
    expect(s2.running).toEqual([]);
  });

  it("summary is empty on a fresh registry", async () => {
    expect(await reg.summary()).toMatchObject({ retainedSnapshotBytes: 0, nextExpiry: null, running: [] });
  });

  it("project map TTL constant is 72 h", () => {
    expect(PROJECT_MAP_TTL_MS).toBe(72 * H);
  });
});

describe("parseConfig", () => {
  it("falls back to defaults", () => {
    expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(parseConfig("")).toEqual(DEFAULT_CONFIG);
    const c = parseConfig(undefined);
    c.images.x = "y";
    expect(DEFAULT_CONFIG.images).toEqual({}); // returns a copy
  });

  it("merges fields and ignores CLI-only keys", () => {
    const c = parseConfig(
      JSON.stringify({ instance: "standard-3", maxRunning: 5, providerHost: "cloudflare", debugSsh: false }),
    );
    expect(c.instance).toBe("standard-3");
    expect(c.maxRunning).toBe(5);
    expect(c.maxAwakeHours).toBe(12);
    expect(c.warmMinutes).toBe(10);
  });

  it("hugePages defaults to true; fastTmpfsGb to 0 and at most memory GiB - 3", () => {
    const d = parseConfig("{}");
    expect(d.hugePages).toBe(true);
    expect(d.fastTmpfsGb).toBe(0);
    expect(parseConfig(JSON.stringify({ hugePages: false })).hugePages).toBe(false);
    expect(parseConfig(JSON.stringify({ fastTmpfsGb: 8 })).fastTmpfsGb).toBe(8);
    const small = { vcpu: 2, memoryMib: 6144, diskMb: 20000 };
    expect(parseConfig(JSON.stringify({ instance: small, fastTmpfsGb: 3 })).fastTmpfsGb).toBe(3);
    expect(() => parseConfig(JSON.stringify({ instance: small, fastTmpfsGb: 4 }))).toThrow(
      /^Failed: fastTmpfsGb 4 leaves less than 3 GiB of the orb's 6 GiB memory — fix: set fastTmpfsGb to 3 or less/,
    );
    expect(() => parseConfig(JSON.stringify({ instance: "standard-1", fastTmpfsGb: 2 }))).toThrow(
      /set fastTmpfsGb to 1 or less/,
    );
    expect(() => parseConfig(JSON.stringify({ fastTmpfsGb: 9 }))).toThrow(/from 0 to 8/);
    expect(() => parseConfig(JSON.stringify({ fastTmpfsGb: 1.5 }))).toThrow(/an integer/);
    expect(() => parseConfig(JSON.stringify({ hugePages: "yes" }))).toThrow(
      /hugePages must be true or false/,
    );
  });

  it('projectSnapshotRefresh defaults to "off"; accepts "on-change"; rejects anything else', () => {
    expect(parseConfig("{}").projectSnapshotRefresh).toBe("off");
    expect(parseConfig(JSON.stringify({ projectSnapshotRefresh: "on-change" })).projectSnapshotRefresh).toBe(
      "on-change",
    );
    for (const bad of ["always", "", true, 1, null])
      expect(() => parseConfig(JSON.stringify({ projectSnapshotRefresh: bad }))).toThrow(
        /^Failed: projectSnapshotRefresh must be "off" or "on-change", got .* — fix: edit cf-orbs.config.jsonc/,
      );
  });

  it("warmMinutes: 0 turns warm pauses off", () => {
    expect(parseConfig(JSON.stringify({ warmMinutes: 0 })).warmMinutes).toBe(0);
    expect(parseConfig(JSON.stringify({ warmMinutes: 120 })).warmMinutes).toBe(120);
  });

  it("accepts valid custom instances", () => {
    expect(
      parseConfig(JSON.stringify({ instance: { vcpu: 1, memoryMib: 3072, diskMb: 20000 } })).instance,
    ).toEqual({
      vcpu: 1,
      memoryMib: 3072,
      diskMb: 20000,
    });
  });

  it.each([
    [{ instance: "basic" }, /instance basic is too small.*fix: set instance to standard-1/],
    [{ instance: "lite" }, /instance lite is too small/],
    [{ instance: "standard-9" }, /unknown instance/],
    [{ instance: { vcpu: 2, memoryMib: 4096, diskMb: 20000 } }, /below 3 GiB per vCPU/],
    [{ instance: { vcpu: 5, memoryMib: 12288, diskMb: 20000 } }, /instance.vcpu must be/],
    [{ instance: { vcpu: 4, memoryMib: 16384, diskMb: 20000 } }, /instance.memoryMib must be/],
    [{ instance: { vcpu: 2, memoryMib: 6144, diskMb: 30000 } }, /instance.diskMb must be/],
    [{ instance: { vcpu: 2, memoryMib: 6144, diskMb: 4000 } }, /instance.diskMb must be/],
    [{ maxRunning: 0 }, /maxRunning must be an integer from 1/],
    [{ maxRunning: 2.5 }, /maxRunning/],
    [{ checkpointMinutes: 5 }, /checkpointMinutes must be 0 \(off\) or at least 15/],
    [{ warmMinutes: -1 }, /warmMinutes must be an integer from 0 to 120/],
    [{ warmMinutes: 121 }, /warmMinutes must be an integer from 0 to 120/],
    [{ warmMinutes: 2.5 }, /warmMinutes must be an integer/],
    [{ alarmSeconds: 1200 }, /alarmSeconds 1200 must be shorter/],
    [{ images: { "ghcr.io/x/y": "Bad Key" } }, /images\[/],
    [{ ampImageDigest: "latest" }, /ampImageDigest/],
  ])("rejects %j", (cfg, re) => {
    expect(() => parseConfig(JSON.stringify(cfg))).toThrow(re);
    try {
      parseConfig(JSON.stringify(cfg));
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/^Failed: .+ — fix: .+$/);
      expect(msg).not.toContain("\n");
    }
  });

  it("rejects bad JSON with fix text", () => {
    expect(() => parseConfig("{nope")).toThrow(
      "Failed: CF_ORBS_CONFIG is not valid JSON — fix: run cf-orbs deploy to regenerate it",
    );
    expect(() => parseConfig("[]")).toThrow(/must be a JSON object/);
  });
});

describe("Registry DO", () => {
  class FakeStorage {
    kv = new MemoryKV();
    alarm: number | null = null;
    async get(k: string) {
      return this.kv.get(k);
    }
    async put(k: string, v: unknown) {
      return this.kv.put(k, v);
    }
    async delete(k: string) {
      return this.kv.delete(k);
    }
    async list({ prefix }: { prefix: string }) {
      return this.kv.list(prefix);
    }
    async getAlarm() {
      return this.alarm;
    }
    async setAlarm(t: number) {
      this.alarm = t;
    }
  }
  function makeCtx() {
    const storage = new FakeStorage();
    const pending: Promise<unknown>[] = [];
    const ctx = { storage, blockConcurrencyWhile: (fn: () => Promise<unknown>) => pending.push(fn()) };
    return { ctx, storage, ready: () => Promise.all(pending) };
  }

  it("arms a daily alarm, serves RPC, and re-arms after gc", async () => {
    const { Registry, REGISTRY_GC_INTERVAL_MS } = await import("../src/registry");
    const { ctx, storage, ready } = makeCtx();
    const reg = new Registry(ctx as any, { CF_ORBS_CONFIG: JSON.stringify({ maxRunning: 1 }) } as any);
    await ready();
    expect(storage.alarm).toBeGreaterThan(Date.now() + REGISTRY_GC_INTERVAL_MS - 5000);
    expect((await reg.acquireRunSlot("amp-T-1")).ok).toBe(true);
    expect((await reg.acquireRunSlot("amp-T-2")).error).toMatch(/^Failed: 1\/1 orbs already running/);
    const old = new Date(Date.now() - 31 * 24 * H).toISOString();
    await reg.recordSnapshot(handle("gone", old), "amp-T-1");
    storage.alarm = null;
    await reg.alarm();
    expect(await storage.kv.get("snap:gone")).toBeUndefined();
    expect(storage.alarm).not.toBeNull();
    expect((await reg.status()).running).toEqual(["amp-T-1"]);
  });

  it("bad config fails the RPC with fix text; alarm still re-arms", async () => {
    const { Registry } = await import("../src/registry");
    const { ctx, storage, ready } = makeCtx();
    const reg = new Registry(ctx as any, { CF_ORBS_CONFIG: JSON.stringify({ maxRunning: -1 }) } as any);
    await ready();
    await expect(reg.status()).rejects.toThrow(/^Failed: maxRunning/);
    storage.alarm = null;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await reg.alarm();
    err.mockRestore();
    expect(storage.alarm).not.toBeNull();
  });
});
