// Warm pause (warmMinutes): pause → warm → spawn reuses amp, or alarm → paused.
import { describe, expect, it } from "vitest";
import type { OpRequest, OrbRecord, ProviderConfig } from "../src/core/types";
import { runAlarm } from "../src/orb/alarm";
import { runDelete } from "../src/orb/delete";
import { ACTIVITY_KEY, type Handle, handleExpiresAt } from "../src/orb/journal";
import { runPause } from "../src/orb/pause";
import { BOOTSTRAP_SH, QUIESCE_SH, RESUME_SH, SCRUB_SH } from "../src/orb/scripts";
import { PREFETCH_CMD, runSpawn } from "../src/orb/spawn";
import { makeOrbCtx, type OrbHarness, STATE_FILE } from "./fake-registry";

const MIN = 60_000;
const DAY = 24 * 3600_000;
const spawnReq = (token = "tok-first-123456"): OpRequest => ({ op: "spawn", token });
const orb = async (h: OrbHarness) => (await h.kv.get<OrbRecord>("orb"))!;
const ran = (h: OrbHarness, script: string) => h.fake.execLog.filter((c) => c[2] === script).length;

async function awake(config: Partial<ProviderConfig> = {}) {
  const h = makeOrbCtx({ config: { warmMinutes: 10, alarmSeconds: 60, ...config } });
  expect(await runSpawn(h.newOp(), spawnReq())).toMatchObject({ ok: true, source: "image" });
  h.fake.disk["/home/user/repo/x"] = "data";
  return h;
}

async function warm(config: Partial<ProviderConfig> = {}) {
  const h = await awake(config);
  const r = await runPause(h.newOp(), { op: "pause" });
  expect(r.ok).toBe(true);
  return h;
}

describe("warm pause", () => {
  it("snapshots without quiesce, keeps the container and amp, holds the run slot", async () => {
    const h = await awake();
    const since = (await orb(h)).awakeSince;
    h.sim.activity = 42;
    const r = await runPause(h.newOp(), { op: "pause" });
    expect(r.ok).toBe(true);
    const rec = await orb(h);
    expect(rec.state).toBe("warm");
    expect(rec.warmUntil).toBe(new Date(h.clock.now() + 10 * MIN).toISOString());
    expect(rec.handle?.id).toBe(r.handle?.id);
    expect(rec.awakeSince).toBe(since);
    expect(rec.dirtySince).toBeUndefined();
    expect(rec.bootstrapTokenSha).toBeDefined();
    expect(h.fake.running).toBe(true);
    expect(h.fake.destroyCount).toBe(0);
    expect(h.fake.snapshotCount).toBe(1);
    expect(ran(h, QUIESCE_SH)).toBe(0);
    expect(ran(h, SCRUB_SH)).toBe(1);
    expect(h.sim.aliveBoot).toBe(h.fake.bootId);
    expect(h.registry.slots.has("amp-T-test")).toBe(true);
    expect(h.registry.snapshots.map((s) => s.handle.id)).toEqual([r.handle!.id]);
    expect(await h.kv.get(ACTIVITY_KEY)).toBe("42");
    expect(h.lines.some((l) => /orb paused warm in .* amp kept running until/.test(l))).toBe(true);
  });

  it("ORB_SNAPSHOT_ID (project snapshot prep) pauses cold: quiesce, snapshot, destroy", async () => {
    const h = await awake();
    const r = await runPause(h.newOp(), { op: "pause", snapshotId: "snap-proj" });
    expect(r.ok).toBe(true);
    expect((await orb(h)).state).toBe("paused");
    expect(ran(h, QUIESCE_SH)).toBe(1);
    expect(h.fake.running).toBe(false);
    expect(h.registry.projects.get("snap-proj")?.handle.id).toBe(r.handle!.id);
  });

  it("warmMinutes 0 pauses cold, as before", async () => {
    const h = await awake({ warmMinutes: 0 });
    await runPause(h.newOp(), { op: "pause" });
    const rec = await orb(h);
    expect(rec.state).toBe("paused");
    expect(rec.warmUntil).toBeUndefined();
    expect(ran(h, QUIESCE_SH)).toBe(1);
    expect(h.fake.running).toBe(false);
    expect(h.registry.slots.size).toBe(0);
  });

  it("bootstrap not running → pauses cold", async () => {
    const h = await awake();
    h.sim.aliveBoot = undefined;
    await runPause(h.newOp(), { op: "pause" });
    expect((await orb(h)).state).toBe("paused");
    expect(h.fake.running).toBe(false);
    expect(h.lines).toContain("amp bootstrap is not running; pausing cold (snapshot and stop)");
  });

  it("a second pause while warm takes no second snapshot", async () => {
    const h = await warm();
    const first = (await orb(h)).handle!.id;
    const r = await runPause(h.newOp(), { op: "pause" });
    expect(r).toMatchObject({ ok: true, handle: { id: first } });
    expect(h.fake.snapshotCount).toBe(1);
    expect((await orb(h)).state).toBe("warm");
  });

  it("a pause while warm after Amp used the orb takes a new snapshot and restarts the warm period", async () => {
    const h = await warm();
    h.sim.use += 2;
    h.clock.advance(5 * MIN);
    const r = await runPause(h.newOp(), { op: "pause" });
    expect(r.ok).toBe(true);
    expect(h.fake.snapshotCount).toBe(2);
    const rec = await orb(h);
    expect(rec.state).toBe("warm");
    expect(rec.handle?.id).toBe(r.handle?.id);
    expect(rec.warmUntil).toBe(new Date(h.clock.now() + 10 * MIN).toISOString());
    expect(h.lines).toContain("Amp used the warm orb since the last pause; saving the disk again");
  });

  it("ORB_SNAPSHOT_ID while warm → cold pause with a new quiesced snapshot", async () => {
    const h = await warm();
    const r = await runPause(h.newOp(), { op: "pause", snapshotId: "snap-proj" });
    expect(r.ok).toBe(true);
    expect(h.fake.snapshotCount).toBe(2);
    const rec = await orb(h);
    expect(rec.state).toBe("paused");
    expect(rec.warmUntil).toBeUndefined();
    expect(h.fake.running).toBe(false);
  });

  it("snapshot failure → op fails, orb left awake (not warm)", async () => {
    const h = await awake();
    h.fake.snapshot = async () => {
      throw new Error("snapshot busy");
    };
    const r = await runPause(h.newOp(), { op: "pause" });
    expect(r.ok).toBe(false);
    const rec = await orb(h);
    expect(rec.state).toBe("awake");
    expect(rec.warmUntil).toBeUndefined();
  });
});

