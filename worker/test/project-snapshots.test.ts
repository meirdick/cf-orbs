import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/api";
import { RegistryCore } from "../src/core/registry-core";
import {
  DEFAULT_CONFIG,
  PROJECT_MAP_TTL_MS,
  type ProjectSnapshotMapping,
  SNAPSHOT_TTL_MS,
  type SnapshotHandle,
} from "../src/core/types";
import type { Env } from "../src/env";
import { FakeClock, MemoryKV } from "./fake-container";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));

const H = 3600_000;

function handle(id: string, createdAt: string, size = 194_000_000): SnapshotHandle {
  return { id, size, imageKey: "orb", instance: DEFAULT_CONFIG.instance, createdAt };
}

function mapping(snapshotId: string, h: SnapshotHandle, lastUsedAt = h.createdAt): ProjectSnapshotMapping {
  return { snapshotId, handle: h, sourceOrbId: "amp-T-1", createdAt: h.createdAt, lastUsedAt };
}

describe("RegistryCore listProjectSnapshots / forgetProjectSnapshot", () => {
  let kv: MemoryKV;
  let clock: FakeClock;
  let reg: RegistryCore;
  beforeEach(() => {
    kv = new MemoryKV();
    clock = new FakeClock();
    reg = new RegistryCore(kv, clock, { maxRunning: 20, alarmSeconds: 60 });
  });

  it("is empty with no mappings", async () => {
    expect(await reg.listProjectSnapshots()).toEqual([]);
  });

  it("lists mappings newest use first, with expiry = min(lastUsed + 72 h, handle expiry)", async () => {
    const t0 = new Date(clock.now()).toISOString();
    await reg.putProjectSnapshot(mapping("snap-a", handle("cf-a", t0)));
    clock.advance(2 * H);
    const t1 = new Date(clock.now()).toISOString();
    await reg.putProjectSnapshot(mapping("snap-b", handle("cf-b", t1)));
    clock.advance(H);
    const rows = await reg.listProjectSnapshots();
    expect(rows.map((r) => r.snapshotId)).toEqual(["snap-b", "snap-a"]);
    expect(rows[1]).toMatchObject({
      snapshotId: "snap-a",
      handle: { id: "cf-a", size: 194_000_000 },
      sourceOrbId: "amp-T-1",
      expiresAt: new Date(Date.parse(t0) + PROJECT_MAP_TTL_MS).toISOString(),
      expired: false,
    });
  });

  it("a mapping whose handle expires before 72 h unused shows the handle expiry", async () => {
    const old = new Date(clock.now() - SNAPSHOT_TTL_MS + H).toISOString();
    const now = new Date(clock.now()).toISOString();
    await reg.putProjectSnapshot(mapping("snap-old", handle("cf-old", old), now));
    const [row] = await reg.listProjectSnapshots();
    expect(row?.expiresAt).toBe(new Date(Date.parse(old) + SNAPSHOT_TTL_MS).toISOString());
    expect(row?.expired).toBe(false);
  });

  it("shows unused-for-72-h mappings as expired until GC drops them, like getProjectSnapshot", async () => {
    const t0 = new Date(clock.now()).toISOString();
    await reg.putProjectSnapshot(mapping("snap-a", handle("cf-a", t0)));
    clock.advance(PROJECT_MAP_TTL_MS + 1);
    expect(await reg.getProjectSnapshot("snap-a")).toBeUndefined();
    expect((await reg.listProjectSnapshots())[0]?.expired).toBe(true);
    await reg.gc(new Date(clock.now()).toISOString());
    expect(await reg.listProjectSnapshots()).toEqual([]);
  });

  it("forget drops the mapping, keeps the snapshot index, and says whether it was there", async () => {
    const t0 = new Date(clock.now()).toISOString();
    await reg.putProjectSnapshot(mapping("snap-a", handle("cf-a", t0)));
    expect(await reg.forgetProjectSnapshot("snap-a")).toBe(true);
    expect(await reg.getProjectSnapshot("snap-a")).toBeUndefined();
    expect(await reg.listProjectSnapshots()).toEqual([]);
    expect((await reg.listSnapshots()).map((s) => s.handle.id)).toEqual(["cf-a"]);
    expect(await reg.forgetProjectSnapshot("snap-a")).toBe(false);
    expect(await reg.forgetProjectSnapshot("never")).toBe(false);
  });
});

