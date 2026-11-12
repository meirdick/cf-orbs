import { describe, expect, it } from "vitest";
import type { OpRequest, OrbRecord } from "../src/core/types";
import { ExclusiveQueue } from "../src/orb/exclusive";
import { finishOp, openOp } from "../src/orb/journal";
import { runPause } from "../src/orb/pause";
import { QUIESCE_SH } from "../src/orb/scripts";
import { runSpawn } from "../src/orb/spawn";
import { makeOrbCtx, type OrbHarness } from "./fake-registry";

const spawnReq: OpRequest = { op: "spawn", token: "tok-123456" };
const orb = async (h: OrbHarness) => (await h.kv.get<OrbRecord>("orb"))!;

async function awake(opts: Parameters<typeof makeOrbCtx>[0] = {}) {
  const h = makeOrbCtx(opts);
  expect(await runSpawn(h.newOp(), spawnReq)).toMatchObject({ ok: true });
  h.fake.disk["/home/user/repo/x"] = "data";
  return h;
}

function failSnapshots(h: OrbHarness, n: number) {
  const orig = h.fake.snapshot.bind(h.fake);
  let left = n;
  h.fake.snapshot = async (name: string) => {
    if (left-- > 0) throw new Error("snapshot busy");
    return orig(name);
  };
}

