import { describe, expect, it } from "vitest";
import type { OpRequest, OrbRecord } from "../src/core/types";
import { runDelete } from "../src/orb/delete";
import { ExclusiveQueue } from "../src/orb/exclusive";
import { appendProgress, finishOp, type Handle, openOp } from "../src/orb/journal";
import { runPause } from "../src/orb/pause";
import { BOOTSTRAP_SH, WAIT_CONNECTED_SH } from "../src/orb/scripts";
import { runSpawn, waitReady } from "../src/orb/spawn";
import { makeOrbCtx, type OrbHarness } from "./fake-registry";

const TOKEN = "eyJhbGciOi.test.sig";
const spawnReq = (o: Partial<OpRequest> = {}): OpRequest => ({ op: "spawn", token: TOKEN, ...o });
const orb = async (h: OrbHarness) => (await h.kv.get<OrbRecord>("orb"))!;
const DAY = 24 * 3600_000;

/** spawn then pause: leaves a per-orb handle and a stopped container */
async function pausedOrb(h: OrbHarness, files: Record<string, string> = { "/home/user/repo/a": "1" }) {
  expect(await runSpawn(h.newOp(), spawnReq())).toMatchObject({ ok: true });
  Object.assign(h.fake.disk, files);
  expect(await runPause(h.newOp(), { op: "pause" })).toMatchObject({ ok: true });
  return (await orb(h)).handle as Handle;
}

