import { describe, expect, it } from "vitest";
import type { OpRequest, OrbRecord } from "../src/core/types";
import { runDelete } from "../src/orb/delete";
import { runPause } from "../src/orb/pause";
import { runSpawn } from "../src/orb/spawn";
import { makeOrbCtx, type OrbHarness } from "./fake-registry";

const spawnReq: OpRequest = { op: "spawn", token: "tok-123456" };
const orb = async (h: OrbHarness) => (await h.kv.get<OrbRecord>("orb"))!;

describe("runDelete (D13)", () => {
  it("destroys, drops the handle, keeps project maps, writes a tombstone, releases the slot", async () => {
    const h = makeOrbCtx();
    await runSpawn(h.newOp(), spawnReq);
    await runPause(h.newOp(), { op: "pause", snapshotId: "snap-p" });
    await runSpawn(h.newOp(), spawnReq);
    expect(h.fake.running).toBe(true);
    expect(await runDelete(h.newOp())).toEqual({ ok: true });
    const rec = await orb(h);
    expect(h.fake.running).toBe(false);
    expect(rec.state).toBe("deleted");
    expect(rec.handle).toBeUndefined();
    expect(rec.deletedAt).toBe(new Date(h.clock.now()).toISOString());
    expect(h.registry.projects.has("snap-p")).toBe(true);
    expect(h.registry.slots.size).toBe(0);
  });

  it("delete twice is ok and keeps the first tombstone", async () => {
    const h = makeOrbCtx();
    await runSpawn(h.newOp(), spawnReq);
    await runDelete(h.newOp());
    const at = (await orb(h)).deletedAt;
    h.clock.advance(60_000);
    expect(await runDelete(h.newOp())).toEqual({ ok: true });
    expect((await orb(h)).deletedAt).toBe(at);
    expect(h.fake.destroyCount).toBe(1);
  });

  it("spawn after delete fails", async () => {
    const h = makeOrbCtx();
    await runDelete(h.ctx);
    const r = await runSpawn(h.newOp(), spawnReq);
    expect(!r.ok && r.error).toMatch(/^Failed: orb was deleted at /);
  });

  it("spawn after the 7 d tombstone expires starts a new orb", async () => {
    const h = makeOrbCtx();
    await runDelete(h.ctx);
    h.clock.advance(8 * 24 * 3600_000);
    expect(await runSpawn(h.newOp(), spawnReq)).toMatchObject({ ok: true, source: "image" });
  });

  it("pause after delete is a no-op success", async () => {
    const h = makeOrbCtx();
    await runSpawn(h.newOp(), spawnReq);
    await runDelete(h.newOp());
    expect(await runPause(h.newOp(), { op: "pause", snapshotId: "snap-p" })).toEqual({ ok: true });
    expect(h.fake.snapshotCount).toBe(0);
    expect((await orb(h)).state).toBe("deleted");
  });

  it("delete of a partial orb (never spawned) is ok", async () => {
    const h = makeOrbCtx();
    expect(await runDelete(h.ctx)).toEqual({ ok: true });
    expect((await orb(h)).state).toBe("deleted");
  });
});