describe("spawn of a warm orb", () => {
  it("reuses the connected bootstrap: no restart, source warm, state awake", async () => {
    const h = await warm();
    const since = (await orb(h)).awakeSince;
    h.clock.advance(3 * MIN);
    const execs = h.fake.execLog.length;
    const r = await runSpawn(h.newOp(), spawnReq("tok-second-654321"));
    expect(r).toEqual({ ok: true, source: "warm", wakeMs: 0 });
    expect(h.sim.launches).toBe(1);
    expect(ran(h, BOOTSTRAP_SH)).toBe(1); // only the first spawn
    expect(h.fake.execLog.slice(execs).map((c) => c[2])).toEqual([RESUME_SH]);
    expect(h.fake.startCount).toBe(1);
    const rec = await orb(h);
    expect(rec.state).toBe("awake");
    expect(rec.warmUntil).toBeUndefined();
    expect(rec.awakeSince).toBe(since);
    expect(rec.lastWakeSource).toBe("warm");
    expect(rec.spawns?.at(-1)).toMatchObject({ source: "warm", ok: true });
    // The state file takes the new token sha, so a retry of this spawn does not restart amp.
    const sha = h.fake.disk[STATE_FILE]!.split(" ")[2];
    expect(rec.bootstrapTokenSha).toBe(sha);
    expect(await runSpawn(h.newOp(), spawnReq("tok-second-654321"))).toMatchObject({
      ok: true,
      source: "running",
    });
    expect(h.sim.launches).toBe(1);
    expect(h.lines.some((l) => /orb ready: amp kept running since the pause \(warm\)/.test(l))).toBe(true);
  });

  it("the new token never reaches the resume exec env", async () => {
    const h = await warm();
    let env: Record<string, string> | undefined;
    const orig = h.fake.handler;
    h.fake.handler = (cmd, opts, f) => {
      if (cmd[2] === RESUME_SH) env = opts.env;
      return orig(cmd, opts, f);
    };
    await runSpawn(h.newOp(), spawnReq("tok-secret-999999"));
    expect(env).toBeDefined();
    expect(env).not.toHaveProperty("ORB_TOKEN");
    expect(env!.ORB_TOKEN_SHA).toMatch(/^[0-9a-f]{16}$/);
  });

  it("resume gets the memory env and logs its thp and tmpfs lines", async () => {
    const h = await warm({ fastTmpfsGb: 2 });
    let env: Record<string, string> | undefined;
    const orig = h.fake.handler;
    h.fake.handler = (cmd, opts, f) => {
      if (cmd[2] !== RESUME_SH) return orig(cmd, opts, f);
      env = opts.env;
      const r = orig(cmd, opts, f);
      return typeof r === "string" ? `thp: always\ntmpfs: already mounted\n${r}` : r;
    };
    const lines0 = h.lines.length;
    expect(await runSpawn(h.newOp(), spawnReq("tok-second-654321"))).toMatchObject({
      ok: true,
      source: "warm",
    });
    expect(env).toMatchObject({ HUGE_PAGES: "1", FAST_TMPFS_GB: "2" });
    const said = h.lines.slice(lines0);
    expect(said).toContain("resume: thp: always");
    expect(said).toContain("resume: tmpfs: already mounted");
  });

  it("bootstrap died while warm → starts a new one with the new token", async () => {
    const h = await warm();
    h.sim.aliveBoot = undefined;
    const r = await runSpawn(h.newOp(), spawnReq("tok-second-654321"));
    expect(r).toMatchObject({ ok: true, source: "running" });
    expect(h.sim.launches).toBe(2);
    expect(h.sim.bootEnvs.at(-1)!.ORB_TOKEN).toBe("tok-second-654321");
    const rec = await orb(h);
    expect(rec.state).toBe("awake");
    expect(rec.warmUntil).toBeUndefined();
    expect(h.lines.some((l) => /^warm orb: bootstrap pid \d+ exited; starting amp again$/.test(l))).toBe(
      true,
    );
  });

  it("a restore starts the amp binary prefetch right after ready", async () => {
    const h = makeOrbCtx({ config: { warmMinutes: 0 } });
    await runSpawn(h.newOp(), spawnReq());
    await runPause(h.newOp(), { op: "pause" });
    h.fake.execLog = [];
    await runSpawn(h.newOp(), spawnReq("tok-second-654321"));
    const i = h.fake.execLog.indexOf(PREFETCH_CMD);
    expect(i).toBeGreaterThan(0);
    expect(h.fake.execLog.findIndex((c) => c[2] === BOOTSTRAP_SH)).toBeGreaterThan(i);
  });
});