type Call = { name: string; method: string; args: unknown[] };

function fakeEnv(behave: Record<string, (...a: unknown[]) => unknown> = {}, over: Partial<Env> = {}) {
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
                return f ? f(...args) : { method };
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

describe("/v1/project-snapshots routes", () => {
  it("GET returns the Registry mappings and the snapshot index summary", async () => {
    const rows = [{ snapshotId: "snap-a", handle: { id: "cf-a" } }];
    const summary = { projectSnapshots: 1, retainedSnapshots: 2, retainedSnapshotBytes: 5, running: [] };
    const { env, calls } = fakeEnv({
      "REGISTRY.listProjectSnapshots": () => rows,
      "REGISTRY.status": () => summary,
    });
    const r = await handleApi(req("/v1/project-snapshots", { headers: auth }), env, { internal: false });
    expect(r.status).toBe(200);
    expect(await body(r)).toEqual({ projectSnapshots: rows, summary });
    expect(calls.map((c) => `${c.name} ${c.method}`).sort()).toEqual([
      "REGISTRY/registry listProjectSnapshots",
      "REGISTRY/registry status",
    ]);
  });

  it("DELETE forgets one decoded id and reports whether it was there", async () => {
    const { env, calls } = fakeEnv({ "REGISTRY.forgetProjectSnapshot": (id) => id === "snap-f3:1" });
    const r = await handleApi(
      req("/v1/project-snapshots/snap-f3%3A1", { method: "DELETE", headers: auth }),
      env,
      { internal: false },
    );
    expect(r.status).toBe(200);
    expect(await body(r)).toEqual({ snapshotId: "snap-f3:1", forgotten: true });
    expect(calls).toEqual([
      { name: "REGISTRY/registry", method: "forgetProjectSnapshot", args: ["snap-f3:1"] },
    ]);
    const r2 = await handleApi(req("/v1/project-snapshots/nope", { method: "DELETE", headers: auth }), env, {
      internal: false,
    });
    expect(await body(r2)).toEqual({ snapshotId: "nope", forgotten: false });
  });

  it("needs the bearer token and is 404 when CONTROL_TOKEN is unset", async () => {
    const { env, calls } = fakeEnv();
    expect((await handleApi(req("/v1/project-snapshots"), env, { internal: false })).status).toBe(401);
    const del = req("/v1/project-snapshots/snap-a", { method: "DELETE" });
    expect((await handleApi(del, env, { internal: false })).status).toBe(401);
    const off = fakeEnv({}, { CONTROL_TOKEN: undefined });
    const r = await handleApi(req("/v1/project-snapshots", { headers: auth }), off.env, { internal: false });
    expect(r.status).toBe(404);
    expect([...calls, ...off.calls]).toEqual([]);
  });

  it("wrong methods are 405; bad ids are 400 with fix text; neither reaches the Registry", async () => {
    const { env, calls } = fakeEnv();
    const post = await handleApi(req("/v1/project-snapshots", { method: "POST", headers: auth }), env, {
      internal: false,
    });
    expect(post.status).toBe(405);
    const get1 = await handleApi(req("/v1/project-snapshots/snap-a", { headers: auth }), env, {
      internal: false,
    });
    expect(get1.status).toBe(405);
    for (const bad of ["%E0%A4%A", "a%0Ab", "a%2Fb", "x".repeat(257)]) {
      const r = await handleApi(
        req(`/v1/project-snapshots/${bad}`, { method: "DELETE", headers: auth }),
        env,
        {
          internal: false,
        },
      );
      expect(r.status).toBe(400);
      expect((await body(r)).error).toMatch(
        /^Failed: invalid project snapshot id .* — fix: pass the Amp snapshot id from cf-orbs snapshots list$/,
      );
    }
    const deep = await handleApi(req("/v1/project-snapshots/a/b", { method: "DELETE", headers: auth }), env, {
      internal: false,
    });
    expect(deep.status).toBe(404);
    expect(calls).toEqual([]);
  });
});
