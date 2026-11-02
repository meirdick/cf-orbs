import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/types";
import {
  BENCH_ORB_RE,
  benchDestroy,
  benchSnapshot,
  benchSnapshotName,
  benchStart,
  parseBenchStart,
} from "../src/orb/bench";
import { FakeClock, FakeContainer } from "./fake-container";

function deps() {
  const clock = new FakeClock();
  const container = new FakeContainer(clock);
  return { clock, container, d: { container, clock, config: DEFAULT_CONFIG, orbId: "bench-r1-1" } };
}

describe("bench ops", () => {
  it("start from image: ready time comes from the readiness race", async () => {
    const { container, d } = deps();
    container.readyAfterMs = 2500;
    const r = await benchStart(d, { source: "image" });
    expect(r).toMatchObject({ ready: true, source: "image", instance: DEFAULT_CONFIG.instance });
    expect(r.readyMs).toBeGreaterThanOrEqual(2500);
    expect(r.readyMs).toBeLessThan(4000);
    expect(container.startedWith?.labels).toMatchObject({ orb: "bench-r1-1", bench: "1" });
    expect(container.inactivityTimeoutMs).toBe(10 * 60_000);
  });

  it("snapshot → destroy → restore keeps the disk; instance override is used", async () => {
    const { container, d } = deps();
    await benchStart(d, { source: "image" });
    container.disk["/home/user/bench.bin"] = "x".repeat(10);
    const s = await benchSnapshot(d, "bench-r1-1-a");
    expect(s.id).toBeTruthy();
    expect(s.size).toBeGreaterThan(0);
    expect(container.execLog.at(-1)).toEqual(["sync"]);
    expect((await benchDestroy(d)).wasRunning).toBe(true);
    expect(container.running).toBe(false);
    const r = await benchStart(d, { source: { snapshotId: s.id! }, instance: "standard-4" });
    expect(r).toMatchObject({ ready: true, source: "snapshot", instance: "standard-4" });
    expect(container.disk["/home/user/bench.bin"]).toBe("x".repeat(10));
  });

  it("missing snapshot → not ready, monitor error, nothing left running", async () => {
    const { container, d } = deps();
    const r = await benchStart(d, { source: { snapshotId: "nope" } });
    expect(r.ready).toBe(false);
    expect(r.error).toMatch(/was not found/);
    expect(container.running).toBe(false);
  });

  it("refuses a second start and a snapshot of a stopped container", async () => {
    const { d } = deps();
    expect((await benchSnapshot(d, "x")).error).toBe("container not running");
    await benchStart(d, { source: "image" });
    const r = await benchStart(d, { source: "image" });
    expect(r.ready).toBe(false);
    expect(r.error).toMatch(/already running/);
    expect(await benchDestroy(d)).toMatchObject({ wasRunning: true });
    expect(await benchDestroy(d)).toMatchObject({ wasRunning: false });
  });

  it("parses bodies and names", () => {
    expect(parseBenchStart({ source: "image" })).toEqual({ source: "image" });
    expect(parseBenchStart({ source: { snapshotId: "abc-1" } })).toEqual({ source: { snapshotId: "abc-1" } });
    expect(parseBenchStart({ source: "disk" })).toMatch(/source must be/);
    expect(parseBenchStart({ source: { snapshotId: "a b" } })).toMatch(/source must be/);
    expect(parseBenchStart({ source: "image", instance: "lite" })).toMatch(/too small/);
    expect(
      parseBenchStart({ source: "image", instance: { vcpu: 4, memoryMib: 12288, diskMb: 20000 } }),
    ).toEqual({ source: "image", instance: { vcpu: 4, memoryMib: 12288, diskMb: 20000 } });
    expect(benchSnapshotName("bench-a", "my snap/1", 5)).toBe("my-snap-1");
    expect(benchSnapshotName("bench-a", undefined, 5)).toBe("bench-a-5");
    expect(BENCH_ORB_RE.test("bench-20261030-1")).toBe(true);
    expect(BENCH_ORB_RE.test("amp-T-1")).toBe(false);
  });
});