describe("alarm while warm", () => {
  it("Amp uses the warm orb without a spawn → awake again; no stop at warmUntil", async () => {
    const h = await warm();
    h.clock.advance(9.5 * MIN);
    h.sim.use += 2; // a new message reached the still-connected executor
    expect(await runAlarm(h.newOp())).toEqual({ rearmInMs: 60_000 });
    let rec = await orb(h);
    expect(rec.state).toBe("awake");
    expect(rec.warmUntil).toBeUndefined();
    expect(rec.lastWakeSource).toBe("warm");
    expect(rec.dirtySince).toBeDefined();
    h.clock.advance(5 * MIN);
    await runAlarm(h.newOp());
    rec = await orb(h);
    expect(rec.state).toBe("awake");
    expect(h.fake.running).toBe(true);
    // Amp pauses again later: warm again, with a new snapshot.
    expect(await runPause(h.newOp(), { op: "pause" })).toMatchObject({ ok: true });
    expect((await orb(h)).state).toBe("warm");
    expect(h.fake.snapshotCount).toBe(2);
  });

  it("a new message in the last minute wins over the expiry", async () => {
    const h = await warm();
    h.clock.advance(10 * MIN);
    h.sim.use += 1;
    await runAlarm(h.newOp());
    expect((await orb(h)).state).toBe("awake");
    expect(h.fake.running).toBe(true);
  });

  it("before warmUntil: keep-alive and heartbeat, re-arm no later than warmUntil", async () => {
    const h = await warm();
    h.clock.advance(9.5 * MIN);
    h.registry.calls = [];
    expect(await runAlarm(h.newOp())).toEqual({ rearmInMs: 30_000 });
    expect(h.registry.calls).toContain("heartbeat amp-T-test");
    expect((await orb(h)).state).toBe("warm");
    expect(h.fake.running).toBe(true);
  });

  it("at warmUntil with a clean disk: destroy, paused, slot released, no new snapshot", async () => {
    const h = await warm();
    h.clock.advance(10 * MIN);
    const r = await runAlarm(h.newOp());
    const rec = await orb(h);
    expect(rec.state).toBe("paused");
    expect(rec.lastStop?.reason).toBe("warm for 10 min with no new message");
    expect(rec.warmUntil).toBeUndefined();
    expect(rec.awakeSince).toBeUndefined();
    expect(h.fake.running).toBe(false);
    expect(h.fake.snapshotCount).toBe(1);
    expect(h.registry.slots.size).toBe(0);
    expect(r.rearmInMs).toBe(handleExpiresAt(rec.handle as Handle) + DAY - h.clock.now());
  });

  it("log growth alone while warm does not take a second snapshot", async () => {
    const h = await warm();
    h.clock.advance(MIN);
    h.sim.activity += 100;
    await runAlarm(h.newOp());
    h.clock.advance(9 * MIN);
    await runAlarm(h.newOp());
    expect((await orb(h)).state).toBe("paused");
    expect(h.fake.snapshotCount).toBe(1);
    expect(ran(h, QUIESCE_SH)).toBe(0);
  });

  it("no handle at the end of warm → cold pause; a failed snapshot keeps it warm and retries", async () => {
    const h = await warm();
    const rec0 = await orb(h);
    rec0.handle = undefined;
    await h.kv.put("orb", rec0);
    h.clock.advance(10 * MIN);
    const orig = h.fake.snapshot.bind(h.fake);
    h.fake.snapshot = async () => {
      throw new Error("snapshot busy");
    };
    await runAlarm(h.newOp());
    expect((await orb(h)).state).toBe("warm");
    expect(h.fake.running).toBe(true);
    h.fake.snapshot = orig;
    h.clock.advance(MIN);
    await runAlarm(h.newOp());
    expect((await orb(h)).state).toBe("paused");
    expect(ran(h, QUIESCE_SH)).toBe(2);
    expect(h.fake.running).toBe(false);
  });

  it("bootstrap stopped while warm → stop the orb", async () => {
    const h = await warm();
    h.sim.aliveBoot = undefined;
    h.clock.advance(MIN);
    await runAlarm(h.newOp());
    const rec = await orb(h);
    expect(rec.state).toBe("paused");
    expect(rec.lastStop?.reason).toBe("amp bootstrap stopped while warm");
    expect(h.fake.running).toBe(false);
  });

  it("maxAwakeHours applies while warm", async () => {
    const h = await warm({ maxAwakeHours: 1 });
    h.clock.advance(9 * MIN);
    // awakeSince is from the first spawn; push it back past the cap
    const rec0 = await orb(h);
    rec0.awakeSince = new Date(h.clock.now() - 2 * 3600_000).toISOString();
    await h.kv.put("orb", rec0);
    await runAlarm(h.newOp());
    const rec = await orb(h);
    expect(rec.state).toBe("paused");
    expect(rec.lastStop?.reason).toBe("awake longer than maxAwakeHours (1 h)");
  });

  it("container stopped while warm → paused (disk was saved), not lost", async () => {
    const h = await warm();
    h.fake.platformStop();
    const r = await runAlarm(h.newOp());
    const rec = await orb(h);
    expect(rec.state).toBe("paused");
    expect(rec.lastStop?.reason).toBe("container stopped while warm");
    expect(h.registry.slots.size).toBe(0);
    expect(r.rearmInMs).toBeGreaterThan(0);
  });

  it("pause while warm and the container stopped → paused, not paused-stale", async () => {
    const h = await warm();
    h.fake.platformStop();
    expect(await runPause(h.newOp(), { op: "pause" })).toEqual({ ok: true });
    expect((await orb(h)).state).toBe("paused");
  });

  it("delete while warm destroys the container", async () => {
    const h = await warm();
    await runDelete(h.newOp());
    const rec = await orb(h);
    expect(rec.state).toBe("deleted");
    expect(h.fake.running).toBe(false);
    expect(h.registry.slots.size).toBe(0);
  });
});
