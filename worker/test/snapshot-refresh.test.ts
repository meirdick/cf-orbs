// projectSnapshotRefresh ("on-change"): detect a stale project snapshot after a restore, mark it, forget it.
import { beforeEach, describe, expect, it } from "vitest";
import { projectKeyOf, RegistryCore } from "../src/core/registry-core";
import {
  DEFAULT_CONFIG,
  type OpRequest,
  type ProjectSnapshotMapping,
  type SnapshotHandle,
  STALE_FORGET_INTERVAL_MS,
} from "../src/core/types";
import { runPause } from "../src/orb/pause";
import { WAIT_CONNECTED_SH } from "../src/orb/scripts";
import { parseAmpCheck, runSpawn, shortImage, staleReason } from "../src/orb/spawn";
import { FakeClock, MemoryKV } from "./fake-container";
import { CopyingKV, makeOrbCtx, type OrbHarness } from "./fake-registry";

const TOKEN = "eyJhbGciOi.test.sig";
const spawnReq = (o: Partial<OpRequest> = {}): OpRequest => ({ op: "spawn", token: TOKEN, ...o });
const H = 3600_000;
const iso = (t: number) => new Date(t).toISOString();
const SID = "snap-f3851194-aaaa-bbbb-cccc-0123456789ab-5479269c";
const OLD_IMG = "registry.cloudflare.com/acct/cf-orbs-orb@sha256:0123456789abcdef0000";
const NEW_IMG = "registry.cloudflare.com/acct/cf-orbs-orb@sha256:fedcba9876543210ffff";

describe("parseAmpCheck (amp_check line from WAIT_CONNECTED_SH)", () => {
  it("reads an update", () => {
    const out = "connected after 3s\namp: updated 0.0.1793387810-g5421c2 -> 0.0.1793400000-gabcdef\n";
    expect(parseAmpCheck(out)).toEqual({
      kind: "updated",
      from: "0.0.1793387810-g5421c2",
      to: "0.0.1793400000-gabcdef",
    });
  });
  it("reads a current version, and an unknown old version", () => {
    expect(parseAmpCheck("connected after 0s\namp: current 0.0.1")).toEqual({
      kind: "current",
      version: "0.0.1",
    });
    expect(parseAmpCheck("amp: updated unknown -> 0.0.2")).toEqual({
      kind: "updated",
      from: "unknown",
      to: "0.0.2",
    });
  });
  it("ignores output without the line or with a malformed one", () => {
    expect(parseAmpCheck("connected after 3s")).toBeUndefined();
    expect(parseAmpCheck("amp: updated 0.0.1")).toBeUndefined();
    expect(parseAmpCheck("log: amp: current 0.0.1")).toBeUndefined();
  });
});

describe("staleReason (mapping compare)", () => {
  it("amp self-update makes the snapshot stale", () => {
    expect(staleReason({}, { kind: "updated", from: "1", to: "2" }, undefined)).toBe("amp updated 1 -> 2");
  });
  it("a different image digest makes it stale", () => {
    expect(staleReason({ imageRef: OLD_IMG }, { kind: "current", version: "1" }, NEW_IMG)).toBe(
      "image changed sha256:0123456789ab -> sha256:fedcba987654",
    );
  });
  it("both reasons are joined", () => {
    expect(staleReason({ imageRef: OLD_IMG }, { kind: "updated", from: "1", to: "2" }, NEW_IMG)).toBe(
      "amp updated 1 -> 2; image changed sha256:0123456789ab -> sha256:fedcba987654",
    );
  });
  it("same image, current amp, no imageRef (older mapping) or no current image: not stale", () => {
    expect(staleReason({ imageRef: OLD_IMG }, { kind: "current", version: "1" }, OLD_IMG)).toBeUndefined();
    expect(staleReason({}, { kind: "current", version: "1" }, NEW_IMG)).toBeUndefined();
    expect(staleReason({ imageRef: OLD_IMG }, undefined, undefined)).toBeUndefined();
  });
  it("shortImage keeps 12 hex of a digest, else the last path part", () => {
    expect(shortImage(OLD_IMG)).toBe("sha256:0123456789ab");
    expect(shortImage("registry.cloudflare.com/acct/cf-orbs-orb:wrangler-abc")).toBe(
      "cf-orbs-orb:wrangler-abc",
    );
  });
});