describe("runSpawn (D6-D10)", () => {
  it("fresh orb boots the image, launches bootstrap and waits for the connected marker", async () => {
    const h = makeOrbCtx({ config: { inactivityTimeoutMinutes: 15 } });
    const r = await runSpawn(h.ctx, spawnReq({ ampUrl: "https://ampcode.com" }));
    expect(r).toMatchObject({ ok: true, source: "image" });
    const s = h.fake.startedWith!;
    expect(s.source).toEqual({ image: h.fake.images().orb });
    expect(s.enableInternet).toBe(true);
    expect(s.labels).toEqual({ orb: "amp-T-test" });
    expect(s.instance).toEqual(h.ctx.config.instance);
    expect(h.fake.inactivityTimeoutMs).toBe(15 * 60_000);
    expect(h.registry.slots.has("amp-T-test")).toBe(true);
    const env = h.sim.bootEnvs[0]!;
    expect(env).toMatchObject({
      ORB_TOKEN: TOKEN,
      HOME: "/home/user",
      USER: "user",
      LANG: "C.UTF-8",
      AMP_URL: "https://ampcode.com",
    });
    expect(env.ORB_TOKEN_SHA).toMatch(/^[0-9a-f]{16}$/);
    // Defaults: huge pages on, no tmpfs.
    expect(env).toMatchObject({ HUGE_PAGES: "1", FAST_TMPFS_GB: "0" });
    const rec = await orb(h);
    expect(rec).toMatchObject({
      state: "awake",
      lastWakeSource: "image",
      imageKey: "orb",
      bootstrapTokenSha: env.ORB_TOKEN_SHA,
    });
    expect(rec.awakeSince).toBeDefined();
    expect(rec.dirtySince).toBeDefined();
    expect(rec.lastSpawnMs).toBeGreaterThanOrEqual(0);
    expect(h.lines.some((l) => /orb ready: connected/.test(l))).toBe(true);
  });

  it("passes hugePages and fastTmpfsGb from the config to the bootstrap env", async () => {
    const h = makeOrbCtx({ config: { hugePages: false, fastTmpfsGb: 4 } });
    expect(await runSpawn(h.ctx, spawnReq())).toMatchObject({ ok: true });
    expect(h.sim.bootEnvs[0]).toMatchObject({ HUGE_PAGES: "0", FAST_TMPFS_GB: "4" });
  });

  it("spawn history: image start, then a per-orb restore; a cold start stays visible", async () => {
    const h = makeOrbCtx();
    await pausedOrb(h);
    expect(await runSpawn(h.newOp(), spawnReq())).toMatchObject({ ok: true, source: "per-orb-snapshot" });
    const rec = await orb(h);
    expect(rec.lastWakeSource).toBe("per-orb-snapshot");
    expect(rec.spawns?.map((s) => [s.source, s.ok])).toEqual([
      ["image", true],
      ["per-orb-snapshot", true],
    ]);
    expect(rec.spawns?.at(-1)?.ms).toBe(rec.lastSpawnMs);
    expect(rec.spawns?.every((s) => /^\d{4}-\d\d-\d\dT/.test(s.at))).toBe(true);
  });

  it("spawn history: failures are kept with source and a redacted error; last 10 only", async () => {
    const h = makeOrbCtx();
    h.sim.rejectToken = true;
    h.sim.leakToken = true;
    expect((await runSpawn(h.newOp(), spawnReq())).ok).toBe(false);
    const first = (await orb(h)).spawns ?? [];
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ ok: false, source: "image" });
    expect(first[0]?.error).toMatch(/^Failed: amp orb bootstrap did not start/);
    expect(JSON.stringify(first)).not.toContain(TOKEN);
    h.sim.rejectToken = false;
    h.sim.leakToken = false;
    for (let i = 0; i < 11; i++) await runSpawn(h.newOp(), spawnReq({ token: `tok-${i}` }));
    const all = (await orb(h)).spawns ?? [];
    expect(all).toHaveLength(10);
    expect(all.every((s) => s.ok && s.source === "running")).toBe(true);
  });

  it("spawn history: no entry when the spawn fails before an orb record exists", async () => {
    const h = makeOrbCtx({ maxRunning: 1 });
    await h.registry.acquireRunSlot("someone-else");
    expect((await runSpawn(h.ctx, spawnReq())).ok).toBe(false);
    expect(await h.kv.get("orb")).toBeUndefined();
  });

  it("omits AMP_URL when unset", async () => {
    const h = makeOrbCtx();
    await runSpawn(h.ctx, spawnReq());
    expect(h.sim.bootEnvs[0]).not.toHaveProperty("AMP_URL");
  });

  it("running container → reuse, new bootstrap for a new token", async () => {
    const h = makeOrbCtx();
    await runSpawn(h.newOp(), spawnReq());
    const firstSince = (await orb(h)).awakeSince;
    h.clock.advance(60_000);
    const r = await runSpawn(h.newOp(), spawnReq({ token: "second-token" }));
    expect(r).toMatchObject({ ok: true, source: "running", wakeMs: 0 });
    expect(h.fake.startCount).toBe(1);
    expect(h.sim.launches).toBe(2);
    const rec = await orb(h);
    expect(rec.bootstrapTokenSha).toBe(h.sim.bootEnvs[1]!.ORB_TOKEN_SHA);
    expect(rec.awakeSince).toBe(firstSince); // maxAwakeHours counts from the first wake
  });

  it("retried spawn with the same token does not launch a second bootstrap", async () => {
    const h = makeOrbCtx();
    await runSpawn(h.newOp(), spawnReq());
    await runSpawn(h.newOp(), spawnReq());
    expect(h.sim.launches).toBe(1);
  });

  it("bootstrap saw the connect: no second connected check; a retry still runs it", async () => {
    const h = makeOrbCtx();
    h.sim.bootSeesConnect = true;
    const waits = () => h.fake.execLog.filter((c) => c[2] === WAIT_CONNECTED_SH).length;
    expect(await runSpawn(h.newOp(), spawnReq())).toMatchObject({ ok: true });
    expect(waits()).toBe(0);
    expect(h.lines.some((l) => /orb ready: connected to Amp in 0\.4 s/.test(l))).toBe(true);
    // Same token again: "bootstrap already running" has no timing line, so spawn checks the connect.
    expect(await runSpawn(h.newOp(), spawnReq())).toMatchObject({ ok: true });
    expect(waits()).toBe(1);
    expect(h.sim.launches).toBe(1);
  });

  it("bootstrap still waiting: spawn runs the connected check", async () => {
    const h = makeOrbCtx();
    h.sim.bootSeesConnect = true;
    h.sim.connects = false;
    const r = await runSpawn(h.newOp(), spawnReq());
    expect(!r.ok && r.error).toMatch(/did not connect/);
    expect(h.fake.execLog.some((c) => c[2] === WAIT_CONNECTED_SH)).toBe(true);
  });

  it("readiness probe retries after 0.1, 0.2, 0.4, 0.8 s, then every 1 s", async () => {
    const h = makeOrbCtx();
    h.fake.readyAfterMs = 2_000;
    const t0 = h.clock.now();
    h.fake.start({ source: { image: "img" }, instance: h.ctx.config.instance, enableInternet: true });
    const r = await waitReady(h.newOp());
    expect(r.kind).toBe("ready");
    // Probes at 0, 0.1, 0.3, 0.7, 1.5, 2.5 s: the first one at or after 2 s.
    expect(h.clock.now() - t0).toBe(2_500);
    expect(h.fake.execLog.filter((c) => c[0] === "true")).toHaveLength(1);
  });

  it("per-orb handle beats ORB_SNAPSHOT_ID", async () => {
    const h = makeOrbCtx();
    const handle = await pausedOrb(h);
    await h.registry.putProjectSnapshot({
      snapshotId: "snap-proj",
      handle: { ...handle, id: "other" },
      sourceOrbId: "x",
      createdAt: handle.createdAt,
      lastUsedAt: handle.createdAt,
    });
    const r = await runSpawn(h.newOp(), spawnReq({ snapshotId: "snap-proj" }));
    expect(r).toMatchObject({ ok: true, source: "per-orb-snapshot" });
    expect(h.fake.startedWith!.source).toEqual({ snapshotId: handle.id });
    expect(h.fake.disk["/home/user/repo/a"]).toBe("1");
    expect(h.lines.some((l) => /ignoring ORB_SNAPSHOT_ID snap-proj/.test(l))).toBe(true);
    expect(h.registry.calls).not.toContain("get snap-proj");
  });

  it("successful restore sets lastRestoredAt", async () => {
    const h = makeOrbCtx();
    await pausedOrb(h);
    h.clock.advance(DAY);
    await runSpawn(h.newOp(), spawnReq());
    expect((await orb(h)).handle).toMatchObject({ lastRestoredAt: new Date(h.clock.now()).toISOString() });
  });

  it("per-orb restore re-indexes the handle so Registry GC sees the new lastRestoredAt", async () => {
    const h = makeOrbCtx();
    await pausedOrb(h);
    h.clock.advance(DAY);
    await runSpawn(h.newOp(), spawnReq());
    const last = h.registry.snapshots.at(-1)!;
    expect(last.handle.lastRestoredAt).toBe(new Date(h.clock.now()).toISOString());
  });

  it("a Registry error after a good project restore is not fatal", async () => {
    const h = makeOrbCtx();
    h.fake.start({ source: { image: h.fake.images().orb! }, instance: "standard-1", enableInternet: true });
    const snap = await h.fake.snapshot("proj");
    await h.fake.destroy();
    const created = new Date(h.clock.now()).toISOString();
    await h.registry.putProjectSnapshot({
      snapshotId: "snap-proj",
      handle: { id: snap.id, size: snap.size, imageKey: "orb", instance: "standard-1", createdAt: created },
      sourceOrbId: "amp-T-other",
      createdAt: created,
      lastUsedAt: created,
    });
    h.registry.touchProjectSnapshot = async () => {
      throw new Error("registry overloaded");
    };
    const r = await runSpawn(h.newOp(), spawnReq({ snapshotId: "snap-proj" }));
    expect(r).toMatchObject({ ok: true, source: "project-snapshot" });
    expect(h.fake.running).toBe(true);
    expect(
      h.lines.some((l) => /project snapshot touch failed \(not fatal\): registry overloaded/.test(l)),
    ).toBe(true);
  });

  it("project restore when the orb has no record", async () => {
    const h = makeOrbCtx();
    h.fake.start({ source: { image: h.fake.images().orb! }, instance: "standard-1", enableInternet: true });
    h.fake.disk["/home/user/repo/setup-done"] = "yes";
    const snap = await h.fake.snapshot("proj");
    await h.fake.destroy();
    const created = new Date(h.clock.now()).toISOString();
    await h.registry.putProjectSnapshot({
      snapshotId: "snap-proj",
      handle: { id: snap.id, size: snap.size, imageKey: "orb", instance: "standard-1", createdAt: created },
      sourceOrbId: "amp-T-other",
      createdAt: created,
      lastUsedAt: created,
    });
    h.clock.advance(3600_000);
    const r = await runSpawn(h.newOp(), spawnReq({ snapshotId: "snap-proj" }));
    expect(r).toMatchObject({ ok: true, source: "project-snapshot" });
    expect(h.fake.disk["/home/user/repo/setup-done"]).toBe("yes");
    expect(h.registry.projects.get("snap-proj")!.lastUsedAt).toBe(new Date(h.clock.now()).toISOString());
    expect((await orb(h)).handle).toBeUndefined(); // the project handle is not this orb's own disk
  });

  it("unknown ORB_SNAPSHOT_ID boots the image with a line", async () => {
    const h = makeOrbCtx();
    const r = await runSpawn(h.ctx, spawnReq({ snapshotId: "snap-unknown" }));
    expect(r).toMatchObject({ ok: true, source: "image" });
    expect(h.lines.some((l) => /project snapshot snap-unknown is not known/.test(l))).toBe(true);
  });

  it("project snapshot not found → image fallback, line, mapping dropped", async () => {
    const h = makeOrbCtx();
    const now = new Date(h.clock.now()).toISOString();
    await h.registry.putProjectSnapshot({
      snapshotId: "snap-gone",
      handle: { id: "bogus-id", size: 1, imageKey: "orb", instance: "standard-1", createdAt: now },
      sourceOrbId: "x",
      createdAt: now,
      lastUsedAt: now,
    });
    const r = await runSpawn(h.ctx, spawnReq({ snapshotId: "snap-gone" }));
    expect(r).toMatchObject({ ok: true, source: "image" });
    expect(h.registry.projects.has("snap-gone")).toBe(false);
    expect(h.lines.some((l) => /project snapshot snap-gone was not found/.test(l))).toBe(true);
    expect(h.fake.startCount).toBe(2);
  });

  it("per-orb snapshot not found → image fallback, loud line, handle dropped", async () => {
    const h = makeOrbCtx();
    await pausedOrb(h);
    const rec = await orb(h);
    rec.handle!.id = "bogus-id";
    await h.kv.put("orb", rec);
    const r = await runSpawn(h.newOp(), spawnReq());
    expect(r).toMatchObject({ ok: true, source: "image" });
    expect((await orb(h)).handle).toBeUndefined();
    expect(h.lines.some((l) => /orb disk expired or lost; Amp will set up the repo again/.test(l))).toBe(
      true,
    );
  });

  it("readiness timeout → op failed, handle kept, slot released", async () => {
    const h = makeOrbCtx();
    const handle = await pausedOrb(h);
    h.fake.readyAfterMs = 200_000;
    const r = await runSpawn(h.newOp(), spawnReq());
    expect(r).toEqual({
      ok: false,
      error:
        "Failed: container did not become ready in 90 s — fix: retry the message; check cf-orbs status amp-T-test",
    });
    const rec = await orb(h);
    expect(rec.handle?.id).toBe(handle.id);
    expect(rec.state).toBe("paused");
    expect(h.fake.running).toBe(false);
    expect(h.registry.slots.size).toBe(0);
  });

  it("two concurrent spawns on a per-orb handle (serialized) → one start, no destroy, handle kept", async () => {
    const h = makeOrbCtx();
    const handle = await pausedOrb(h);
    const destroys = h.fake.destroyCount;
    const starts = h.fake.startCount;
    const q = new ExclusiveQueue();
    const ctx = h.newOp();
    const [a, b] = await Promise.all([
      q.run(() => runSpawn(ctx, spawnReq())),
      q.run(() => runSpawn(ctx, spawnReq())),
    ]);
    expect(a).toMatchObject({ ok: true, source: "per-orb-snapshot" });
    expect(b).toMatchObject({ ok: true, source: "running" });
    expect(h.fake.destroyCount).toBe(destroys);
    expect(h.fake.startCount).toBe(starts + 1);
    expect((await orb(h)).handle?.id).toBe(handle.id);
  });

  it("two concurrent spawns that race start() → loser waits, no destroy, handle kept", async () => {
    const h = makeOrbCtx();
    const handle = await pausedOrb(h);
    const destroys = h.fake.destroyCount;
    const ctx = h.newOp();
    const [a, b] = await Promise.all([runSpawn(ctx, spawnReq()), runSpawn(ctx, spawnReq())]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(h.fake.destroyCount).toBe(destroys);
    expect(h.fake.startCount).toBe(2); // pausedOrb's start + one restore
    expect(h.lines).toContain("container already starting from another job; waiting for it");
    const rec = await orb(h);
    expect(rec.handle?.id).toBe(handle.id);
    expect(rec.state).toBe("awake");
    expect(h.registry.slots.has("amp-T-test")).toBe(true);
  });

  it("expired handle skips restore (30 d from createdAt)", async () => {
    const h = makeOrbCtx();
    await pausedOrb(h);
    h.clock.advance(31 * DAY);
    const r = await runSpawn(h.newOp(), spawnReq());
    expect(r).toMatchObject({ ok: true, source: "image" });
    expect(h.fake.startCount).toBe(2);
    expect(h.lines.some((l) => /expired \(30 d\)/.test(l))).toBe(true);
  });

  it("handle restored recently is not expired (30 d from lastRestoredAt)", async () => {
    const h = makeOrbCtx();
    await pausedOrb(h);
    const rec = await orb(h);
    const old = new Date(h.clock.now() - 40 * DAY).toISOString();
    (rec.handle as Handle).createdAt = old;
    (rec.handle as Handle).lastRestoredAt = new Date(h.clock.now() - 5 * DAY).toISOString();
    await h.kv.put("orb", rec);
    expect(await runSpawn(h.newOp(), spawnReq())).toMatchObject({ ok: true, source: "per-orb-snapshot" });
  });

  it("slow start + fallback past the deadline → deadline error", async () => {
    const h = makeOrbCtx();
    await pausedOrb(h);
    const rec = await orb(h);
    rec.handle!.id = "bogus-id";
    await h.kv.put("orb", rec);
    h.fake.readyAfterMs = 120_000;
    const ctx = h.newOp();
    ctx.deadline = h.clock.now() + 60_000;
    const r = await runSpawn(ctx, spawnReq());
    expect(r).toEqual({
      ok: false,
      error:
        "Failed: spawn did not finish in 4 min 30 s — fix: retry the message; check cf-orbs status amp-T-test",
    });
    expect(h.clock.now()).toBeLessThanOrEqual(ctx.deadline);
    expect(h.lines.some((l) => /orb disk expired or lost/.test(l))).toBe(true); // fell back first
    expect(h.fake.startCount).toBe(3);
    expect(h.fake.running).toBe(false);
  });

  it("bootstrap dies (token rejected) → op failed with redacted log tail, instance kept for the watchdog", async () => {
    const h = makeOrbCtx();
    h.sim.rejectToken = true;
    h.sim.logLines = Array.from({ length: 60 }, (_, i) => `log ${i}`);
    const r = await runSpawn(h.ctx, spawnReq());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(
      /^Failed: amp orb bootstrap did not start \(exit 1: .*ORB_TOKEN was rejected.*\) — fix: /,
    );
    expect(h.lines).toContain("--- last 50 bootstrap log lines");
    expect(h.lines).toContain("log 59");
    expect(h.lines).not.toContain("log 9");
    expect(h.fake.running).toBe(true);
    expect((await orb(h)).state).toBe("awake");
    expect(h.registry.slots.has("amp-T-test")).toBe(true);
  });

  it("bootstrap exits before connecting → op failed", async () => {
    const h = makeOrbCtx();
    h.sim.diesBeforeConnect = true;
    const r = await runSpawn(h.ctx, spawnReq());
    expect(!r.ok && r.error).toMatch(/stopped before it connected \(bootstrap pid \d+ exited\)/);
  });

  it("bootstrap alive but never connects → fails within the deadline", async () => {
    const h = makeOrbCtx();
    h.sim.connects = false;
    const ctx = h.newOp();
    const r = await runSpawn(ctx, spawnReq());
    expect(!r.ok && r.error).toMatch(/^Failed: amp orb bootstrap did not connect in 180 s — fix: /);
    expect(h.clock.now()).toBeLessThanOrEqual(ctx.deadline);
    // The connect wait is split into execs of at most 60 s with a run-slot heartbeat after each.
    expect(h.registry.calls.filter((c) => c === "heartbeat amp-T-test").length).toBeGreaterThanOrEqual(4);
  });

  it("the token never reaches progress, op record, status or DO log", async () => {
    const h = makeOrbCtx();
    h.sim.rejectToken = true;
    h.sim.leakToken = true;
    h.sim.logLines = [`ORB_TOKEN=${TOKEN}`, "provider aop_live_abcDEF123", `Authorization: Bearer ${TOKEN}`];
    const { record } = await openOp(h.kv, "amp-T-test", spawnReq(), new Date(h.clock.now()).toISOString());
    h.ctx.say = (l) => {
      h.lines.push(l);
      void appendProgress(h.kv, record.opId, l);
    };
    const r = await runSpawn(h.ctx, spawnReq());
    await finishOp(h.kv, record.opId, r.ok ? "succeeded" : "failed", r.ok ? {} : { error: r.error });
    const everything = JSON.stringify([r, h.lines, [...h.kv.map]]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("aop_live_abcDEF123");
    expect(h.lines.length).toBeGreaterThan(3);
  });

  it("tombstone → fail", async () => {
    const h = makeOrbCtx();
    await runSpawn(h.newOp(), spawnReq());
    await runDelete(h.newOp());
    const r = await runSpawn(h.newOp(), spawnReq());
    expect(!r.ok && r.error).toMatch(/^Failed: orb was deleted at \d{4}-.* — fix: start a new thread$/);
    expect(h.fake.running).toBe(false);
  });

  it("maxRunning reached → fail before start, no slot", async () => {
    const h = makeOrbCtx({ maxRunning: 1 });
    await h.registry.acquireRunSlot("someone-else");
    const r = await runSpawn(h.ctx, spawnReq());
    expect(!r.ok && r.error).toMatch(/^Failed: 1\/1 orbs already running — fix: /);
    expect(h.fake.startCount).toBe(0);
  });

  it("unregistered ORB_IMAGE → fail with the D5 text", async () => {
    const h = makeOrbCtx();
    const r = await runSpawn(h.ctx, spawnReq({ image: "docker.io/me/x:1" }));
    expect(r).toEqual({
      ok: false,
      error:
        'Failed: image docker.io/me/x:1 is not registered — fix: add it to cf-orbs.config.jsonc "images" and run cf-orbs deploy',
    });
    expect(h.fake.startCount).toBe(0);
  });

  it("paused-stale restore warns that later changes are lost", async () => {
    const h = makeOrbCtx();
    await pausedOrb(h);
    await runSpawn(h.newOp(), spawnReq());
    h.fake.platformStop();
    await runPause(h.newOp(), { op: "pause" });
    expect((await orb(h)).state).toBe("paused-stale");
    await runSpawn(h.newOp(), spawnReq());
    expect(h.lines.some((l) => /changes after that are lost/.test(l))).toBe(true);
  });

  it("missing token → fail", async () => {
    const h = makeOrbCtx();
    const r = await runSpawn(h.ctx, { op: "spawn" });
    expect(!r.ok && r.error).toMatch(/^Failed: .*ORB_TOKEN — fix: /);
  });

  it("runs the bootstrap script by identity with bash -c", async () => {
    const h = makeOrbCtx();
    await runSpawn(h.ctx, spawnReq());
    expect(h.fake.execLog.some((c) => c[0] === "bash" && c[1] === "-c" && c[2] === BOOTSTRAP_SH)).toBe(true);
  });
});