describe("runPause (D14)", () => {
  it("happy path: quiesce, snapshot, handle + index + project map, destroy, slot released", async () => {
    const h = await awake({ config: { instance: "standard-2" } });
    const r = await runPause(h.newOp(), { op: "pause", snapshotId: "snap-proj-1" });
    expect(r.ok).toBe(true);
    const rec = await orb(h);
    expect(rec.state).toBe("paused");
    expect(rec.handle).toMatchObject({
      id: r.handle!.id,
      imageKey: "orb",
      imageRef: "registry.cloudflare.com/acct/cf-orbs-orb@sha256:deadbeef",
      instance: "standard-2",
    });
    expect(rec.handle!.size).toBeGreaterThan(0);
    expect(rec.handle!.createdAt).toBe(new Date(h.clock.now()).toISOString());
    expect(rec.awakeSince).toBeUndefined();
    expect(rec.lastStop?.reason).toBe("paused by Amp");
    expect(h.registry.snapshots.map((s) => s.handle.id)).toEqual([r.handle!.id]);
    expect(h.registry.projects.get("snap-proj-1")).toMatchObject({
      sourceOrbId: "amp-T-test",
      handle: { id: r.handle!.id, imageRef: "registry.cloudflare.com/acct/cf-orbs-orb@sha256:deadbeef" },
      imageRef: "registry.cloudflare.com/acct/cf-orbs-orb@sha256:deadbeef",
    });
    expect(h.fake.running).toBe(false);
    expect(h.registry.slots.size).toBe(0);
    // quiesce ran before the snapshot and stopped the bootstrap
    expect(h.fake.execLog.some((c) => c[2] === QUIESCE_SH)).toBe(true);
    expect(h.sim.aliveBoot).toBeUndefined();
  });

  it("without ORB_SNAPSHOT_ID no project map is written", async () => {
    const h = await awake();
    await runPause(h.newOp(), { op: "pause" });
    expect(h.registry.projects.size).toBe(0);
  });

  it("snapshot fails 3x then succeeds", async () => {
    const h = await awake();
    failSnapshots(h, 3);
    const r = await runPause(h.newOp(), { op: "pause" });
    expect(r.ok).toBe(true);
    expect(h.lines.filter((l) => /snapshot attempt \d failed: snapshot busy/.test(l))).toHaveLength(3);
    expect((await orb(h)).state).toBe("paused");
  });

  it("final snapshot failure keeps the instance running and fails the op before the deadline", async () => {
    const h = await awake();
    failSnapshots(h, 1_000);
    const ctx = h.newOp();
    const r = await runPause(ctx, { op: "pause", snapshotId: "snap-p" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(
      /^Failed: snapshot failed after \d+ attempts \(snapshot busy\); orb left running — fix: /,
    );
    expect(h.fake.running).toBe(true);
    const rec = await orb(h);
    expect(rec.state).toBe("awake");
    expect(rec.handle).toBeUndefined();
    expect(h.registry.projects.size).toBe(0);
    expect(h.registry.slots.size).toBe(1);
    expect(h.clock.now()).toBeLessThanOrEqual(ctx.deadline - 30_000);
  });

  it("stopped container → paused-stale no-op success", async () => {
    const h = await awake();
    h.fake.platformStop();
    const r = await runPause(h.newOp(), { op: "pause" });
    expect(r).toEqual({ ok: true });
    expect((await orb(h)).state).toBe("paused-stale");
    expect(h.fake.snapshotCount).toBe(0);
    expect(h.registry.slots.size).toBe(0);
  });

  it("stopped container + ORB_SNAPSHOT_ID → fail, no map, never aliases an older handle", async () => {
    const h = await awake();
    await runPause(h.newOp(), { op: "pause" }); // older per-orb handle exists
    const r = await runPause(h.newOp(), { op: "pause", snapshotId: "snap-p" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^Failed: orb not running, project snapshot not saved — fix: /);
    expect(h.registry.projects.size).toBe(0);
  });

  it("replay while pausing → same op; one snapshot", async () => {
    const h = await awake();
    const req: OpRequest = { op: "pause", snapshotId: "snap-p" };
    const now = new Date(h.clock.now()).toISOString();
    const q = new ExclusiveQueue();
    const first = await openOp(h.kv, "amp-T-test", req, now);
    const run = q.run(() => runPause(h.newOp(), req));
    const replay = await openOp(h.kv, "amp-T-test", req, now);
    expect(replay.attached).toBe(true);
    expect(replay.record.opId).toBe(first.record.opId);
    const r = await run;
    await finishOp(h.kv, first.record.opId, "succeeded", {});
    expect(r.ok).toBe(true);
    expect(h.fake.snapshotCount).toBe(1);
  });

  it("a late replay after the pause finished is a no-op that keeps state paused", async () => {
    const h = await awake();
    await runPause(h.newOp(), { op: "pause" });
    const r = await runPause(h.newOp(), { op: "pause" });
    expect(r).toEqual({ ok: true });
    expect((await orb(h)).state).toBe("paused");
    expect(h.fake.snapshotCount).toBe(1);
  });

  it("a late replay of a pause with ORB_SNAPSHOT_ID that already succeeded is ok, same handle", async () => {
    const h = await awake();
    const req: OpRequest = { op: "pause", snapshotId: "snap-p" };
    const first = await runPause(h.newOp(), req);
    expect(first.ok).toBe(true);
    const again = await runPause(h.newOp(), req);
    expect(again).toEqual({ ok: true, handle: first.handle });
    expect((await orb(h)).state).toBe("paused");
    expect(h.fake.snapshotCount).toBe(1);
    // A different project snapshot id was never saved: still a failure.
    const other = await runPause(h.newOp(), { op: "pause", snapshotId: "snap-q" });
    expect(other.ok).toBe(false);
  });

  it("a slow failed snapshot is not retried when a second attempt cannot finish before the reserve", async () => {
    const h = await awake();
    const ctx = h.newOp();
    h.fake.snapshot = async () => {
      await h.clock.sleep(150_000);
      throw new Error("snapshot slow");
    };
    const r = await runPause(ctx, { op: "pause" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/after 1 attempts/);
    expect(h.clock.now()).toBeLessThanOrEqual(ctx.deadline - 30_000);
  });

  it("pause of an orb that never ran is a no-op success", async () => {
    const h = makeOrbCtx();
    expect(await runPause(h.ctx, { op: "pause" })).toEqual({ ok: true });
  });
});