function handle(id: string, createdAt: string): SnapshotHandle {
  return { id, size: 1, imageKey: "orb", instance: DEFAULT_CONFIG.instance, createdAt };
}
function mapping(snapshotId: string, at: string, extra: Partial<ProjectSnapshotMapping> = {}) {
  return {
    snapshotId,
    handle: handle(`cf-${snapshotId}`, at),
    sourceOrbId: "amp-T-1",
    createdAt: at,
    lastUsedAt: at,
    ...extra,
  };
}

describe("RegistryCore markProjectSnapshotStale (forget path and rate limit)", () => {
  let kv: MemoryKV;
  let clock: FakeClock;
  let reg: RegistryCore;
  const now = () => iso(clock.now());
  beforeEach(() => {
    kv = new MemoryKV();
    clock = new FakeClock();
    reg = new RegistryCore(kv, clock, { maxRunning: 20, alarmSeconds: 60 });
  });

  it("projectKeyOf takes the project part of snap-<project>-<hash>", () => {
    expect(projectKeyOf(SID)).toBe("f3851194-aaaa-bbbb-cccc-0123456789ab");
    expect(projectKeyOf("custom-id")).toBe("custom-id");
  });

  it("forgets the mapping: spawn no longer sees it, status shows it stale, the index keeps the data", async () => {
    await reg.putProjectSnapshot(mapping(SID, now(), { ampVersion: "0.0.1", imageRef: OLD_IMG }));
    const r = await reg.markProjectSnapshotStale(SID, "amp updated 0.0.1 -> 0.0.2", now());
    expect(r.forgotten).toBe(true);
    expect(await reg.getProjectSnapshot(SID)).toBeUndefined();
    expect(await reg.projectSnapshotStale(SID)).toEqual({
      reason: "amp updated 0.0.1 -> 0.0.2",
      at: now(),
      forgotten: true,
    });
    const s = await reg.summary();
    expect(s.projectSnapshots).toBe(0);
    expect(s.projects).toEqual([
      {
        snapshotId: SID,
        createdAt: now(),
        lastUsedAt: now(),
        ampVersion: "0.0.1",
        imageRef: OLD_IMG,
        stale: { reason: "amp updated 0.0.1 -> 0.0.2", at: now(), forgotten: true },
        expired: false,
      },
    ]);
    expect((await reg.listSnapshots()).map((x) => x.handle.id)).toEqual([`cf-${SID}`]);
    // a second mark is a no-op
    expect(await reg.markProjectSnapshotStale(SID, "again", now())).toMatchObject({ forgotten: false });
    expect(await reg.markProjectSnapshotStale("snap-none-00aa11bb", "x", now())).toMatchObject({
      forgotten: false,
      note: expect.stringMatching(/no mapping/),
    });
  });

  it("a new pause with the same id (Amp re-saves) writes a fresh mapping without the stale mark", async () => {
    await reg.putProjectSnapshot(mapping(SID, now()));
    await reg.markProjectSnapshotStale(SID, "amp updated 1 -> 2", now());
    clock.advance(H);
    await reg.putProjectSnapshot(mapping(SID, now(), { ampVersion: "2" }));
    expect(await reg.getProjectSnapshot(SID)).toMatchObject({ ampVersion: "2" });
    expect(await reg.projectSnapshotStale(SID)).toBeUndefined();
  });

  it("at most one forget per project per 24 h; after that the next detection forgets", async () => {
    await reg.putProjectSnapshot(mapping(SID, now()));
    expect((await reg.markProjectSnapshotStale(SID, "amp updated 1 -> 2", now())).forgotten).toBe(true);
    const firstAt = now();
    // Amp re-saves; amp updates again 2 h later
    clock.advance(2 * H);
    await reg.putProjectSnapshot(mapping(SID, now()));
    const r = await reg.markProjectSnapshotStale(SID, "amp updated 2 -> 3", now());
    expect(r.forgotten).toBe(false);
    expect(r.note).toMatch(new RegExp(`kept: this project had a forget at ${firstAt}`));
    expect(await reg.getProjectSnapshot(SID)).toBeDefined(); // still used by spawn
    expect(await reg.projectSnapshotStale(SID)).toMatchObject({ forgotten: false, at: now() });
    // another id of the same project is limited too
    const other = "snap-f3851194-aaaa-bbbb-cccc-0123456789ab-77777777";
    await reg.putProjectSnapshot(mapping(other, now()));
    expect((await reg.markProjectSnapshotStale(other, "x", now())).forgotten).toBe(false);
    // a different project is not
    const p2 = "snap-11111111-2222-3333-4444-555555555555-0badf00d";
    await reg.putProjectSnapshot(mapping(p2, now()));
    expect((await reg.markProjectSnapshotStale(p2, "x", now())).forgotten).toBe(true);
    // 24 h after the first forget: allowed again; the first detection time is kept
    const keptAt = (await reg.projectSnapshotStale(SID))?.at;
    clock.t = Date.parse(firstAt) + STALE_FORGET_INTERVAL_MS;
    const r2 = await reg.markProjectSnapshotStale(SID, "amp updated 2 -> 3", now());
    expect(r2.forgotten).toBe(true);
    expect(await reg.projectSnapshotStale(SID)).toMatchObject({ forgotten: true, at: keptAt });
  });

  it("GC drops rate-limit records older than 24 h", async () => {
    await reg.putProjectSnapshot(mapping(SID, now()));
    await reg.markProjectSnapshotStale(SID, "x", now());
    expect((await kv.list("refresh:")).size).toBe(1);
    await reg.gc(iso(clock.now() + STALE_FORGET_INTERVAL_MS - 1));
    expect((await kv.list("refresh:")).size).toBe(1);
    await reg.gc(iso(clock.now() + STALE_FORGET_INTERVAL_MS));
    expect((await kv.list("refresh:")).size).toBe(0);
  });
});

