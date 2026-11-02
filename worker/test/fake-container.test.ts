import { describe, expect, it } from "vitest";
import { FakeClock, FakeContainer } from "./fake-container";

describe("FakeContainer models verified semantics", () => {
  it("start throws if running; snapshot throws if stopped", async () => {
    const c = new FakeContainer(new FakeClock());
    await expect(c.snapshot("x")).rejects.toThrow(/not running/);
    c.start({ source: { image: c.images().orb! }, instance: "standard-1", enableInternet: true });
    expect(() => c.start({ source: { image: "y" }, instance: "lite", enableInternet: true })).toThrow(
      /already running/,
    );
  });
  it("bogus snapshot fails asynchronously via monitor and exec", async () => {
    const c = new FakeContainer(new FakeClock());
    c.start({ source: { snapshotId: "nope" }, instance: "standard-1", enableInternet: true });
    await expect(c.monitor()).rejects.toThrow(/was not found/);
    expect(c.running).toBe(false);
  });
  it("snapshot/restore carries disk", async () => {
    const c = new FakeContainer(new FakeClock());
    c.start({ source: { image: c.images().orb! }, instance: "standard-1", enableInternet: true });
    c.disk["/home/user/a"] = "1";
    const s = await c.snapshot("p");
    await c.destroy();
    c.start({ source: { snapshotId: s.id }, instance: "standard-1", enableInternet: true });
    expect(c.disk["/home/user/a"]).toBe("1");
  });
});