/** Orb A: spawn from the image, then the Amp project pause. Leaves the mapping in h.registry. */
async function projectPause(h: OrbHarness, ampVersion = "0.0.1") {
  h.sim.ampVersion = ampVersion;
  expect(await runSpawn(h.newOp(), spawnReq())).toMatchObject({ ok: true, source: "image" });
  h.fake.disk["/home/user/repo/setup-done"] = "yes";
  expect(await runPause(h.newOp(), { op: "pause", snapshotId: SID })).toMatchObject({ ok: true });
}

/** Env of every WAIT_CONNECTED_SH exec from now on. */
function waitEnvs(h: OrbHarness): Record<string, string>[] {
  const envs: Record<string, string>[] = [];
  const inner = h.fake.handler;
  h.fake.handler = (cmd, opts, fake) => {
    if (cmd[2] === WAIT_CONNECTED_SH) envs.push({ ...(opts.env ?? {}) });
    return inner(cmd, opts, fake);
  };
  return envs;
}

/** Make the next op run as a new thread's orb (new OrbSession storage) on the same container fake. */
function newThread(h: OrbHarness, orbId: string) {
  h.ctx.orbId = orbId;
  h.ctx.kv = new CopyingKV();
  h.lines.length = 0;
}

describe("spawn with projectSnapshotRefresh", () => {
  it("a project pause records the amp version and the image ref in the mapping", async () => {
    const h = makeOrbCtx();
    await projectPause(h, "0.0.1793387810-g5421c2");
    expect(h.registry.projects.get(SID)).toMatchObject({
      ampVersion: "0.0.1793387810-g5421c2",
      imageRef: h.fake.images().orb,
    });
    expect(h.lines).toContain("amp version 0.0.1793387810-g5421c2");
  });

  it("off (default): no amp check, a self-update keeps the mapping", async () => {
    const h = makeOrbCtx();
    await projectPause(h);
    newThread(h, "amp-T-2");
    h.sim.ampCheckLine = "amp: updated 0.0.1 -> 0.0.2";
    const envs = waitEnvs(h);
    const r = await runSpawn(h.newOp(), spawnReq({ snapshotId: SID }));
    expect(r).toMatchObject({ ok: true, source: "project-snapshot" });
    expect(envs.length).toBeGreaterThan(0);
    expect(envs.some((e) => "AMP_CHECK" in e)).toBe(false);
    expect(h.registry.calls).not.toContain(`stale ${SID}`);
    expect(h.registry.projects.get(SID)?.stale).toBeUndefined();
  });

  it("on-change: amp self-update after the restore forgets the mapping; the next thread boots the image", async () => {
    const h = makeOrbCtx({ config: { projectSnapshotRefresh: "on-change" } });
    await projectPause(h);
    newThread(h, "amp-T-2");
    h.sim.ampCheckLine = "amp: updated 0.0.1 -> 0.0.2";
    const envs = waitEnvs(h);
    const r = await runSpawn(h.newOp(), spawnReq({ snapshotId: SID }));
    expect(r).toMatchObject({ ok: true, source: "project-snapshot" }); // this thread keeps its disk
    expect(envs.at(-1)).toMatchObject({ AMP_CHECK: "1" });
    expect(h.registry.projects.get(SID)?.stale).toMatchObject({
      reason: "amp updated 0.0.1 -> 0.0.2",
      forgotten: true,
    });
    expect(
      h.lines.some((l) =>
        new RegExp(
          `project snapshot ${SID} is stale \\(amp updated 0\\.0\\.1 -> 0\\.0\\.2\\): forgot .*delete the cached snapshot in Amp → Orb Settings → Snapshots`,
        ).test(l),
      ),
    ).toBe(true);

    // Thread 3: Amp still sends the id. FR6 case 3 needs a live mapping, so this is case 4: the image.
    await h.fake.destroy();
    newThread(h, "amp-T-3");
    const r3 = await runSpawn(h.newOp(), spawnReq({ snapshotId: SID }));
    expect(r3).toMatchObject({ ok: true, source: "image" });
    expect(
      h.lines.some((l) => /was forgotten as stale at .*booting the image \(Amp runs setup\)/.test(l)),
    ).toBe(true);

    // If Amp then pauses with the id again, the mapping is fresh and the next thread restores it.
    h.sim.ampVersion = "0.0.2";
    expect(await runPause(h.newOp(), { op: "pause", snapshotId: SID })).toMatchObject({ ok: true });
    expect(h.registry.projects.get(SID)).toMatchObject({ ampVersion: "0.0.2" });
    expect(h.registry.projects.get(SID)?.stale).toBeUndefined();
    newThread(h, "amp-T-4");
    h.sim.ampCheckLine = "amp: current 0.0.2";
    expect(await runSpawn(h.newOp(), spawnReq({ snapshotId: SID }))).toMatchObject({
      source: "project-snapshot",
    });
    expect(h.lines).toContain(`project snapshot ${SID}: up to date (amp 0.0.2, same image); kept`);
  });

  it("on-change: an image digest change since the pause forgets the mapping", async () => {
    const h = makeOrbCtx({ config: { projectSnapshotRefresh: "on-change" } });
    h.fake.start({
      source: { image: h.fake.images().orb as string },
      instance: "standard-1",
      enableInternet: true,
    });
    const snap = await h.fake.snapshot("proj");
    await h.fake.destroy();
    const at = iso(h.clock.now());
    await h.registry.putProjectSnapshot({
      ...mapping(SID, at),
      handle: { ...handle(snap.id, at), size: snap.size },
      imageRef: OLD_IMG,
    });
    h.sim.ampCheckLine = "amp: current 0.0.1";
    const r = await runSpawn(h.newOp(), spawnReq({ snapshotId: SID }));
    expect(r).toMatchObject({ ok: true, source: "project-snapshot" });
    expect(h.registry.projects.get(SID)?.stale).toMatchObject({
      reason: "image changed sha256:0123456789ab -> sha256:deadbeef",
      forgotten: true,
    });
  });

  it("on-change: the rate limit keeps the mapping and says so; a Registry error is not fatal", async () => {
    const h = makeOrbCtx({ config: { projectSnapshotRefresh: "on-change" } });
    await projectPause(h);
    h.registry.forgets.set(projectKeyOf(SID), iso(h.clock.now() - H));
    newThread(h, "amp-T-2");
    h.sim.ampCheckLine = "amp: updated 0.0.1 -> 0.0.2";
    expect(await runSpawn(h.newOp(), spawnReq({ snapshotId: SID }))).toMatchObject({ ok: true });
    expect(h.registry.projects.get(SID)?.stale).toMatchObject({ forgotten: false });
    expect(
      h.lines.some((l) => /is stale \(amp updated .*\): kept: this project had a forget at/.test(l)),
    ).toBe(true);

    await h.fake.destroy();
    newThread(h, "amp-T-3");
    h.registry.markProjectSnapshotStale = async () => {
      throw new Error("registry overloaded");
    };
    expect(await runSpawn(h.newOp(), spawnReq({ snapshotId: SID }))).toMatchObject({
      ok: true,
      source: "project-snapshot",
    });
    expect(h.lines.some((l) => /mark failed \(not fatal\): registry overloaded/.test(l))).toBe(true);
  });

  it("on-change: a per-orb wake or an image boot runs no check", async () => {
    const h = makeOrbCtx({ config: { projectSnapshotRefresh: "on-change" } });
    h.sim.ampCheckLine = "amp: updated 0.0.1 -> 0.0.2";
    const envs = waitEnvs(h);
    await runSpawn(h.newOp(), spawnReq());
    await runPause(h.newOp(), { op: "pause" });
    await runSpawn(h.newOp(), spawnReq());
    expect(envs.length).toBe(2);
    expect(envs.some((e) => "AMP_CHECK" in e)).toBe(false);
    expect(h.registry.calls.some((c) => c.startsWith("stale "))).toBe(false);
  });
});
